import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot, session } from 'grammy';
import { config } from '../config';
import type { BotContext, SessionData } from '../types';
import { registerTextMessageHandler } from '../handlers/textMessages';
import { registerDialogueLifecycle, executeDialogueJob } from '../services/dialogueJobs';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { registerCallback } from '../callbacks';
import { registerTelegramWidgetBridge, telegramUi, TelegramUiService } from '../generative-ui/telegram';
import { MemoryUiStore } from './helpers/generativeUi';
import * as history from '../utils/history';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import * as orchestrator from '../orchestrator';
import * as proposals from '../services/telegramReminderProposals';
import * as storage from '../services/SessionStorage';
import * as preset from '../services/aiRuntimeConfigService';
import * as policy from '../services/modelPreferenceService';
import { currentAccountAiOperation, backgroundAiTaskId } from '../ai/accountPolicy';
import { sendResultToUser } from '../handlers/shared';
import * as tts from '../services/elevenLabsTts';

const owner = 730001;
const botInfo = { id: 1234567890, is_bot: true as const, first_name: 'Synthetic', username: 'synthetic_bot' } as any;
const draft = { components: [{ id: 'root', component: 'Column', children: ['price', 'button'] },
    { id: 'price', component: 'Metric', label: 'Учебная цена', value: '18 USD' },
    { id: 'button', component: 'Button', child: 'label', action: { type: 'reply', text: 'Покажи учебную цену завтра' } },
    { id: 'label', component: 'Text', text: 'Завтра' }] };

test('a real Telegram text handler sends its answer + widget; a widget reply becomes the next canonical user turn; existing callbacks keep their original context', async t => {
    const prior = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = prior; });
    const store = new MemoryUiStore();
    const service = new TelegramUiService(store, async () => JSON.stringify(draft));
    t.mock.method(telegramUi, 'deliver', (...args: Parameters<TelegramUiService['deliver']>) => service.deliver(...args));
    t.mock.method(DialogueJobRepository, 'beginTurn', async (_channel: string, turn: string) => { await store.transact(owner, tx => tx.put('canonical', 'turn', turn)); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => { ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() }); });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(storage.TypeORMSessionStorage.prototype, 'write', async () => {});
    const requests: string[] = [];
    t.mock.method(orchestrator, 'processMessage', async (_ctx: BotContext, text: string) => { requests.push(text); return { responseText: 'Учебная цена — 18 USD.', operationStatus: 'ok', skipOptionalFollowups: true } as any; });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo });
    const calls: Array<{ method: string; payload: any }> = []; let id = 100;
    bot.api.config.use(async (_prev, method, payload) => {
        calls.push({ method, payload });
        return { ok: true, result: ['sendMessage', 'sendWidget'].includes(method) ? { message_id: ++id, date: 1, chat: { id: owner, type: 'private' }, text: (payload as any).text } : true } as any;
    });
    registerTelegramWidgetBridge(bot, service, owner);
    let saved: SessionData | undefined;
    bot.use(session({ initial: (): SessionData => ({ reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1, sentMessages: {}, isAllowedUser: true }),
        storage: { read: async () => saved, write: async (_key, value) => { saved = value; }, delete: async () => {} } }));
    registerCallback(bot); registerDialogueLifecycle(bot); registerTextMessageHandler(bot);
    const waitFor = async (condition: () => boolean) => { const until = Date.now() + 6000; while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(condition(), 'The ordinary handler must complete'); };
    await bot.handleUpdate({ update_id: 1, message: { message_id: 10, date: 1, chat: { id: owner, type: 'private', first_name: 'Synthetic' }, from: { id: owner, is_bot: false, first_name: 'Synthetic' }, text: 'Покажи учебную цену наглядно' } });
    await waitFor(() => calls.some(c => c.method === 'sendWidget'));
    const sentText = calls.find(c => c.method === 'sendMessage' && c.payload.text === 'Учебная цена — 18 USD.'); assert.ok(sentText);
    const firstWidget = calls.find(c => c.method === 'sendWidget')!;
    assert.equal(firstWidget.payload.chat_id, owner); assert.match(firstWidget.payload.html, /18 USD/);
    const widgetId = id;
    const query = { id: 'synthetic-query', from: { id: owner, is_bot: false, first_name: 'Synthetic' }, chat: { id: owner, type: 'private', first_name: 'Synthetic' },
        message_id: widgetId, chat_instance: 'private', type: { type: 'data' }, data: 'a:0:0' };
    await bot.handleUpdate({ update_id: 2, widget_query: query } as any);
    await waitFor(() => requests.length === 2 && calls.filter(c => c.method === 'sendWidget').length === 2);
    assert.deepEqual(requests, ['Покажи учебную цену наглядно', 'Покажи учебную цену завтра']);
    assert.equal(saved!.messageHistory.filter(m => m.role === 'user').length, 2);
    assert.equal(saved!.messageHistory.filter(m => m.role === 'bot').length, 2);
    assert.equal(await store.transact(owner, tx => tx.dialogueTurn!()), 'tg:2');
    assert.ok(saved!.sentMessages?.[widgetId]);
    const lastId = id, received: string[] = [];
    t.mock.method(proposals, 'handleTelegramReminderProposalCallback', async (ctx: BotContext, data: string) => {
        received.push(data); assert.equal(ctx.callbackQuery?.message?.message_id, lastId); assert.equal(ctx.from?.id, owner); assert.ok(ctx.session.isAllowedUser); await ctx.answerCallbackQuery(); return true;
    });
    const callbackUi = new TelegramUiService(store, async () => JSON.stringify({ components: [{ id: 'root', component: 'Button', child: 'label', action: { type: 'existing', index: 0 } }, { id: 'label', component: 'Text', text: 'Подтвердить' }] }));
    await callbackUi.deliver(owner, bot.api.raw as any, 'Подтверди', 'Подготовлено действие.', lastId, { inline_keyboard: [[{ text: 'Подтвердить', callback_data: 'synthetic_confirmation' }]] }, 'tg:2');
    await bot.handleUpdate({ update_id: 3, widget_query: { ...query, id: 'callback-query', message_id: id } } as any);
    assert.deepEqual(received, ['synthetic_confirmation']);
    assert.equal(calls.filter(c => c.method === 'answerCallbackQuery').length, 0);
    assert.ok(calls.findIndex(c => c.method === 'answerWidgetQuery') < calls.findIndex(c => c.method === 'editMessageWidgetData'));
});

test('a delivered deferred Telegram answer composes its widget under the original quota operation/preset and never leaks an API job', async t => {
    const prior = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = prior; });
    const env = process.env.KIRA_FAST_DIALOGUE_ENABLED; process.env.KIRA_FAST_DIALOGUE_ENABLED = 'true';
    t.after(() => { if (env === undefined) delete process.env.KIRA_FAST_DIALOGUE_ENABLED; else process.env.KIRA_FAST_DIALOGUE_ENABLED = env; });
    t.mock.method(storage, 'appendPersistedHistory', async () => {});
    t.mock.method(preset, 'runWithChannelPreset', async (_preset: any, work: () => Promise<unknown>) => work());
    t.mock.method(policy, 'runWithModelPolicy', async (_policy: any, work: () => Promise<unknown>) => work());
    const active = t.mock.method(DialogueJobRepository, 'isActive', async () => true);
    const visuals: any[] = [];
    let expectedOperation = { id: 'synthetic-original-turn', background: false };
    t.mock.method(telegramUi, 'deliver', async (...args: any[]) => { visuals.push(args); assert.deepEqual(currentAccountAiOperation(), expectedOperation); return undefined; });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo });
    const sends: any[] = [];
    bot.api.config.use(async (_prev, method, payload) => { sends.push({ method, payload }); return { ok: true, result: { message_id: 101 } } as any; });
    const job: any = { id: 'synthetic-job', userId: owner, chatId: owner, channel: String(owner), turnId: 'tg:1', messageId: 10, status: 'delivering', lease: 'synthetic-lease',
        resultText: 'Учебная цена 18 USD.', input: { required: true, message: 'Покажи цену', preset: 'gpt-lean', accountAiOperation: { id: 'synthetic-original-turn', background: false } } };
    const deps = { enabled: async () => true, repository: { isActive: async () => true, update: async () => true } as any };
    await executeDialogueJob(bot, job, deps);
    assert.equal(visuals.length, 1); assert.equal(visuals[0][4], 101); assert.equal(visuals[0][6], 'tg:1');
    assert.equal(await visuals[0][7](), true); assert.ok(active.mock.callCount() > 0);
    expectedOperation = { id: backgroundAiTaskId('dialogue-review', job.id), background: true };
    await executeDialogueJob(bot, { ...job, input: { ...job.input, required: false } }, deps);
    assert.equal(visuals.length, 2);
    await executeDialogueJob(bot, { ...job, channel: 'api:' + owner }, deps);
    assert.equal(visuals.length, 2); assert.equal(sends.filter(s => s.method === 'sendMessage').length, 2);
});

test('the canonical spoken text is delivered before the optional widget, and widget failures cannot replace or repeat voice delivery', async t => {
    const prior = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = prior; });
    const events: string[] = [], text = 'Учебная температура 18 °C.';
    t.mock.method(tts, 'getTelegramVoiceReadinessIssue', async () => undefined);
    t.mock.method(tts, 'withTelegramVoiceFile', async (spoken: string, work: (voice: any) => Promise<any>) => {
        assert.equal(spoken, text); return work({ filePath: '/synthetic/voice.ogg', filename: 'synthetic.ogg' });
    });
    const store = new MemoryUiStore(); await store.transact(owner, tx => tx.put('canonical', 'turn', 'tg:1'));
    const service = new TelegramUiService(store, async () => JSON.stringify(draft));
    const deliver = t.mock.method(telegramUi, 'deliver', (...args: Parameters<TelegramUiService['deliver']>) => service.deliver(...args));
    const ctx = { from: { id: owner }, chat: { id: owner, type: 'private' }, message: { text: 'Проговори прогноз и покажи наглядно' }, telegramUiTurnId: 'tg:1',
        session: { sentMessages: {}, messageHistory: [] },
        api: { sendChatAction: async () => true, raw: { sendWidget: async () => { events.push('widget'); return { message_id: 102 }; } } },
        replyWithVoice: async () => { events.push('voice'); return { message_id: 101 }; },
    } as unknown as BotContext;
    assert.equal((await sendResultToUser(ctx, { responseText: text }, true)).message_id, 101);
    assert.deepEqual(events, ['voice', 'widget']); assert.equal(ctx.session.sentMessages?.[102], text);
    for (const code of ['unsupported_method', 'timeout_unknown']) {
        deliver.mock.mockImplementation(async () => { throw Error(code); });
        const before = events.length;
        assert.equal((await sendResultToUser(ctx, { responseText: text }, true)).message_id, 101);
        assert.deepEqual(events.slice(before), ['voice']);
    }
});
