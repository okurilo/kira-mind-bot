import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { DataSource } from 'typeorm';
import { config } from '../config';
import type { BotContext } from '../types';
import type { Reminder } from '../reminder';
import { registerCallback } from '../callbacks';
import { queueMessage, processBuffers, getBufferStats } from '../services/reflectionModeService';
import { MessageStore } from '../stores/MessageStore';
import { ReminderService } from '../services/ReminderService';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { ReminderEntity } from '../entity/ReminderEntity';
import { BotSettingsTelegramReminderStore, TelegramReminderProposals, telegramReminderProposals,
    type TelegramReminderProposalState, type TelegramReminderProposalStore } from '../services/telegramReminderProposals';
import * as completion from '../ai/chatCompletion';
import * as triage from '../ai/reflectionTriage';
import * as settings from '../services/botSettingsService';
import * as features from '../services/backgroundFeatureService';
import * as telegram from '../services/telegram';
import { publicTestPort, withPublicRegistry } from './support/publicAccounts';

const owner = 718204;
class Store implements TelegramReminderProposalStore {
    state: TelegramReminderProposalState = { version: 1, proposals: [], sentAt: [] };
    async read() { return structuredClone(this.state); }
    async update<T>(work: (state: TelegramReminderProposalState) => T) { const s = await this.read(), result = work(s); this.state = structuredClone(s); return result; }
}
for (const outcome of ['accept', 'decline', 'cancelled', 'changed_source'] as const) test(`Telegram updates → reflection batch → card → ${outcome} uses the real callback and reminder service`, async t => {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = oldOwner; });
    const chat = ({ accept: '701', decline: '702', cancelled: '703', changed_source: '705' })[outcome];
    const messageStore = MessageStore.getInstance(); messageStore.clear();
    let enabled = true; const memorySettings = new Map<string, string>();
    t.mock.method(features, 'isBackgroundFeatureEnabled', async () => enabled);
    t.mock.method(triage, 'needsPriorityReflection', async () => false);
    t.mock.method(settings, 'getSetting', async (key: string, fallback: string) => memorySettings.get(key) ?? fallback);
    t.mock.method(settings, 'setSetting', async (key: string, value: string) => { memorySettings.set(key, value); });
    const store = new Store(), saved: Reminder[] = [], timers: Reminder[] = [];
    const creator = new ReminderService({ save: async r => { saved.push(r); }, register: () => {}, schedule: r => { timers.push(r); }, syncMemory: async () => {} });
    let service = new TelegramReminderProposals(store, { enabled: async () => enabled,
        create: async (ctx, p) => creator.createReminder(ctx, { id: p.id, text: p.text, dueDate: new Date(p.remindAt), reminderMessage: p.text }),
        find: async id => saved.find(r => r.id === id) });
    t.mock.method(telegramReminderProposals, 'context', (...args: Parameters<TelegramReminderProposals['context']>) => service.context(...args));
    t.mock.method(telegramReminderProposals, 'applyReview', (...args: Parameters<TelegramReminderProposals['applyReview']>) => service.applyReview(...args));
    t.mock.method(telegramReminderProposals, 'respond', (...args: Parameters<TelegramReminderProposals['respond']>) => service.respond(...args));
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getMessages: async (_chat: number, options: any) =>
        messageStore.getMessages(chat).filter(m => options.ids ? options.ids.includes(m.id) : true).slice(0, options.limit ?? 100)
            .map(m => ({ id: m.id, message: m.text, fwdFrom: m.isForwarded ? {} : undefined })) }) as any);
    const replies: any[] = [], edits: any[] = [];
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async (_prev, method, payload: any) => {
        if (method === 'answerCallbackQuery') return { ok: true, result: true } as any;
        if (method === 'editMessageText') { edits.push(payload); return { ok: true, result: true } as any; }
        assert.ok(['sendMessage', 'sendRichMessage'].includes(method), method);
        const result = { message_id: 900 + replies.length, date: 0, chat: { id: owner, type: 'private' }, ...payload }; replies.push(result);
        return { ok: true, result } as any;
    });
    bot.use(async (ctx, next) => { ctx.session = { reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } as any; await next(); });
    registerCallback(bot);
    const remindAt = new Date(Date.now() + 86400_000).toISOString(); let cancelled = false;
    const ai = t.mock.method(completion, 'createChatCompletionForTask', async (task: string, params: any) => {
        assert.equal(task, 'lightweightText');
        const input = JSON.parse(params.messages[1].content);
        assert.ok(input.newMessages.some((m: any) => m.text === 'Да'));
        return { choices: [{ message: { content: JSON.stringify({ useful: false, emotion: 'neutral', reminderReview: cancelled
            ? { candidates: [], invalidated: [{ anchorMessageId: 1, evidence: [{ messageId: 6, quote: 'Макет больше не нужен' }] }] }
            : { invalidated: [], candidates: [{ anchorMessageId: 1, text: 'Взять учебный макет', remindAt, timing: 'suggested', confidence: .96, ownerRelevance: 'agreement',
                evidence: [{ messageId: 1, quote: 'Захвати завтра утром' }, { messageId: 3, quote: 'Учебный макет' }, { messageId: 5, quote: 'Да' }] }] } }) } }] } as any;
    });
    async function append(text: string, id: number, isOwn: boolean) {
        const date = new Date(Date.now() - 10_000 + id * 100);
        messageStore.addMessage(chat, { id, text, date, isOwn, senderId: isOwn ? owner : Number(chat), senderName: isOwn ? 'Я' : 'Контакт Альфа', isRead: false, isBot: false });
        await queueMessage(chat, 'Контакт Альфа', text, date, isOwn, id);
    }
    await append('Захвати завтра утром', 1, false); await append('Что именно?', 2, true); await append('Учебный макет', 3, false);
    await append('08:00', 4, false); await append('Да', 5, true);
    await processBuffers(bot);
    assert.equal(ai.mock.callCount(), 1, 'The existing prescreen evaluates the whole series once');
    assert.equal(replies.length, 1); assert.equal(saved.length, 0); assert.equal(timers.length, 0);
    const original = store.state.proposals[0];
    assert.equal(original.reviewedThroughId, 5); assert.equal(original.status, 'pending');
    async function click(accept: boolean, id: number) {
        await bot.handleUpdate({ update_id: id, callback_query: { id: String(id), chat_instance: 'synthetic',
            from: { id: owner, is_bot: false, first_name: 'Synthetic' }, data: `tgrem:${accept ? 'y' : 'n'}:${original.id}`,
            message: { message_id: original.messageId!, date: 0, chat: { id: owner, type: 'private', first_name: 'Synthetic' }, text: 'Synthetic proposal' } } });
    }
    if (outcome === 'changed_source') {
        const source = messageStore.getMessages(chat).find(m => m.id === 1)!;
        source.text = 'Ничего не бери';
        await click(true, 3000); assert.equal(saved.length, 0, 'Editing a proof message invalidates consent even when its ID is unchanged');
        source.text = 'Захвати завтра утром'; messageStore.removeMessage(chat, 3);
        await click(true, 3001); assert.equal(saved.length, 0, 'A deleted source cannot be replaced by the old stored quote');
    } else if (outcome === 'cancelled') {
        cancelled = true;
        for (const [i, text] of ['Макет больше не нужен', 'Отменяем?', 'Да', 'Хорошо', 'Тогда без макета'].entries()) await append(text, i + 6, i % 2 === 1);
        await click(true, 3000); assert.equal(saved.length, 0, 'A new cancellation blocks an old card before the next analysis');
        await processBuffers(bot); assert.equal(store.state.proposals[0].status, 'superseded');
        await click(true, 3001); assert.equal(saved.length, 0);
    } else {
        service = new TelegramReminderProposals(store, { create: async (ctx, p) => creator.createReminder(ctx, { id: p.id, text: p.text, dueDate: new Date(p.remindAt) }), find: async id => saved.find(r => r.id === id) });
        enabled = false; // Pausing background does not revoke this explicit manual request.
        await click(outcome === 'accept', 3000); await click(true, 3001);
        assert.equal(saved.length, outcome === 'accept' ? 1 : 0); assert.equal(timers.length, saved.length);
        assert.equal(ai.mock.callCount(), 1, 'Confirmation never repeats semantic parsing');
        if (saved.length) { assert.equal(saved[0].chatId, owner); assert.equal(saved[0].dueDate.toISOString(), remindAt); }
    }
    if (outcome !== 'changed_source') assert.ok(edits.length > 0);
    messageStore.clear();
});

test('PostgreSQL receipt survives reload and serializes competing clicks without a duplicate reminder', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async db => {
        const runtime = await new DataSource({ ...db.options, entities: [BotSettingEntity, ReminderEntity], synchronize: true, logging: false } as any).initialize();
        const oldOwner = config.allowedUserId; config.allowedUserId = owner;
        try {
            const store = new BotSettingsTelegramReminderStore(runtime, () => 'synthetic:telegram-reminders');
            let timerCount = 0;
            const creator = new ReminderService({ save: async r => { await runtime.getRepository(ReminderEntity).save({ ...r, profile: 'Synthetic' }); },
                register: () => {}, schedule: () => { timerCount++; }, syncMemory: async () => {} });
            const deps = { enabled: async () => true, newerMessages: () => false, verifyFresh: async () => true,
                create: (ctx: BotContext, p: any) => creator.createReminder(ctx, { id: p.id, text: p.text, dueDate: new Date(p.remindAt) }),
                find: async (id: string) => (await runtime.getRepository(ReminderEntity).findOneBy({ id })) as Reminder | undefined };
            const first = new TelegramReminderProposals(store, deps), second = new TelegramReminderProposals(store, deps);
            await first.applyReview({ api: { sendRichMessage: async () => ({ message_id: 501 }) } } as any, '704', 'Контакт Альфа', 2, { invalidated: [], candidates: [{
                anchorMessageId: 1, text: 'Взять учебный макет', remindAt: new Date(Date.now() + 86400_000).toISOString(), timing: 'suggested', confidence: .95,
                ownerRelevance: 'agreement', evidence: [{ messageId: 1, quote: 'Учебный макет' }, { messageId: 2, quote: 'Да' }],
            }] });
            const p = (await store.read()).proposals[0];
            const ctx = () => ({ from: { id: owner }, chat: { id: owner, type: 'private' }, session: { reminders: [] }, callbackQuery: { message: { message_id: 501 } } }) as any;
            await Promise.all([first.respond(ctx(), p.id, true), second.respond(ctx(), p.id, true)]);
            assert.equal(await runtime.getRepository(ReminderEntity).count(), 1); assert.equal(timerCount, 1);
            assert.equal((await new TelegramReminderProposals(new BotSettingsTelegramReminderStore(runtime, () => 'synthetic:telegram-reminders'), deps).respond(ctx(), p.id, true)).status, 'already_created');
            assert.equal(timerCount, 1);
            await runtime.getRepository(BotSettingEntity).upsert({ key: 'synthetic:telegram-reminders', value: '{broken' }, ['key']);
            await assert.rejects(store.read(), 'Malformed persisted state must not become a fresh empty store');
            await assert.rejects(store.update(() => {}));
        } finally { config.allowedUserId = oldOwner; await runtime.destroy(); }
    });
});

test('a short settled series is analyzed without waiting 30 minutes, and empty prescreens obey the hourly budget', async t => {
    t.mock.method(features, 'isBackgroundFeatureEnabled', async () => true);
    t.mock.method(triage, 'needsPriorityReflection', async () => false);
    t.mock.method(settings, 'getSetting', async (_key: string, fallback: string) => fallback);
    t.mock.method(settings, 'setSetting', async () => {});
    t.mock.method(telegramReminderProposals, 'context', async () => []);
    t.mock.method(telegramReminderProposals, 'applyReview', async () => {});
    const call = t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: '{"useful":false,"emotion":"neutral"}' } }] }) as any);
    const start = getBufferStats().analysesThisHour;
    assert.ok(start < 6);
    for (let index = 0; index < 8; index++) {
        await queueMessage(`quiet-${index}`, 'Контакт Альфа', 'Учебное событие завтра', new Date(Date.now() - 180_000), false, 1);
        await queueMessage(`quiet-${index}`, 'Контакт Альфа', 'Да', new Date(Date.now() - 179_000), true, 2);
    }
    await processBuffers({} as any);
    assert.equal(call.mock.callCount(), 6 - start);
    await processBuffers({} as any);
    assert.equal(call.mock.callCount(), 6 - start, 'A not-useful result still consumes the bounded analysis slot');
});
