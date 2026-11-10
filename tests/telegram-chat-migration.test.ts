import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, Bot, InputFile } from 'grammy';
import { ChatMigrationStore, TelegramChatMigrations, installTelegramChatMigration, registerTelegramChatMigration, telegramGroupId, telegramChatMigrations } from '../services/telegramChatMigration';

const OLD = '-420001', NEW = '-100420001', NEXT = '-100420002';
const token = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
class MemoryStore implements ChatMigrationStore {
    values = new Map<string, string>();
    async read(id: string) { return this.values.get(id); }
    async save(from: string, to: string) { this.values.set(from, to); }
}
function fixture(response: (method: string, body: any, index: number) => any, store = new MemoryStore()) {
    const api = new Api(token), calls: { method: string; body: any }[] = [];
    api.config.use(async (_previous, method, body) => { calls.push({ method, body }); return response(method, body, calls.length) as any; });
    const migrations = new TelegramChatMigrations(store);
    installTelegramChatMigration(api, migrations);
    return { api, calls, migrations, store };
}
const migrated = (id: unknown = Number(NEW), code = 400) => ({ ok: false, error_code: code, description: 'Synthetic migration', parameters: { migrate_to_chat_id: id } });
const success = { ok: true, result: { message_id: 50 } };

test('new delivery follows the authoritative migration exactly once and survives transport recreation', async () => {
    const f = fixture((_method, _body, i) => i === 1 ? migrated() : success);
    await f.api.sendMessage(Number(OLD), 'Синтетическое уведомление', { disable_notification: true });
    assert.deepEqual(f.calls.map(c => String(c.body.chat_id)), [OLD, NEW]);
    assert.equal(f.calls[1].body.text, 'Синтетическое уведомление');
    assert.equal(f.calls[1].body.disable_notification, true);
    const restarted = fixture(() => success, f.store);
    await restarted.api.sendMessage(OLD, 'Следующее');
    assert.deepEqual(restarted.calls.map(c => String(c.body.chat_id)), [NEW]);
});

for (const [name, response] of [
    ['ordinary 400', { ok: false, error_code: 400, description: 'Synthetic inaccessible chat' }],
    ['403', migrated(Number(NEW), 403)], ['429', migrated(Number(NEW), 429)], ['500', migrated(Number(NEW), 500)],
    ['same chat', migrated(Number(OLD))], ['positive chat', migrated(123)], ['unsafe number', migrated(-Number.MAX_SAFE_INTEGER - 1)],
] as const) test(`does not retry ${name}`, async () => {
    const f = fixture(() => response);
    await assert.rejects(f.api.sendMessage(OLD, 'Synthetic'));
    assert.equal(f.calls.length, 1); assert.equal(f.store.values.size, 0);
});

test('unknown network outcomes are never retried; a second migration is bounded', async () => {
    const network = fixture(() => { throw Error('synthetic network failure'); });
    await assert.rejects(network.api.sendMessage(OLD, 'Synthetic')); assert.equal(network.calls.length, 1);
    const chain = fixture((_m, _b, i) => migrated(i === 1 ? Number(NEW) : Number(NEXT)));
    await assert.rejects(chain.api.sendMessage(OLD, 'Synthetic')); assert.equal(chain.calls.length, 2);
});

test('a failed alias save does not lose the one safe retry after an explicit refusal', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture((_m, _b, i) => i === 1 ? migrated() : success);
    t.mock.method(f.store, 'save', async () => { throw Error('Synthetic storage outage'); });
    await f.api.sendMessage(OLD, 'Synthetic'); assert.equal(f.calls.length, 2);
});

for (const [method, extra] of [
    ['editMessageText', { message_id: 20, text: 'Synthetic' }], ['deleteMessage', { message_id: 20 }],
    ['pinChatMessage', { message_id: 20 }], ['sendMessage', { text: 'Synthetic', reply_parameters: { message_id: 20 } }],
    ['sendMessage', { text: 'Synthetic', message_thread_id: 20 }],
] as const) test(`preserves old message namespaces for ${method} ${JSON.stringify(extra)}`, async () => {
    const f = fixture(() => migrated());
    await assert.rejects((f.api.raw as any)[method]({ chat_id: OLD, ...extra }));
    assert.equal(f.calls.length, 1); assert.equal(await f.migrations.resolve(OLD), NEW);
    f.calls.length = 0;
    await assert.rejects((f.api.raw as any)[method]({ chat_id: OLD, ...extra }));
    assert.equal(String(f.calls[0].body.chat_id), OLD); assert.equal(f.calls.length, 1);
});

test('copy and forward move only the destination, preserving source message references', async () => {
    for (const method of ['copyMessage', 'forwardMessage', 'copyMessages', 'forwardMessages']) {
        const f = fixture((_m, _b, i) => i === 1 ? migrated() : success);
        await (f.api.raw as any)[method]({ chat_id: OLD, from_chat_id: OLD, message_id: 15, message_ids: [15, 16] });
        assert.equal(f.calls[1].body.chat_id, NEW); assert.equal(f.calls[1].body.from_chat_id, OLD);
        assert.deepEqual(f.calls[1].body.message_ids, [15, 16]); assert.equal(f.calls[1].body.message_id, 15);
    }
});

test('uploads are not replayed after refusal; a fresh upload can use the persisted address', async () => {
    const f = fixture(() => migrated()), photo = new InputFile(Buffer.from('synthetic'));
    await assert.rejects(f.api.sendPhoto(OLD, photo)); assert.equal(f.calls.length, 1);
    const restarted = fixture(() => success, f.store);
    await restarted.api.sendPhoto(OLD, photo);
    assert.equal(restarted.calls[0].body.chat_id, NEW); assert.equal(restarted.calls[0].body.photo, photo);
});

test('service updates are consumed before downstream group filters, including updates without from', async () => {
    const migrations = new TelegramChatMigrations(new MemoryStore());
    const bot = new Bot<any>(token, { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
    registerTelegramChatMigration(bot, migrations);
    let downstream = 0; bot.use(() => { downstream++; });
    const message = { message_id: 1, date: 1, chat: { id: Number(OLD), type: 'group', title: 'Synthetic' }, migrate_to_chat_id: Number(NEW) };
    await bot.handleUpdate({ update_id: 1, message } as any);
    await bot.handleUpdate({ update_id: 2, message: { ...message, chat: { ...message.chat, id: Number(NEW), type: 'supergroup' }, migrate_to_chat_id: undefined, migrate_from_chat_id: Number(OLD) } } as any);
    assert.equal(await migrations.resolve(OLD), NEW); assert.equal(downstream, 0);
    await bot.handleUpdate({ update_id: 3, message: { ...message, migrate_to_chat_id: undefined, text: 'Synthetic' } } as any);
    await bot.handleUpdate({ update_id: 4, message: { ...message, chat: { ...message.chat, type: 'private' } } } as any);
    assert.equal(downstream, 2);
});

test('group IDs, bounded aliases and cache expiration reject corrupt state', async () => {
    for (const value of ['@synthetic', '1', 0, '-01', '-1.5', {}, '-9007199254740992']) assert.equal(telegramGroupId(value), undefined);
    const store = new MemoryStore(); let now = 1;
    const service = new TelegramChatMigrations(store, () => now);
    assert.equal(await service.resolve(OLD), OLD);
    await store.save(OLD, NEW); now += 5001;
    assert.equal(await service.resolve(OLD), NEW);
    await store.save(NEW, OLD); now += 5001;
    await assert.rejects(service.resolve(OLD), /cyclic/);
    assert.equal(await service.record(OLD, OLD), false); assert.equal(await service.resolve('@synthetic'), '@synthetic');
});

test('watcher polling delivers to the upgraded group and persists the new target without changing source cursors', async t => {
    const settings = require('../services/botSettingsService');
    const background = require('../services/backgroundFeatureService');
    const telegram = require('../services/telegram');
    const ai = require('../ai/chatCompletion');
    const policy = require('../ai/accountPolicy');
    const watchers = require('../services/chatPromptWatchers');
    const watcher = { id: 'synthetic-migration', sourceChatId: '-100810001', targetChatId: OLD, prompt: 'Уведомляй о новой заявке', enabled: true, createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date().toISOString(), lastReadMessageId: 30 };
    let raw = JSON.stringify([watcher]), analyses = 0, reads = 0;
    t.mock.method(settings, 'getSetting', async () => raw);
    t.mock.method(settings, 'setSetting', async (_key: string, value: string) => { raw = value; });
    t.mock.method(background, 'isBackgroundFeatureEnabled', async () => true);
    t.mock.method(policy, 'withBackgroundAiTask', async (_a: any, _b: any, fn: any) => fn());
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getMessages: async (source: any, options: any) => {
        reads++; assert.equal(String(source), watcher.sourceChatId); assert.equal(options.minId, 30);
        return [{ id: 31, message: 'Синтетическая новая заявка', date: Math.floor(Date.now() / 1000), senderId: 81001 }];
    } }));
    t.mock.method(ai, 'createJsonChatCompletionForTask', async () => { analyses++; return { match: true, shouldNotify: true, confidence: 0.95, summary: 'Синтетическая заявка' }; });
    const f = fixture((_m, _b, i) => i === 1 ? migrated() : success);
    t.mock.method(telegramChatMigrations, 'resolve', (value: string | number) => f.migrations.resolve(value));
    await watchers.runOnePoll(f.api);
    assert.equal(reads, 1); assert.equal(analyses, 1);
    assert.deepEqual(f.calls.map(c => String(c.body.chat_id)), [OLD, NEW]);
    const saved = JSON.parse(raw)[0]; assert.equal(saved.targetChatId, NEW);
    assert.equal(saved.sourceChatId, watcher.sourceChatId); assert.equal(saved.lastReadMessageId, 31); assert.ok(saved.lastMatchedAt);
    assert.equal((await watchers.listChatPromptWatchers())[0].targetChatId, NEW);
    await watchers.setChatPromptWatcherEnabled(watcher.id, false);
    assert.equal(JSON.parse(raw)[0].targetChatId, NEW); assert.equal(JSON.parse(raw)[0].enabled, false);
});
