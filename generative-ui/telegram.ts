import type { Bot, Api } from 'grammy';
import type { InlineKeyboardMarkup, Message, User, Chat } from 'grammy/types';
import type { BotContext } from '../types';
import type { ProcessingResult } from '../orchestrator';
import type { ApiMessage, ApiButton } from '../api/contracts';
import { config } from '../config';
import { composeUi, type UiCompletion } from './compose';
import { UI_CATALOG_V2, type UiInput } from './contracts';
import { submissionText, type UiSubmission } from './forms';
import { PgUiStore, type UiStore, type UiTransaction } from './store';
import { renderTelegramWidget, widgetValue, type WidgetState } from './telegramRender';

export const TELEGRAM_WIDGET_TTL_MS = 15 * 60_000;
export function telegramWidgetsEnabled() { return process.env.KIRA_TELEGRAM_WIDGETS_ENABLED !== 'false'; }
/** Explicit subscription is required even on grammY versions predating Bot API 10.4. */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction', 'message_reaction_count', 'widget_query'];

// Narrow raw API adapter: grammY's Proxy/transformers already support methods added after its typings.
export interface WidgetApi {
    sendWidget(payload: { chat_id: number; html: string; caption: string; allow_queries: boolean; protect_content: true; reply_parameters: { message_id: number; allow_sending_without_reply: true }; chat_data: string }, signal?: AbortSignal): Promise<Message>;
    answerWidgetQuery(payload: { widget_query_id: string; data: string }, signal?: AbortSignal): Promise<true>;
    editMessageWidgetData(payload: { chat_id: number; message_id: number; chat_data: string }, signal?: AbortSignal): Promise<true>;
}
const raw = (api: Api) => api.raw as unknown as WidgetApi;
interface WidgetQuery {
    id: string; from: User; chat?: Chat; message_id?: number; inline_message_id?: string; widget_id?: string;
    chat_instance: string; type: { type: string }; data: string;
}
type Action = { kind: 'reply'; text: string } | { kind: 'callback'; data: string } | { kind: 'submit'; submission: UiSubmission };
interface Card {
    turn: string; sourceId: number; sourceText: string; keyboard?: InlineKeyboardMarkup;
    actions: Action[]; allowed: number[]; fields: UiInput[]; state: WidgetState; expires: number;
}
export interface WidgetDispatch { action: { kind: 'reply'; text: string } | { kind: 'callback'; data: string }; sourceId: number; sourceText: string; keyboard?: InlineKeyboardMarkup; turn: string }
interface QueryResult { state?: WidgetState; error?: string; dispatch?: WidgetDispatch; changed?: true }

/** Separate Telegram presentation receipts; canonical identity, session and turn marker remain authoritative. */
export class TelegramUiService {
    constructor(private store: UiStore = new PgUiStore(undefined, 'telegram'), private complete?: UiCompletion, private now = Date.now) {}
    private async current(tx: UiTransaction, turn: string) { return !!turn && await tx.dialogueTurn?.() === turn; }

    /** Legacy callback toasts become visible widget status after the query has already been acknowledged. */
    async notice(owner: number, messageId: number, text: string): Promise<WidgetState | undefined> {
        return this.store.transact(owner, async tx => {
            const card = await tx.get<Card>('cards', String(messageId));
            if (!card?.state.done || card.expires <= this.now() || !await this.current(tx, card.turn)) return;
            const state = { ...card.state, r: card.state.r + 1, n: Array.from(text.replace(/\0/g, '').trim()).slice(0, 160).join('') };
            if (Buffer.byteLength(JSON.stringify(state)) > 1024) return;
            await tx.put('cards', String(messageId), { ...card, state }); return state;
        });
    }

    async deliver(owner: number, api: WidgetApi, request: string, answer: string, sourceId: number,
                  keyboard?: InlineKeyboardMarkup, expectedTurn?: string, active: () => Promise<boolean> = async () => true): Promise<Message | undefined> {
        if (!telegramWidgetsEnabled() || !request.trim() || !answer.trim()) return;
        const turn = expectedTurn ?? await this.store.transact(owner, tx => tx.dialogueTurn?.() ?? Promise.resolve(undefined));
        if (!turn || !await active() || !await this.store.transact(owner, tx => this.current(tx, turn))) return;
        const actions: Action[] = [];
        const bind = (action: Action) => { if (actions.length >= 64) throw Error('widget_actions_exhausted'); return `w${actions.push(action) - 1}`; };
        const buttons = keyboard?.inline_keyboard.map(row => row.flatMap<ApiButton>(b => 'callback_data' in b && b.callback_data
            ? [{ text: b.text, actionToken: bind({ kind: 'callback', data: b.callback_data }) }]
            : 'url' in b && b.url ? [{ text: b.text, url: b.url }] : []));
        const message: ApiMessage = { id: sourceId, type: 'text', text: answer, format: 'plain', ...(buttons ? { buttons } : {}) };
        const ui = await composeUi(request, message, text => bind({ kind: 'reply', text }), this.complete, {
            request: { enabled: true, catalogId: UI_CATALOG_V2 },
            submitToken: (text, fields) => bind({ kind: 'submit', submission: { text, fields } }),
        });
        if (!ui || !await active()) return;
        const rendered = renderTelegramWidget(ui);
        if (!rendered) return;
        const allowed = ui.messages[0].createSurface.components.flatMap(c => c.component === 'Button' && 'event' in c.action ? [c.action.event.context.actionToken]
            : c.component === 'Checklist' ? c.items.flatMap(item => item.actionToken ? [item.actionToken] : []) : []).map(token => Number(token.slice(1)));
        const card: Card = { turn, sourceId, sourceText: answer, keyboard, actions, allowed, fields: rendered.fields, state: rendered.state, expires: this.now() + TELEGRAM_WIDGET_TTL_MS };
        // Serialize the single send with the canonical turn. A late composer cannot overtake a new message.
        // No send retry: a transport timeout can mean Telegram has already delivered the widget.
        return this.store.transact(owner, async tx => {
            if (!await this.current(tx, turn) || !await active()) return;
            const sent = await api.sendWidget({ chat_id: owner, html: rendered.html, caption: ui.meta?.title ?? 'Виджет к ответу Киры',
                allow_queries: allowed.length > 0 || rendered.fields.length > 0, protect_content: true,
                reply_parameters: { message_id: sourceId, allow_sending_without_reply: true }, chat_data: JSON.stringify(rendered.state) }, AbortSignal.timeout(8000));
            if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) throw Error('widget_delivery_not_bound');
            await tx.put('cards', String(sent.message_id), card);
            await tx.trim('cards', 128);
            return sent;
        });
    }

    async query(owner: number, query: WidgetQuery): Promise<QueryResult> {
        if (!telegramWidgetsEnabled() || query.from?.id !== owner || query.from.is_bot || query.chat?.type !== 'private'
            || query.chat.id !== owner || !Number.isSafeInteger(query.message_id) || query.message_id! <= 0
            || query.inline_message_id || query.widget_id || query.type?.type !== 'data'
            || typeof query.data !== 'string' || Buffer.byteLength(query.data) > 64 || !query.data.length) return { error: 'Карточка недоступна.' };
        const match = /^(a|f):(\d{1,9}):(\d{1,2})(?::(-?\d{1,16}))?$/.exec(query.data);
        if (!match || match[0] !== query.data || (match[1] === 'f') !== (match[4] !== undefined)) return { error: 'Неизвестная команда.' };
        return this.store.transact(owner, async tx => {
            const card = await tx.get<Card>('cards', String(query.message_id));
            if (!card || card.expires <= this.now() || !await this.current(tx, card.turn)) return { error: 'Карточка устарела. Задай вопрос Кире заново.' };
            const { state } = card;
            if (state.done || Number(match[2]) !== state.r) return { state, error: state.done ? 'Запрос уже принят. Проверь ответ в чате.' : 'Состояние изменилось. Повтори выбор.' };
            const index = Number(match[3]);
            if (match[1] === 'f') {
                const field = card.fields[index], value = Number(match[4]);
                if (!field) return { state, error: 'Поле недоступно.' };
                try { widgetValue(field, value); } catch { return { state, error: 'Значение вне допустимого диапазона.' }; }
                state.v[index] = value; state.r++;
                await tx.put('cards', String(query.message_id), card);
                return { state, changed: true };
            }
            const action = card.actions[index];
            if (!action || !card.allowed.includes(index)) return { state, error: 'Действие недоступно.' };
            let dispatch: WidgetDispatch['action'];
            try {
                if (action.kind === 'submit') {
                    const values = Object.fromEntries(action.submission.fields.map(f => {
                        const slot = card.fields.findIndex(candidate => candidate.id === f.id);
                        return [f.id, widgetValue(f, state.v[slot])];
                    }));
                    dispatch = { kind: 'reply', text: submissionText(action.submission, values) };
                } else dispatch = action;
            } catch { return { state, error: 'Выбери допустимые значения всех полей.' }; }
            // Durable at-most-once receipt before acknowledgement or effects. Unknown outcomes never replay.
            state.done = true; state.r++;
            await tx.put('cards', String(query.message_id), card);
            return { state, changed: true, dispatch: { action: dispatch, sourceId: card.sourceId, sourceText: card.sourceText, keyboard: card.keyboard, turn: card.turn } };
        });
    }
}

export const telegramUi = new TelegramUiService();

/** Install before session/auth middleware: older grammY Context getters do not recognize widget_query. */
export function registerTelegramWidgetBridge(bot: Bot<BotContext>, service = telegramUi, owner = config.allowedUserId): void {
    bot.use(async (ctx, next) => {
        const update = ctx.update as unknown as { widget_query?: WidgetQuery; shared_widget_query?: unknown };
        if (update.shared_widget_query) return;
        const query = update.widget_query;
        if (!query) return next();
        const api = raw(ctx.api);
        let result: QueryResult;
        try { result = await service.query(owner, query); }
        catch { result = { error: 'Хранилище карточек временно недоступно.' }; }
        // Acknowledge before the ordinary handler can perform long-running AI/tools.
        try { await api.answerWidgetQuery({ widget_query_id: query.id, data: JSON.stringify({ state: result.state, error: result.error }) }, AbortSignal.timeout(2500)); }
        catch { return; }
        if (result.changed && result.state && query.chat?.id === owner && query.message_id) {
            await api.editMessageWidgetData({ chat_id: owner, message_id: query.message_id, chat_data: JSON.stringify(result.state) }, AbortSignal.timeout(2500))
                .catch(() => { console.warn('[telegram-ui] Не удалось обновить состояние карточки'); });
        }
        if (!result.dispatch || query.chat?.type !== 'private') return;
        const { action, sourceId, sourceText, keyboard } = result.dispatch;
        ctx.telegramUiTurnId = result.dispatch.turn;
        const date = Math.floor(Date.now() / 1000);
        const source = { message_id: sourceId, date, from: ctx.me, chat: query.chat, text: sourceText, reply_to_message: undefined, ...(keyboard ? { reply_markup: keyboard } : {}) };
        // Preserve the original source message for callback handlers and reply context.
        delete update.widget_query;
        if (action.kind === 'reply') {
            ctx.update.message = { message_id: query.message_id!, date, from: query.from, chat: query.chat, text: action.text, reply_to_message: source };
        } else {
            ctx.update.callback_query = { id: query.id, from: query.from, chat_instance: query.chat_instance, message: source, data: action.data };
            ctx.api.config.use(async (prev, method, payload, signal) => {
                if (method === 'answerCallbackQuery' && (payload as { callback_query_id?: string }).callback_query_id === query.id) {
                    const text = (payload as { text?: string }).text;
                    if (text?.trim()) {
                        await service.notice(owner, query.message_id!, text).then(state => state
                            ? api.editMessageWidgetData({ chat_id: owner, message_id: query.message_id!, chat_data: JSON.stringify(state) }, AbortSignal.timeout(2500)) : undefined)
                            .catch(() => { console.warn('[telegram-ui] Статус действия недоступен'); });
                    }
                    return { ok: true, result: true } as any;
                }
                return prev(method, payload, signal);
            });
        }
        await next();
    });
}

/** The canonical text/voice/file delivery has already succeeded; a visual is an optional attachment. */
export async function deliverTelegramResultWidget(ctx: BotContext, result: ProcessingResult, messageId: number): Promise<void> {
    if (!telegramWidgetsEnabled() || ctx.sessionStorageKey?.startsWith('api:') || ctx.chat?.type !== 'private'
        || ctx.from?.id !== config.allowedUserId || ctx.chat.id !== config.allowedUserId || result.awaitingDeferredResult
        || result.operationStatus === 'failed' || result.operationStatus === 'unknown') return;
    const request = ctx.message?.text ?? ctx.session.messageHistory.find(item => item.role === 'user')?.content;
    const turn = ctx.telegramUiTurnId ?? ctx.dialogueTurnId;
    if (!request || !turn) return;
    try {
        const sent = await telegramUi.deliver(ctx.chat.id, raw(ctx.api), request, result.responseText, messageId, result.keyboard, turn);
        if (sent) {
            // Reply-to-widget resolves to the same grounded answer, without a second history turn.
            (ctx.session.sentMessages ??= {})[sent.message_id] = result.responseText;
            if (ctx.session.sentMessageContexts?.[messageId]) ctx.session.sentMessageContexts[sent.message_id] = { ...ctx.session.sentMessageContexts[messageId], messageId: sent.message_id };
        }
    } catch { console.warn('[telegram-ui] Виджет недоступен; основной ответ доставлен'); }
}
