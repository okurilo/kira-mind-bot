import assert from 'node:assert/strict';
import { test, TestContext } from 'node:test';
import { Bot } from 'grammy';
import { config } from '../config';
import { TelegramReminderProposals, handleTelegramReminderProposalCallback, type TelegramReminderProposal,
    type TelegramReminderProposalState, type TelegramReminderProposalStore } from '../services/telegramReminderProposals';
import { ReminderService } from '../services/ReminderService';
import { normalizeReminderReview, type ReminderSourceMessage, type TelegramReminderCandidate } from '../ai/telegramReminderReview';
import type { BotContext } from '../types';
import type { Reminder } from '../reminder';
import { zonedDateTimeToDate } from '../utils/time';

const owner = 719203;
class MemoryStore implements TelegramReminderProposalStore {
    state: TelegramReminderProposalState = { version: 1, proposals: [], sentAt: [] };
    failRead = false; failWrite = false;
    private lane: Promise<unknown> = Promise.resolve();
    async read() { if (this.failRead) throw Error('Synthetic read failure'); return structuredClone(this.state); }
    async update<T>(work: (state: TelegramReminderProposalState) => T): Promise<T> {
        const run = this.lane.catch(() => {}).then(async () => {
            const state = await this.read(), result = work(state);
            if (this.failWrite) throw Error('Synthetic write failure');
            this.state = structuredClone(state); return result;
        });
        this.lane = run; return run;
    }
}
function fixture(t: TestContext) {
    const previous = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = previous; });
    const store = new MemoryStore(); let now = zonedDateTimeToDate(2037, 4, 8, 12, 0).getTime(), enabled = true, newer = false, fresh = true, sendError = false;
    const saved = new Map<string, Reminder>(), scheduled: Reminder[] = [], messages: any[] = [];
    const creator = new ReminderService({ save: async r => { saved.set(r.id, structuredClone(r)); }, register: () => {},
        schedule: r => scheduled.push(r), syncMemory: async () => {} });
    const deps = { now: () => now, enabled: async () => enabled, newerMessages: () => newer, verifyFresh: async () => fresh,
        create: async (ctx: BotContext, p: TelegramReminderProposal) => creator.createReminder(ctx, { id: p.id, text: p.text, dueDate: new Date(p.remindAt), reminderMessage: p.text }),
        find: async (id: string) => saved.get(id) };
    let service = new TelegramReminderProposals(store, deps);
    const api = { sendRichMessage: async (_chat: number, body: any, extra: any) => {
        if (sendError) throw Error('Synthetic transport failure');
        const sent = { message_id: 800 + messages.length, body, extra }; messages.push(sent); return sent;
    }, sendMessage: async () => { if (sendError) throw Error('Synthetic transport failure'); throw Error('Unexpected fallback'); } };
    const bot = { api } as unknown as Bot<BotContext>;
    const candidate = (anchor = 1, text = 'Взять учебный макет'): TelegramReminderCandidate => ({ anchorMessageId: anchor, text,
        remindAt: new Date(now + 86400_000).toISOString(), timing: 'suggested', ownerRelevance: 'agreement', confidence: .97,
        evidence: [{ messageId: anchor, quote: 'Учебный макет' }, { messageId: anchor + 1, quote: 'Да' }] });
    const offer = async (anchor = 1, text?: string) => service.applyReview(bot, '601', 'Контакт <Альфа>', anchor + 1, { candidates: [candidate(anchor, text)], invalidated: [] });
    const ctx = (p = store.state.proposals[store.state.proposals.length - 1]) => ({ from: { id: owner }, chat: { id: owner, type: 'private' },
        session: { reminders: [] }, callbackQuery: { message: { message_id: p.messageId, chat: { id: owner, type: 'private' } } } }) as any;
    return { store, saved, scheduled, messages, bot, candidate, offer, ctx, get service() { return service; },
        restart: () => { service = new TelegramReminderProposals(store, deps); },
        time: (ms: number) => { now += ms; }, enabled: (v: boolean) => { enabled = v; }, newer: (v: boolean) => { newer = v; },
        fresh: (v: boolean) => { fresh = v; }, sendError: () => { sendError = true; } };
}

test('a proposal is only a card; consent creates one real reminder and survives a restart and double clicks', async t => {
    const f = fixture(t); await f.offer();
    assert.equal(f.messages.length, 1); assert.equal(f.saved.size, 0); assert.equal(f.scheduled.length, 0);
    assert.match(f.messages[0].body.html, /Контакт &lt;Альфа&gt;/);
    assert.match(f.messages[0].body.html, /Предлагаю напомнить/);
    const p = f.store.state.proposals[0], c = f.ctx();
    assert.match(f.messages[0].extra.reply_markup.inline_keyboard[0][0].callback_data, new RegExp(p.id));
    f.restart();
    const results = await Promise.all([f.service.respond(c, p.id, true), f.service.respond(c, p.id, true)]);
    assert.ok(results.some(r => r.status === 'created'));
    assert.equal(f.saved.size, 1); assert.equal(f.scheduled.length, 1);
    assert.equal(f.saved.get(p.id)!.chatId, owner); assert.equal(f.saved.get(p.id)!.targetChat, undefined);
    assert.equal(new Date(f.saved.get(p.id)!.dueDate).toISOString(), p.remindAt);
    f.restart(); assert.equal((await f.service.respond(c, p.id, true)).status, 'already_created');
    assert.equal(f.scheduled.length, 1);
});

test('decline, expiry, wrong owner/chat/card and malformed callbacks never create a reminder', async t => {
    const f = fixture(t); await f.offer(); const p = f.store.state.proposals[0];
    for (const mutate of [(c: any) => { c.from.id++; }, (c: any) => { c.chat.id++; },
        (c: any) => { c.chat.type = 'group'; }, (c: any) => { c.callbackQuery.message.message_id++; }]) {
        const c = f.ctx(); mutate(c); assert.equal((await f.service.respond(c, p.id, true)).status, 'unavailable');
    }
    assert.equal((await f.service.respond(f.ctx(), p.id, false)).status, 'rejected');
    f.restart(); await f.offer(); assert.equal(f.messages.length, 1);
    assert.equal((await f.service.respond(f.ctx(), p.id, true)).status, 'rejected');
    f.time(16 * 60_000); await f.offer(20, 'Вернуть учебную книгу');
    f.time(86400_000); assert.equal((await f.service.respond(f.ctx(), f.store.state.proposals[1].id, true)).status, 'expired');
    let answers = 0;
    const c = { ...f.ctx(), answerCallbackQuery: async () => { answers++; } };
    assert.equal(await handleTelegramReminderProposalCallback(c, 'other:data', f.service), false);
    assert.equal(await handleTelegramReminderProposalCallback(c, 'tgrem:y:bad', f.service), true);
    assert.equal(answers, 1); assert.equal(f.saved.size, 0);
});

test('new messages and edits/deletions prevent stale consent; a later grounded review can keep or replace the proposal', async t => {
    const f = fixture(t); await f.offer(); const original = f.store.state.proposals[0];
    f.newer(true); assert.equal((await f.service.respond(f.ctx(), original.id, true)).status, 'changed'); f.newer(false);
    f.fresh(false); assert.equal((await f.service.respond(f.ctx(), original.id, true)).status, 'changed'); f.fresh(true);
    await f.service.applyReview(f.bot, '601', 'Контакт Альфа', 10, { candidates: [f.candidate()], invalidated: [] });
    assert.equal(f.messages.length, 1); assert.equal(f.store.state.proposals[0].reviewedThroughId, 10);
    const replacement = { ...f.candidate(), remindAt: new Date(Date.parse(original.remindAt) + 3600_000).toISOString() };
    await f.service.applyReview(f.bot, '601', 'Контакт Альфа', 11, { candidates: [replacement], invalidated: [{ anchorMessageId: 1, evidence: [{ messageId: 11, quote: 'На час позже' }] }] });
    assert.equal(f.messages.length, 2); assert.equal(f.store.state.proposals[0].status, 'superseded');
    assert.equal((await f.service.respond(f.ctx(original), original.id, true)).status, 'expired');
    const current = f.store.state.proposals[1];
    assert.equal((await f.service.respond(f.ctx(), current.id, true)).status, 'created');
    assert.equal(f.saved.get(current.id)!.dueDate.toISOString(), replacement.remindAt);
});

test('disabled background, cooldown, day cap and uncertain delivery do not spam or mutate reminders', async t => {
    const f = fixture(t); f.enabled(false); await f.offer(); assert.equal(f.messages.length, 0);
    f.enabled(true); await f.offer(); await f.offer(); await f.offer(20, 'Вернуть учебную книгу'); assert.equal(f.messages.length, 1);
    for (const anchor of [20, 40, 60]) { f.time(16 * 60_000); await f.offer(anchor, `Синтетическое действие ${anchor}`); }
    assert.equal(f.messages.length, 3); assert.equal(f.saved.size, 0);
    f.enabled(false); assert.equal((await f.service.respond(f.ctx(f.store.state.proposals[0]), f.store.state.proposals[0].id, true)).status, 'created', 'manual consent remains available during the AI background pause');
    f.enabled(true); f.time(13 * 3600_000); await f.offer(80, 'Новое синтетическое действие');
    assert.equal(f.messages.length, 4, 'The day cap resets in the owner time zone');
    const g = fixture(t); g.sendError(); await g.offer(); g.restart(); await g.offer();
    assert.equal(g.store.state.proposals[0].status, 'delivery_unknown'); assert.equal(g.saved.size, 0);
});

test('strict storage failures and creation uncertainty never report success or repeat the mutation', async t => {
    const f = fixture(t); f.store.failWrite = true;
    await assert.rejects(f.offer()); assert.equal(f.messages.length, 0);
    f.store.failWrite = false; await f.offer(); const p = f.store.state.proposals[0];
    f.store.failRead = true; await assert.rejects(f.service.respond(f.ctx(), p.id, true)); assert.equal(f.saved.size, 0);
    f.store.failRead = false;
    const service = new TelegramReminderProposals(f.store, { verifyFresh: async () => true, newerMessages: () => false,
        find: async id => f.saved.get(id), create: async (_ctx, proposal) => {
            f.saved.set(proposal.id, { id: proposal.id, chatId: owner, text: proposal.text, dueDate: new Date(proposal.remindAt) } as Reminder);
            throw Error('Synthetic lost acknowledgement');
        } });
    assert.equal((await service.respond(f.ctx(), p.id, true)).status, 'unknown');
    assert.equal(f.store.state.proposals[0].status, 'creating');
    f.restart(); assert.equal((await f.service.respond(f.ctx(), p.id, true)).status, 'already_created');
    assert.equal(f.saved.size, 1); assert.equal(f.scheduled.length, 0);
});

test('grounding rejects invented IDs/quotes, forwarded-only, past, uncertain and context-only claims', () => {
    const now = Date.now(), messages: ReminderSourceMessage[] = [
        { messageId: 1, text: 'Возьми учебный макет завтра утром', date: new Date(now), isOwn: false, senderName: 'Контакт Альфа' },
        { messageId: 2, text: 'Да', date: new Date(now), isOwn: true, senderName: 'Я' },
    ];
    const good: TelegramReminderCandidate = { anchorMessageId: 1, text: 'Взять учебный макет', remindAt: new Date(now + 86400_000).toISOString(),
        timing: 'suggested', confidence: .95, ownerRelevance: 'agreement', evidence: [{ messageId: 1, quote: 'учебный макет' }, { messageId: 2, quote: 'Да' }] };
    const normalize = (c: any, source = messages, fresh = new Set([2])) => normalizeReminderReview({ candidates: [c] }, source, fresh, now).candidates;
    assert.equal(normalize(good).length, 1);
    const caseOnly = normalize({ ...good, evidence: [{ messageId: 1, quote: 'Учебный макет' }, { messageId: 2, quote: 'ДА' }] });
    assert.deepEqual(caseOnly[0].evidence, [{ messageId: 1, quote: 'учебный макет' }, { messageId: 2, quote: 'Да' }]);
    for (const change of [{ confidence: .4 }, { remindAt: new Date(now - 1).toISOString() }, { remindAt: 'завтра в восемь' },
        { anchorMessageId: 999 }, { evidence: [{ messageId: 1, quote: 'выдуманная цитата' }] }, { evidence: [{ messageId: 1, quote: 'учебный макет' }] }]) {
        assert.deepEqual(normalize({ ...good, ...change }), []);
    }
    assert.deepEqual(normalize(good, messages, new Set([999])), []);
    assert.deepEqual(normalize(good, messages.map(m => ({ ...m, isForwarded: true }))), []);
    assert.deepEqual(normalize({ ...good, anchorMessageId: -1, evidence: [{ messageId: -1, quote: 'учебный макет' }] },
        [{ ...messages[0], messageId: -1 }], new Set([-1])), []);
});
