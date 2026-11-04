import { randomUUID } from 'node:crypto';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { config } from '../config';
import type { BotContext } from '../types';
import type { Reminder } from '../reminder';
import { ReminderRepository } from './ReminderRepository';
import { reminderService } from './ReminderService';
import { isBackgroundFeatureEnabled } from './backgroundFeatureService';
import { scopedBotKey } from '../utils/botIdentity';
import { isValidRuntimeOwnerId } from '../utils/runtimeIdentity';
import { getZonedDateKey } from '../utils/time';
import { USER_TIMEZONE } from '../constants';
import { MessageStore } from '../stores/MessageStore';
import { heading, paragraph, esc, sendStructured, editStructured } from '../utils/richMessage';
import type { TelegramReminderCandidate, TelegramReminderReview } from '../ai/telegramReminderReview';

type Status = 'delivering' | 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired' | 'creating' | 'delivery_unknown';
export interface TelegramReminderProposal {
    id: string;
    chatId: string;
    chatTitle: string;
    anchorMessageId: number;
    text: string;
    remindAt: string;
    timing: TelegramReminderCandidate['timing'];
    sourceEvidence: TelegramReminderCandidate['evidence'];
    reviewedThroughId: number;
    createdAt: number;
    expiresAt: number;
    status: Status;
    ownerId: number;
    messageId?: number;
}
export interface TelegramReminderProposalState { version: 1; proposals: TelegramReminderProposal[]; sentAt: number[] }
export interface TelegramReminderProposalStore {
    read(): Promise<TelegramReminderProposalState>;
    update<T>(work: (state: TelegramReminderProposalState) => T): Promise<T>;
}
const empty = (): TelegramReminderProposalState => ({ version: 1, proposals: [], sentAt: [] });
const statuses: Status[] = ['delivering', 'pending', 'accepted', 'rejected', 'superseded', 'expired', 'creating', 'delivery_unknown'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function parse(raw?: string): TelegramReminderProposalState {
    if (raw === undefined) return empty();
    const state = JSON.parse(raw) as TelegramReminderProposalState;
    if (state.version !== 1 || !Array.isArray(state.proposals) || state.proposals.length > 200 || !Array.isArray(state.sentAt)
        || state.sentAt.some(at => !Number.isFinite(at)) || state.proposals.some(p => !uuid.test(p.id) || !statuses.includes(p.status)
            || typeof p.chatId !== 'string' || typeof p.chatTitle !== 'string' || typeof p.text !== 'string' || !p.text.trim()
            || !Number.isFinite(Date.parse(p.remindAt)) || !Number.isSafeInteger(p.anchorMessageId) || !Number.isSafeInteger(p.reviewedThroughId)
            || !Number.isSafeInteger(p.ownerId) || !Number.isFinite(p.createdAt) || !Number.isFinite(p.expiresAt)
            || !Array.isArray(p.sourceEvidence) || !p.sourceEvidence.length || p.sourceEvidence.some(e => !Number.isSafeInteger(e.messageId) || typeof e.quote !== 'string')
            || !['explicit', 'suggested'].includes(p.timing))) throw Error('Invalid Telegram reminder proposal state');
    return state;
}
/** Strict, durable receipt. No default-on-error settings cache and no session overwrite. */
export class BotSettingsTelegramReminderStore implements TelegramReminderProposalStore {
    constructor(private readonly database = AppDataSource, private readonly key = () => scopedBotKey(`telegram-reminder-proposals:v1:${config.allowedUserId}`)) {}
    async read() {
        return parse((await this.database.getRepository(BotSettingEntity).findOneBy({ key: this.key() }))?.value);
    }
    async update<T>(work: (state: TelegramReminderProposalState) => T): Promise<T> {
        return this.database.transaction(async manager => {
            const key = this.key();
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
            const repo = manager.getRepository(BotSettingEntity);
            const state = parse((await repo.findOneBy({ key }))?.value);
            const result = work(state);
            await repo.upsert({ key, value: JSON.stringify(state) }, ['key']);
            return result;
        });
    }
}
function when(iso: string): string {
    return new Date(iso).toLocaleString('ru-RU', { timeZone: USER_TIMEZONE, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
}
function blocks(p: TelegramReminderProposal) {
    return [heading('⏰ Предложение напоминания', 3), paragraph(`В переписке с <b>${esc(p.chatTitle)}</b> заметила повод напомнить:`),
        paragraph(`<b>${esc(p.text)}</b>`), paragraph(`${p.timing === 'suggested' ? 'Предлагаю напомнить' : 'Напомнить'}: <b>${esc(when(p.remindAt))}</b> (${esc(USER_TIMEZONE)}).`),
        paragraph('Создать это напоминание?')];
}
export interface TelegramReminderProposalDependencies {
    now(): number;
    enabled(): Promise<boolean>;
    newerMessages(chatId: string, throughId: number): boolean;
    verifyFresh(proposal: TelegramReminderProposal): Promise<boolean>;
    create(ctx: BotContext, proposal: TelegramReminderProposal): Promise<Reminder>;
    find(id: string): Promise<Reminder | undefined>;
}
const defaults: TelegramReminderProposalDependencies = {
    now: Date.now,
    enabled: () => isBackgroundFeatureEnabled('reflection'),
    newerMessages: (chat, id) => MessageStore.getInstance().getMessages(chat).some(m => !m.isBot && m.id > id),
    verifyFresh: async p => {
        const { initTelegramClient } = await import('./telegram');
        const client = await initTelegramClient({ preloadContacts: false });
        if (!client || !/^\d+$/.test(p.chatId) || !Number.isSafeInteger(Number(p.chatId))) return false;
        // Read-only Telegram requests; they never mark the conversation as read.
        const [latest, sources] = await Promise.all([client.getMessages(Number(p.chatId), { limit: 1 }),
            client.getMessages(Number(p.chatId), { ids: p.sourceEvidence.map(e => e.messageId) })]);
        return latest.length > 0 && latest[0].id <= p.reviewedThroughId && p.sourceEvidence.every(e =>
            sources.some(m => m.id === e.messageId && !m.fwdFrom && typeof m.message === 'string' && m.message.includes(e.quote)));
    },
    create: (ctx, p) => reminderService.createReminder(ctx, { id: p.id, text: p.text, reminderMessage: p.text, dueDate: new Date(p.remindAt) }),
    find: id => ReminderRepository.findById(id),
};
export type ProposalResolution = { status: 'created' | 'already_created' | 'rejected' | 'expired' | 'changed' | 'unavailable' | 'unknown'; proposal?: TelegramReminderProposal };

export class TelegramReminderProposals {
    private readonly deps: TelegramReminderProposalDependencies;
    constructor(private readonly store: TelegramReminderProposalStore = new BotSettingsTelegramReminderStore(), deps: Partial<TelegramReminderProposalDependencies> = {}) {
        this.deps = { ...defaults, ...deps };
    }
    async context(chatId: string) {
        const state = await this.store.read();
        return state.proposals.filter(p => p.chatId === chatId && p.createdAt > this.deps.now() - 86400_000).slice(-5)
            .map(({ anchorMessageId, text, remindAt, status }) => ({ anchorMessageId, text, remindAt, status }));
    }
    /** Called with grounded output of the existing reflection prescreen, never a per-message model call. */
    async applyReview(bot: Bot<BotContext>, chatId: string, chatTitle: string, reviewedThroughId: number, review: TelegramReminderReview): Promise<void> {
        if (!await this.deps.enabled() || !isValidRuntimeOwnerId(config.allowedUserId)) return;
        const now = this.deps.now();
        const deliver = await this.store.update(state => {
            state.proposals = state.proposals.filter(p => now - p.createdAt < 95 * 86400_000);
            state.sentAt = state.sentAt.filter(at => now - at < 86400_000);
            for (const p of state.proposals) {
                if (p.status === 'pending' && p.expiresAt <= now) p.status = 'expired';
                if (p.chatId === chatId && p.status === 'pending' && review.invalidated.some(item => item.anchorMessageId === p.anchorMessageId)) p.status = 'superseded';
            }
            const fresh: TelegramReminderProposal[] = [];
            for (const c of review.candidates) {
                const previous = state.proposals.filter(p => p.chatId === chatId && p.anchorMessageId === c.anchorMessageId);
                if (previous.some(p => ['accepted', 'rejected', 'creating', 'delivery_unknown', 'delivering'].includes(p.status))) continue;
                const pending = previous.find(p => p.status === 'pending');
                if (pending) {
                    if (pending.text === c.text && pending.remindAt === c.remindAt) pending.reviewedThroughId = reviewedThroughId;
                    // A changed candidate needs an explicit invalidation; never silently rewrite consent.
                    continue;
                }
                const duplicate = state.proposals.some(p => p.chatId === chatId && p.text.toLocaleLowerCase() === c.text.toLocaleLowerCase()
                    && p.remindAt === c.remindAt && !['superseded', 'expired'].includes(p.status));
                if (duplicate || state.proposals.length >= 200) continue;
                const sentToday = state.sentAt.filter(at => getZonedDateKey(new Date(at)) === getZonedDateKey(new Date(now))).length;
                const replacement = previous.some(p => p.status === 'superseded');
                if (sentToday >= 3 || !replacement && state.sentAt.some(at => now - at < 15 * 60_000)) continue;
                const expiresAt = Math.min(Date.parse(c.remindAt) - 60_000, now + 86400_000);
                if (expiresAt <= now) continue;
                const p: TelegramReminderProposal = { id: randomUUID(), ownerId: config.allowedUserId, chatId, chatTitle: chatTitle.slice(0, 120),
                    anchorMessageId: c.anchorMessageId, text: c.text, remindAt: c.remindAt, timing: c.timing, reviewedThroughId,
                    sourceEvidence: c.evidence,
                    createdAt: now, expiresAt, status: 'delivering' };
                state.proposals.push(p); state.sentAt.push(now); fresh.push({ ...p });
            }
            return fresh;
        });
        for (const p of deliver) {
            try {
                if (!await this.deps.enabled() || this.deps.newerMessages(chatId, reviewedThroughId)) {
                    await this.mark(p.id, 'superseded'); continue;
                }
                const sent = await sendStructured(bot.api as any, p.ownerId, blocks(p), { replyMarkup: new InlineKeyboard()
                    .text('⏰ Да, создать', `tgrem:y:${p.id}`).text('Не нужно', `tgrem:n:${p.id}`) }) as any;
                if (!Number.isSafeInteger(sent?.message_id)) throw Error('Missing proposal delivery receipt');
                await this.store.update(state => {
                    const current = state.proposals.find(item => item.id === p.id)!;
                    current.status = 'pending'; current.messageId = sent.message_id;
                });
            } catch {
                // Unknown delivery must not cause duplicate notifications on the next batch/restart.
                await this.mark(p.id, 'delivery_unknown').catch(() => {});
            }
        }
    }
    private async mark(id: string, status: Status) {
        await this.store.update(state => { const p = state.proposals.find(item => item.id === id); if (p) p.status = status; });
    }
    async respond(ctx: BotContext, id: string, accept: boolean): Promise<ProposalResolution> {
        const snapshot = (await this.store.read()).proposals.find(p => p.id === id);
        if (!snapshot || ctx.from?.id !== snapshot.ownerId || ctx.chat?.id !== snapshot.ownerId || ctx.chat.type !== 'private'
            || snapshot.ownerId !== config.allowedUserId || ctx.callbackQuery?.message?.message_id !== snapshot.messageId) return { status: 'unavailable' };
        // Verify edits/deletions and missed updates after a restart before accepting.
        const fresh = !accept || snapshot.status !== 'pending' || await this.deps.verifyFresh(snapshot).catch(() => false);
        const claim = await this.store.update(state => {
            const p = state.proposals.find(item => item.id === id);
            if (!p || ctx.from?.id !== p.ownerId || ctx.chat?.id !== p.ownerId || ctx.chat.type !== 'private'
                || p.ownerId !== config.allowedUserId || ctx.callbackQuery?.message?.message_id !== p.messageId) return { status: 'unavailable' as const };
            if (p.status === 'accepted') return { status: 'already_created' as const, proposal: { ...p } };
            if (p.status === 'creating') return { status: 'recover' as const, proposal: { ...p } };
            if (p.status === 'rejected') return { status: 'rejected' as const, proposal: { ...p } };
            if (p.status !== 'pending' || this.deps.now() >= p.expiresAt || Date.parse(p.remindAt) <= this.deps.now()) {
                if (p.status === 'pending') p.status = 'expired';
                return { status: 'expired' as const, proposal: { ...p } };
            }
            if (!accept) { p.status = 'rejected'; return { status: 'rejected' as const, proposal: { ...p } }; }
            if (!fresh || this.deps.newerMessages(p.chatId, p.reviewedThroughId)) return { status: 'changed' as const, proposal: { ...p } };
            p.status = 'creating';
            return { status: 'create' as const, proposal: { ...p } };
        });
        if (claim.status !== 'create' && claim.status !== 'recover') return claim;
        const p = claim.proposal;
        try {
            const existing = await this.deps.find(p.id);
            if (claim.status === 'recover' && !existing) return { status: 'unknown', proposal: p };
            if (existing && (existing.chatId !== p.ownerId || existing.text !== p.text || new Date(existing.dueDate).getTime() !== Date.parse(p.remindAt))) return { status: 'unknown', proposal: p };
            if (!existing) await this.deps.create(ctx, p);
            await this.mark(p.id, 'accepted');
            return { status: existing ? 'already_created' : 'created', proposal: p };
        } catch { return { status: 'unknown', proposal: p }; }
    }
}
export const telegramReminderProposals = new TelegramReminderProposals();

export async function handleTelegramReminderProposalCallback(ctx: BotContext, data: string, service = telegramReminderProposals): Promise<boolean> {
    if (!data.startsWith('tgrem:')) return false;
    if (ctx.from?.id !== config.allowedUserId || ctx.chat?.id !== config.allowedUserId || ctx.chat.type !== 'private') {
        await ctx.answerCallbackQuery({ text: 'Предложение доступно только владельцу в личном чате.' }); return true;
    }
    const match = data.match(/^tgrem:([yn]):([a-f0-9-]{36})$/);
    if (!match || !uuid.test(match[2])) { await ctx.answerCallbackQuery({ text: 'Предложение недоступно.' }); return true; }
    await ctx.answerCallbackQuery();
    let result: ProposalResolution;
    try { result = await service.respond(ctx, match[2], match[1] === 'y'); }
    catch { await ctx.reply('Не удалось проверить предложение. Попробуй ещё раз позже.'); return true; }
    if (result.status === 'changed' || result.status === 'unknown' || result.status === 'unavailable') {
        await ctx.reply(result.status === 'changed' ? 'В переписке появились новые сообщения. Сначала нужно проверить, не изменилась ли договорённость.'
            : result.status === 'unknown' ? 'Не удалось подтвердить создание напоминания. Проверь список напоминаний: автоматически повторять создание не буду.' : 'Это предложение недоступно.');
        return true;
    }
    const p = result.proposal;
    const text = result.status === 'expired' ? 'Предложение устарело. Напоминание по этой кнопке не создаётся.'
        : result.status === 'rejected' ? 'Хорошо, напоминание не создаю.'
        : `✅ Напоминание ${result.status === 'already_created' ? 'уже создано' : 'создано'}: <b>${esc(p!.text)}</b><br/>${esc(when(p!.remindAt))} (${esc(USER_TIMEZONE)}).`;
    await editStructured(ctx.api as any, ctx.chat.id, ctx.callbackQuery!.message!.message_id, [paragraph(text)], { replyMarkup: new InlineKeyboard() }).catch(() => {});
    return true;
}
