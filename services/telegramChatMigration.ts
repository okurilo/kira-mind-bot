import { InputFile, type Api, type Bot } from 'grammy';
import type { BotContext } from '../types';
import { AppDataSource } from '../data-source';
import type { DataSource } from 'typeorm';
import { getActiveBotProfile, scopedBotKey } from '../utils/botIdentity';

const PREFIX = 'telegram:chat-migration:';
const MAX_HOPS = 8;
export function telegramGroupId(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const text = String(value);
    const id = Number(text);
    if (/^-[1-9]\d*$/.test(text) && Number.isSafeInteger(id) && String(id) === text) return text;
}
export interface ChatMigrationStore {
    read(from: string): Promise<string | undefined>;
    /** Atomic, profile-scoped and cycle rejecting. Historical message IDs must never be rewritten. */
    save(from: string, to: string): Promise<void>;
}
export class PgChatMigrationStore implements ChatMigrationStore {
    constructor(private source: DataSource = AppDataSource) {}
    async read(from: string) {
        if (!this.source.isInitialized) return;
        const [row] = await this.source.query('SELECT value FROM bot_settings WHERE key=$1', [scopedBotKey(PREFIX + from)]);
        if (!row) return;
        const next = telegramGroupId(row.value);
        if (!next) throw Error('invalid_stored_chat_migration');
        return next;
    }
    async save(from: string, to: string): Promise<void> {
        if (!telegramGroupId(from) || !telegramGroupId(to) || from === to) throw Error('invalid_chat_migration');
        await this.source.transaction(async manager => {
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopedBotKey(PREFIX)]);
            const seen = new Set([from]); let current = to;
            for (let i = 1; i < MAX_HOPS; i++) {
                if (seen.has(current)) throw Error('cyclic_chat_migration');
                seen.add(current);
                const [row] = await manager.query('SELECT value FROM bot_settings WHERE key=$1', [scopedBotKey(PREFIX + current)]);
                if (!row) break;
                const next = telegramGroupId(row.value); if (!next) throw Error('invalid_stored_chat_migration');
                current = next;
                if (i === MAX_HOPS - 1) throw Error('chat_migration_chain_too_long');
            }
            const [existing] = await manager.query('SELECT value FROM bot_settings WHERE key=$1', [scopedBotKey(PREFIX + from)]);
            if (existing && existing.value !== to) throw Error('conflicting_chat_migration');
            await manager.query('INSERT INTO bot_settings(key,value,"updatedAt") VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,"updatedAt"=now()', [scopedBotKey(PREFIX + from), to]);
            // Keep an already registered destination's explicit policy. Otherwise transfer this same group's policy.
            // The old registry row remains historical evidence; messages/sessions/cursors are not renamed.
            await manager.query(`INSERT INTO chats("chatId",title,"chatType",username,profile,"publicMode","allowedDomains","forbiddenTopics","firstSeenAt","lastSeenAt")
                SELECT $2,title,'supergroup',NULL,profile,"publicMode","allowedDomains","forbiddenTopics","firstSeenAt",now()
                FROM chats WHERE "chatId"=$1 AND profile=$3 ON CONFLICT("chatId",profile) DO NOTHING`, [from, to, getActiveBotProfile()]);
        });
    }
}

export class TelegramChatMigrations {
    private cache = new Map<string, { to?: string; until: number }>();
    constructor(private store: ChatMigrationStore = new PgChatMigrationStore(), private now = Date.now) {}
    async resolve(value: string | number): Promise<string> {
        const original = String(value), start = telegramGroupId(value);
        if (!start) return original;
        const seen = new Set<string>(); let current = start;
        for (let i = 0; i < MAX_HOPS; i++) {
            if (seen.has(current)) throw Error('cyclic_chat_migration'); seen.add(current);
            const key = scopedBotKey(current), cached = this.cache.get(key);
            let next: string | undefined;
            if (cached && cached.until > this.now()) next = cached.to;
            else { next = await this.store.read(current); this.cache.set(key, { to: next, until: this.now() + 5000 }); }
            if (!next) return current;
            if (!telegramGroupId(next)) throw Error('invalid_stored_chat_migration');
            current = next;
        }
        throw Error('chat_migration_chain_too_long');
    }
    async record(from: unknown, to: unknown): Promise<boolean> {
        const old = telegramGroupId(from), next = telegramGroupId(to);
        if (!old || !next || old === next) return false;
        await this.store.save(old, next);
        this.cache.set(scopedBotKey(old), { to: next, until: this.now() + 5000 });
        return true;
    }
}
export const telegramChatMigrations = new TelegramChatMigrations();

/** Only new deliveries and chat metadata. A message_id from the old group does not identify a new-group message. */
function canRedirect(method: string, body: Record<string, unknown>): boolean {
    if (body.reply_parameters || body.reply_to_message_id || body.message_thread_id || body.direct_messages_topic_id) return false;
    return method.startsWith('send') || ['copyMessage', 'copyMessages', 'forwardMessage', 'forwardMessages',
        'getChat', 'getChatMember', 'getChatAdministrators', 'getChatMemberCount'].includes(method);
}
function containsUpload(value: unknown, seen = new Set<unknown>()): boolean {
    if (value instanceof InputFile) return true;
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(child => containsUpload(child, seen));
}
export function installTelegramChatMigration(api: Api, migrations = telegramChatMigrations): void {
    api.config.use(async (previous, method, payload, signal) => {
        const body = payload as Record<string, unknown>;
        const old = telegramGroupId(body.chat_id);
        if (!old) return previous(method, payload, signal);
        const redirect = canRedirect(method, body);
        let target = old;
        if (redirect) {
            try { target = await migrations.resolve(old); } catch { console.warn('[telegram-migration] Не удалось прочитать адрес чата'); }
        }
        const resolved = target === old ? payload : { ...body, chat_id: target };
        const response = await previous(method, resolved as typeof payload, signal);
        const next = !response.ok && response.error_code === 400 ? telegramGroupId(response.parameters?.migrate_to_chat_id) : undefined;
        if (!next || next === target || next === old) return response;
        try { await migrations.record(target, next); }
        catch { console.warn('[telegram-migration] Не удалось сохранить новый адрес чата'); }
        // An old message/thread reference must not be applied to a different message ID namespace.
        // Uploaded streams may already be consumed. Persist the new address for a future fresh operation.
        if (!redirect || containsUpload(body)) return response;
        // Telegram explicitly refused the first request. Exactly one retry; network/5xx/429 never enter here.
        return previous(method, { ...body, chat_id: next } as typeof payload, signal);
    });
}

/** Service messages must be handled before the group mention/auth filters. */
export function registerTelegramChatMigration(bot: Bot<BotContext>, migrations = telegramChatMigrations): void {
    installTelegramChatMigration(bot.api, migrations);
    bot.use(async (ctx, next) => {
        const message = ctx.message;
        const to = message?.chat.type === 'group' ? message.migrate_to_chat_id : undefined;
        const from = message?.chat.type === 'supergroup' ? message.migrate_from_chat_id : undefined;
        if (to === undefined && from === undefined) return next();
        try { await migrations.record(from ?? message!.chat.id, to ?? message!.chat.id); }
        catch { console.warn('[telegram-migration] Не удалось сохранить миграцию из служебного сообщения'); }
    });
}
