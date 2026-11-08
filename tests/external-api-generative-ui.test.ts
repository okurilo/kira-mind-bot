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
import { UI_CATALOG_ID, UI_CATALOG_V2 } from '../generative-ui/contracts';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { parsePhotoTurn } from '../api/photos';
import { UiService } from '../generative-ui/service';
import { MemoryUiStore } from './helpers/generativeUi';
import { McpService, mcpService } from '../services/mcp/client';
import * as mcpConfig from '../services/mcp/config';

const ui = { enabled: true as const, catalogId: UI_CATALOG_ID };
const owner = 730001, token = 'synthetic-ui-token-with-at-least-32-characters';
const options = { token, ownerId: owner, host: '127.0.0.1', port: 0 };
const answer = 'План: чтение 20 минут, прогулка 30 минут.';
function draft(action: unknown = { type: 'reply', text: 'Замени чтение на рисование' }) {
    return { components: [{ id: 'root', component: 'Column', children: ['plan', 'button'] },
        { id: 'plan', component: 'Table', columns: ['Занятие', 'Минуты'], rows: [['Чтение', '20'], ['Прогулка', '30']] },
        { id: 'button', component: 'Button', child: 'label', action }, { id: 'label', component: 'Text', text: 'Изменить план' }] };
}
function fixture(t: TestContext, refreshDependencies: Partial<import('../generative-ui/refresh').RefreshDependencies> = {}) {
    let saved: SessionData | undefined;
    let writes = 0;
    const oldOwner = config.allowedUserId; config.allowedUserId = owner;
    t.after(() => { config.allowedUserId = oldOwner; });
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async () => saved ? structuredClone(saved) : undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (_key: string, value: SessionData) => { writes++; saved = structuredClone(value); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: {
        id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
    } as any });
    bot.api.config.use(async () => { assert.fail('UI cannot send Telegram traffic'); });
    let time = Date.now();
    const widgets = new UiService(owner, new MemoryUiStore(), () => time, refreshDependencies);
    const backend = new BotApiBackend(bot, options, { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) } as any, undefined, widgets);
    return { backend, widgets, advance: () => { time += 60_000; }, saved: () => saved!, writes: () => writes };
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
    runJson<T>(key: string, fingerprint: string, work: () => Promise<T>): Promise<T> { return this.run(key, fingerprint, work as any) as Promise<T>; }
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

test('v2 HTTP forms validate before receipts and submit a normal turn, with exact durable replay after expiry', async t => {
    const f = fixture(t), requests: string[] = [], v2 = { enabled: true as const, catalogId: UI_CATALOG_V2 };
    t.mock.method(orchestrator, 'processMessage', async (ctx: BotContext, text: string) => {
        requests.push(text); assert.equal(ctx.allowDeferredDialogue, false);
        assert.equal((ctx as any).allowExternalDelivery, undefined);
        return { responseText: answer, skipOptionalFollowups: true };
    });
    t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: JSON.stringify({ components: [
        { id: 'root', component: 'Column', children: ['minutes', 'confirm', 'submit'] },
        { id: 'minutes', component: 'Slider', label: 'Минуты', min: 10, max: 60, step: 5, value: 20 },
        { id: 'confirm', component: 'Toggle', label: 'Разминка', value: true },
        { id: 'submit', component: 'Button', child: 'label', action: { type: 'submit', text: 'Составь план', fields: ['minutes', 'confirm'] } },
        { id: 'label', component: 'Text', text: 'Составить план' },
    ] }) } }] }) as any);
    const post = await http(t, f.backend);
    const first = await (await post('/messages', { text: 'Подбери план', ui: v2 }, 'form-create-001')).json() as any;
    const actionToken = first.messages[0].ui.messages[0].createSurface.components.find((c: any) => c.id === 'submit').action.event.context.actionToken;
    const values = { minutes: 25, confirm: false }, key = 'form-submit-001';
    for (const bad of [{ ...values, minutes: 26 }, { ...values, confirm: 'no' }, { ...values, injected: {} }, { minutes: 25 }]) {
        assert.equal((await post('/actions', { actionToken, values: bad }, key)).status, 400);
    }
    const sent = await post('/actions', { actionToken, values }, key); assert.equal(sent.status, 200);
    const result = await sent.json(); assert.equal(requests.length, 2); assert.match(requests[1], /Минуты: 25\nРазминка: Нет/);
    assert.equal((await post('/actions', { actionToken, values: { ...values, minutes: 30 } }, key)).status, 409);
    const originalNow = Date.now(); t.mock.method(Date, 'now', () => originalNow + 20 * 60_000);
    assert.deepEqual(await (await post('/actions', { actionToken, values }, key)).json(), result);
    assert.deepEqual(await (await post('/actions', { actionToken, values }, 'form-new-key-001')).json(), result);
    assert.equal(requests.length, 2);
    await assert.rejects(f.backend.action(actionToken, undefined, values), (e: any) => e.code === 'action_expired');
});

test('v2 HTTP devices, feedback, revision polling and history share owner state and exact route contracts', async t => {
    const f = fixture(t), receipts = new Receipts();
    t.mock.method(DialogueJobRepository, 'list', async () => []);
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: 'Учебный прогноз на 2041-04-12T19:00:00Z.', skipOptionalFollowups: true }));
    t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: JSON.stringify({ components: [
        { id: 'root', component: 'Progress', label: 'Учебная цель', value: 0.5 },
    ], meta: { asOf: '2041-04-12T19:00:00Z' } }) } }] }) as any);
    const server = createExternalApiServer(options, f.backend, receipts);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    let seq = 0;
    const call = (path: string, method = 'GET', body?: unknown, key = 'v2-http-key-' + (++seq), auth = token) => fetch(base + path, {
        method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'idempotency-key': key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const deviceId = '11111111-1111-4111-8111-111111111111';
    assert.equal((await call('/ui/devices', 'GET', undefined, undefined, 'wrong')).status, 401);
    const prefs = { catalogId: UI_CATALOG_V2, proactive: true, diagnostics: true };
    const registration = await call('/ui/devices/' + deviceId, 'PUT', prefs, 'device-register-001'); assert.equal(registration.status, 200);
    const { device } = await registration.json() as any;
    assert.deepEqual(await (await call('/ui/devices/' + deviceId, 'PUT', prefs, 'device-register-001')).json(), { device });
    assert.equal((await call('/ui/devices/' + deviceId, 'PUT', { ...prefs, proactive: false })).status, 409);
    const ui = { enabled: true, catalogId: UI_CATALOG_V2, device: { id: deviceId, bindingId: device.bindingId } };
    const reply = await (await call('/messages', 'POST', { text: 'Прогноз', ui }, 'v2-initial-001')).json() as any;
    const message = reply.messages[0], surfaceId = message.ui.messages[0].createSurface.surfaceId;
    assert.equal((await call('/messages', 'POST', { text: 'Прогноз', ui: { ...ui, metadata: true } }, 'v2-initial-001')).status, 409);
    const feedback = { surfaceId, messageId: message.id, verdict: 'not_shown', reason: 'rendererError', device: ui.device };
    assert.equal((await call('/ui-feedback', 'POST', feedback, 'feedback-http-001')).status, 200);
    assert.equal((await call('/ui-feedback', 'POST', feedback, 'feedback-http-001')).status, 200);
    assert.equal((await call('/ui-feedback', 'POST', { ...feedback, reason: 'private text' })).status, 400);
    assert.equal((await call('/ui-feedback', 'POST', { ...feedback, messageId: -1 })).status, 404);
    assert.equal((await (await call('/ui/feedback-metrics')).json() as any).rejectedOnDevice, 1);
    f.advance();
    assert.equal((await call('/messages', 'POST', { text: 'Обнови', ui: { ...ui, target: { surfaceId, revision: 1 } } })).status, 200);
    const pollPath = `/dialogue-jobs?uiAfter=0&uiDeviceId=${deviceId}&uiBindingId=${device.bindingId}`;
    const poll = await (await call(pollPath)).json() as any;
    assert.equal(poll.uiEvents.length, 1); assert.equal(poll.uiEvents[0].messages[0].ui.revision, 2);
    assert.equal((await f.backend.history(20)).messages.find(m => m.ui)!.ui!.revision, 2);
    assert.equal((await call(`/ui/surfaces/${surfaceId}?expectedRevision=1`, 'DELETE')).status, 409);
    assert.equal((await call(`/ui/surfaces/${surfaceId}?expectedRevision=2`, 'DELETE')).status, 200);
    assert.ok((await f.backend.history(20)).messages.every(m => !m.ui));
    assert.equal((await call('/ui/devices/' + deviceId, 'DELETE')).status, 200);
    assert.equal((await call(pollPath)).status, 409);
    assert.equal((await call('/ui/devices/' + deviceId + '/extra', 'PUT', prefs)).status, 404);
});

test('HTTP API source → opt-in widget → refresh changes no dialogue/history/memory and replays receipts without source calls', async t => {
    const f = fixture(t, { allowed: async () => true }), sourceUrl = 'https://example.org/station';
    const configuration = mcpConfig.parseMcpConfig({ servers: { synthetic: { description: 'Учебный API без модели', transport: 'jsonrpc', url: 'https://example.org/mcp',
        tools: { observation: 'read' }, refreshTools: ['observation'], fixedArguments: { account: 'synthetic-account' } } } });
    let price = 18, sourceCalls = 0, turns = 0, uiCalls = 0;
    const source = new McpService(() => configuration, async () => ({ client: {
        listTools: async () => ({ tools: [{ name: 'observation', inputSchema: { type: 'object', properties: { station: { type: 'string' }, account: { const: 'synthetic-account' } }, required: ['station', 'account'] } }] }),
        callTool: async (body: any) => { sourceCalls++; assert.deepEqual(body.arguments, { station: 'training', account: 'synthetic-account' });
            return { content: [], structuredContent: { uiRefresh: { identity: 'station:training:celsius', asOf: price === 18 ? '2041-04-12T19:00:00Z' : '2041-04-12T20:00:00Z',
                sources: [{ label: 'Учебный источник', url: sourceUrl }], values: { temperature: price } } } }; },
    } as any, close: async () => {} }));
    t.mock.method(mcpConfig, 'readMcpConfig', () => configuration);
    t.mock.method(mcpService, 'callTool', (id: string, name: string, args: Record<string, unknown>, effect: any, signal?: AbortSignal) => source.callTool(id, name, args, effect, signal));
    t.mock.method(orchestrator, 'processMessage', async () => { turns++; await source.callTool('synthetic', 'observation', { station: 'training' }, 'read');
        return { responseText: `Учебная температура 18 °C. ${sourceUrl}`, skipOptionalFollowups: true }; });
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: string, args: any) => {
        uiCalls++; const input = JSON.parse(args.messages[1].content);
        return { choices: [{ message: { content: JSON.stringify({ components: [{ id: 'root', component: 'Metric', label: 'Учебная температура', value: '18 °C' }],
            ...(input.refreshSources?.length ? { refresh: { source: 0, subject: 'Температура учебной станции training, °C', sourceUrl,
                slots: [{ id: 'temperature', componentId: 'root', path: ['value'], sourceField: 'temperature', suffix: ' °C', description: 'Температура, строка в °C' }] } } : {}) }) } }] } as any;
    });
    const post = await http(t, f.backend), refreshUi = { ...ui, refresh: true };
    const turn = await (await post('/messages', { text: 'Покажи температуру', ui: refreshUi }, 'refresh-initial-001')).json() as any;
    const message = turn.messages[0]; assert.ok(message.uiRefresh); assert.equal(message.uiRefresh.kind, 'data');
    const original = structuredClone(message.ui), historyBefore = JSON.stringify(f.saved()), writesBefore = f.writes();
    assert.deepEqual((await f.backend.history(20)).messages.find(m => m.ui)!.uiRefresh, message.uiRefresh);
    for (let i = 0; i < 10; i++) f.advance(); price = 19;
    const body = { items: [{ token: message.uiRefresh.token, surfaceId: original.messages[0].createSurface.surfaceId }], ui: refreshUi };
    const refreshed = await post('/ui/refresh', body, 'refresh-fetch-001'); assert.equal(refreshed.status, 200);
    const result = await refreshed.json() as any; assert.equal(result.results[0].status, 'updated');
    assert.equal(result.results[0].ui.messages[0].createSurface.components[0].value, '19 °C');
    assert.deepEqual(await (await post('/ui/refresh', body, 'refresh-fetch-001')).json(), result);
    assert.equal(sourceCalls, 2); assert.equal(uiCalls, 1); assert.equal(turns, 1); assert.equal(f.writes(), writesBefore);
    assert.equal(JSON.stringify(f.saved()), historyBefore); assert.deepEqual((await f.backend.history(20)).messages.find(m => m.ui)!.ui, original);
    assert.equal((await f.widgets.events()).uiEvents.length, 0);
    assert.equal((await post('/ui/refresh', { ...body, items: [{ ...body.items[0], token: 'unknown' }] }, 'refresh-fetch-001')).status, 409);
    const cached = await (await post('/ui/refresh', body, 'refresh-recover-001')).json() as any; assert.equal(cached.results[0].status, 'updated'); assert.equal(sourceCalls, 2);
    assert.equal((await post('/messages', { text: 'Покажи температуру', ui }, 'refresh-initial-001')).status, 409);
    const plain = await f.backend.message('Покажи температуру', { ui }); assert.equal(plain.messages[0].uiRefresh, undefined);
});

test('HTTP refresh requires account auth, gates disabled capability, bounds batches and returns a retry interval on rate limits', async t => {
    const f = fixture(t), post = await http(t, f.backend), sid = 'kira_11111111111141118111111111111111';
    const body = { items: [{ token: 'unknown', surfaceId: sid }], ui: { ...ui, refresh: true } };
    assert.equal((await post('/ui/refresh', body, 'auth-refresh-001', { authorization: 'Bearer invalid' })).status, 401);
    assert.equal((await post('/ui/refresh', { ...body, items: Array.from({ length: 11 }, () => body.items[0]) }, 'large-refresh-001')).status, 413);
    for (let i = 0; i < 30; i++) assert.equal((await post('/ui/refresh', body, 'rate-refresh-' + i)).status, 200);
    const limited = await post('/ui/refresh', body, 'rate-refresh-excess'); assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0); assert.ok((await limited.json() as any).error.retryAfterSeconds > 0);
    f.advance(); assert.equal((await post('/ui/refresh', body, 'rate-refresh-excess')).status, 200);
    const old = process.env.KIRA_UI_REFRESH_ENABLED; process.env.KIRA_UI_REFRESH_ENABLED = 'false';
    t.after(() => { if (old === undefined) delete process.env.KIRA_UI_REFRESH_ENABLED; else process.env.KIRA_UI_REFRESH_ENABLED = old; });
    assert.equal((await post('/ui/refresh', body, 'disabled-refresh-001')).status, 404);
});
