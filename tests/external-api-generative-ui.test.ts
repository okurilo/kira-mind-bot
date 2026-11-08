import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Bot, InlineKeyboard } from 'grammy';
import { BotApiBackend } from '../api/backend';
import { ApiError, type ApiOperationStore, type ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { config } from '../config';
import type { BotContext, SessionData } from '../types';
import * as history from '../utils/history';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import * as orchestrator from '../orchestrator';
import * as completion from '../ai/chatCompletion';
import { UI_CATALOG_ID } from '../generative-ui/contracts';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { parsePhotoTurn } from '../api/photos';

const ui = { enabled: true as const, catalogId: UI_CATALOG_ID };
const owner = 730001, token = 'synthetic-ui-token-with-at-least-32-characters';
const options = { token, ownerId: owner, host: '127.0.0.1', port: 0 };
const answer = 'План: чтение 20 минут, прогулка 30 минут.';
function draft(action: unknown = { type: 'reply', text: 'Замени чтение на рисование' }) {
    return { components: [{ id: 'root', component: 'Column', children: ['plan', 'button'] },
        { id: 'plan', component: 'Table', columns: ['Занятие', 'Минуты'], rows: [['Чтение', '20'], ['Прогулка', '30']] },
        { id: 'button', component: 'Button', child: 'label', action }, { id: 'label', component: 'Text', text: 'Изменить план' }] };
}
function fixture(t: TestContext) {
    let saved: SessionData | undefined;
    const oldOwner = config.allowedUserId; config.allowedUserId = owner;
    t.after(() => { config.allowedUserId = oldOwner; });
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async () => saved ? structuredClone(saved) : undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (_key: string, value: SessionData) => { saved = structuredClone(value); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: {
        id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
    } as any });
    bot.api.config.use(async () => { assert.fail('UI cannot send Telegram traffic'); });
    const backend = new BotApiBackend(bot, options, { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) } as any);
    return { backend, saved: () => saved! };
}
class Receipts implements ApiOperationStore {
    rows = new Map<string, { fingerprint: string; result: ApiReply }>();
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>) {
        const old = this.rows.get(key);
        if (old) {
            if (old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Conflict');
            return structuredClone(old.result);
        }
        const result = await work(); this.rows.set(key, { fingerprint, result: structuredClone(result) }); return result;
    }
}
async function http(t: TestContext, backend: BotApiBackend) {
    const server = createExternalApiServer(options, backend, new Receipts());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    return (path: string, body: unknown, key = 'synthetic-ui-key-001', extra: Record<string, string> = {}) => fetch(base + path, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key, ...extra }, body: JSON.stringify(body),
    });
}

test('HTTP → canonical text handler → UI → signed quick reply → next handler, with durable replay and history', async t => {
    const f = fixture(t), requests: string[] = [];
    t.mock.method(orchestrator, 'processMessage', async (ctx: BotContext, text: string) => {
        requests.push(text); assert.equal(ctx.from!.id, owner); assert.equal(ctx.sessionStorageKey, `api:${owner}`);
        assert.equal(ctx.allowDeferredDialogue, false);
        assert.equal((ctx as any).allowExternalDelivery, undefined);
        return { responseText: answer, skipOptionalFollowups: true };
    });
    let uiCalls = 0;
    t.mock.method(completion, 'createChatCompletionForTask', async (task: string, params: any) => {
        uiCalls++; assert.equal(task, 'conversation'); assert.equal(await getActiveAiPresetName(), 'gpt-lean');
        assert.equal(JSON.parse(params.messages[1].content).answer, answer);
        return { choices: [{ message: { content: JSON.stringify(draft()) } }] } as any;
    });
    const post = await http(t, f.backend), body = { text: 'Составь план на вечер', ui };
    const first = await post('/messages', body, 'synthetic-ui-key-001', { Prefer: 'respond-async' });
    assert.equal(first.status, 200); assert.equal(first.headers.get('preference-applied'), null);
    const reply: ApiReply = await first.json() as any, message = reply.messages.find(item => item.text === answer)!;
    assert.ok(message.ui); assert.equal(message.text, answer);
    const button = message.ui!.messages[0].createSurface.components.find(item => item.component === 'Button') as any;
    const actionToken = button.action.event.context.actionToken;
    const replay = await post('/messages', body, 'synthetic-ui-key-001', { Prefer: 'respond-async' });
    assert.deepEqual(await replay.json(), reply); assert.equal(requests.length, 1); assert.equal(uiCalls, 1);
    assert.equal((await post('/messages', { text: body.text }, 'synthetic-ui-key-001', { Prefer: 'respond-async' })).status, 409);
    const restored = new BotApiBackend(new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: {
        id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
    } as any }), options);
    const past = (await restored.history(20)).messages.find(item => item.text === answer)!;
    assert.deepEqual(past.ui, message.ui); assert.equal(past.id, message.id);
    assert.equal(f.saved().messageHistory.filter(item => item.ui).length, 1);
    assert.ok(f.saved().messageHistory.every(item => !item.content.includes('createSurface')));
    const clicked = await post('/actions', { actionToken, ui }, 'synthetic-ui-action-001');
    assert.equal(clicked.status, 200); assert.equal(requests[1], 'Замени чтение на рисование');
    assert.equal(uiCalls, 2);
    assert.deepEqual(await (await post('/actions', { actionToken, ui }, 'synthetic-ui-action-002')).json(), await clicked.json());
    assert.equal(requests.length, 2); assert.equal(uiCalls, 2);
    await assert.rejects(f.backend.action(actionToken), (error: any) => error.code === 'action_expired');
    await assert.rejects(f.backend.action(actionToken + 'x'), (error: any) => error.code === 'invalid_action');
});

test('UI never becomes a persistent permission; disabled, malformed and failed visual generation preserve plain answers', async t => {
    const f = fixture(t);
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: answer, skipOptionalFollowups: true }));
    let calls = 0;
    t.mock.method(completion, 'createChatCompletionForTask', async () => {
        calls++; if (calls === 2) throw Error('synthetic provider refusal');
        return { choices: [{ message: { content: calls === 1 ? JSON.stringify(draft()) : 'invalid json' } }] } as any;
    });
    assert.ok((await f.backend.message('План', { ui })).messages[0].ui);
    assert.equal((await f.backend.message('Другая реплика')).messages[0].ui, undefined); assert.equal(calls, 1);
    for (let i = 0; i < 2; i++) {
        const reply = await f.backend.message('Повтори план', { ui });
        assert.equal(reply.messages[0].text, answer); assert.equal(reply.messages[0].ui, undefined);
    }
    const post = await http(t, f.backend);
    for (const ui of [true, { enabled: true }, { enabled: true, catalogId: 'urn:untrusted' }, { enabled: false, extra: 1 }]) {
        assert.equal((await post('/messages', { text: 'Вопрос', ui })).status, 400);
    }
    assert.equal((await post('/messages', { text: 'Вопрос', ui: { enabled: false } })).status, 200);
    assert.equal(calls, 3);
});

test('a generated action can only reuse the transport-issued domain button and photo turns can opt in too', async t => {
    const f = fixture(t);
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: answer,
        keyboard: new InlineKeyboard().text('Дневник', 'health:log:food'), skipOptionalFollowups: true }));
    const generate = t.mock.method(completion, 'createChatCompletionForTask', async (_task: string, params: any) => {
        const input = JSON.parse(params.messages[1].content);
        assert.deepEqual(input.existingActions, [{ index: 0, label: 'Дневник' }]);
        assert.ok(!params.messages[1].content.includes('actionToken'));
        return { choices: [{ message: { content: JSON.stringify(draft({ type: 'existing', index: 0 })) } }] } as any;
    });
    const reply = await f.backend.message('Покажи план', { ui });
    const message = reply.messages[0], button = message.ui!.messages[0].createSurface.components.find(item => item.component === 'Button') as any;
    assert.equal(button.action.event.name, 'kira.action');
    assert.equal(button.action.event.context.actionToken, message.buttons![0][0].actionToken);
    generate.mock.restore();
    await f.backend.action(button.action.event.context.actionToken);
    assert.equal(f.saved().pendingHealthLog?.mode, 'food');
    t.mock.method(orchestrator, 'processImage', async () => ({ responseText: answer }));
    t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: JSON.stringify(draft()) } }] }) as any);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const parsed = parsePhotoTurn({ photo: { mime: 'image/jpeg', data: jpeg.toString('base64'), width: 16, height: 16 }, ui });
    assert.deepEqual(parsed.ui, ui);
    const photo = await f.backend.photo(parsed.photo.data, 'Составь план', 'gpt-lean', parsed.ui);
    assert.ok(photo.messages.some(item => item.ui));
    assert.ok(!JSON.stringify(f.saved()).includes(jpeg.toString('base64')));
});

test('repeated text binds UI to its new message, and retained presentation snapshots stay bounded', async t => {
    const f = fixture(t);
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: answer, skipOptionalFollowups: true }));
    t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: JSON.stringify(draft()) } }] }) as any);
    await f.backend.message('Первый план');
    // Some command/callback handlers deliver text without adding their own bot history entry.
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        if (role === 'user') ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    const current = (await f.backend.message('Покажи тот же план', { ui })).messages[0];
    const copies = f.saved().messageHistory.filter(item => item.role === 'bot' && item.content === answer);
    assert.equal(copies.length, 2); assert.equal(copies[1].ui, undefined);
    assert.deepEqual(copies[0].ui, current.ui); assert.equal(copies[0].apiMessageId, current.id);
    for (let i = 0; i < 21; i++) await f.backend.message(`Ещё план ${i}`, { ui });
    assert.equal(f.saved().messageHistory.filter(item => item.ui).length, 20);
    assert.ok(f.saved().messageHistory.filter(item => item.role === 'bot').length > 20);
});
