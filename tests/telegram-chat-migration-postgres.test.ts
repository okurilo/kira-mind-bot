import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { ChatEntity } from '../entity/ChatEntity';
import { getActiveBotProfile, scopedBotKey } from '../utils/botIdentity';
import { PgChatMigrationStore, TelegramChatMigrations, telegramChatMigrations } from '../services/telegramChatMigration';
import * as registry from '../services/chatRegistry';

test('PostgreSQL migration survives reconnect, keeps policies scoped, rejects conflicts and serializes cycles', { skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT }, async t => {
    const connection = { type: 'postgres' as const, host: '127.0.0.1', port: Number(process.env.KIRA_PLATFORM_TEST_PG_PORT), username: 'postgres', password: 'synthetic-platform-test' };
    const admin = await new DataSource({ ...connection, database: 'postgres' }).initialize();
    const database = 'kira_migration_' + randomUUID().replace(/-/g, '');
    await admin.query(`CREATE DATABASE "${database}"`);
    let db: DataSource | undefined;
    const open = () => new DataSource({ ...connection, database, entities: [BotSettingEntity, ChatEntity], synchronize: true }).initialize();
    const old = '-420001', next = '-100420001', profile = getActiveBotProfile();
    try {
        db = await open();
        let service = new TelegramChatMigrations(new PgChatMigrationStore(db));
        await db.getRepository(ChatEntity).save({ chatId: old, profile, title: 'Синтетическая группа', chatType: 'group', publicMode: true, allowedDomains: ['work'], forbiddenTopics: 'synthetic restriction' });
        await db.getRepository(ChatEntity).save({ chatId: old, profile: 'unrelated-profile', title: 'Другая группа', chatType: 'group', publicMode: false });
        await service.record(old, next); await service.record(old, next);
        await db.destroy(); db = await open(); service = new TelegramChatMigrations(new PgChatMigrationStore(db));
        assert.equal(await service.resolve(old), next);
        const repo = db.getRepository(ChatEntity), migrated = (await repo.findOneBy({ chatId: next, profile }))!;
        assert.equal(migrated.chatType, 'supergroup'); assert.equal(migrated.publicMode, true);
        assert.deepEqual(migrated.allowedDomains, ['work']); assert.equal(migrated.forbiddenTopics, 'synthetic restriction');
        assert.ok(await repo.findOneBy({ chatId: old, profile }));
        assert.equal(await repo.findOneBy({ chatId: next, profile: 'unrelated-profile' }), null);
        const key = scopedBotKey('telegram:chat-migration:' + old);
        assert.equal((await db.getRepository(BotSettingEntity).findOneBy({ key }))!.value, next);
        await assert.rejects(service.record(old, '-100420002'), /conflicting/);
        await assert.rejects(service.record(next, old), /cyclic/);
        assert.equal(await new PgChatMigrationStore(db).read(next), undefined);
        const outcomes = await Promise.allSettled([service.record('-70001', '-70002'), service.record('-70002', '-70001')]);
        assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
        for (let i = 0; i < 7; i++) await service.record(String(-80000 - i), String(-80001 - i));
        assert.equal(await service.resolve('-80000'), '-80007');
        await assert.rejects(service.record('-79999', '-80000'), /too_long/);
        await db.getRepository(BotSettingEntity).save({ key: scopedBotKey('telegram:chat-migration:-90001'), value: 'invalid' });
        await assert.rejects(service.resolve('-90001'), /invalid_stored/);

        // Existing destination policy takes precedence over the historical group policy.
        await repo.update({ chatId: next, profile }, { publicMode: false, allowedDomains: ['health'] });
        await service.record(old, next);
        assert.equal((await repo.findOneBy({ chatId: next, profile }))!.publicMode, false);
        t.mock.method(AppDataSource, 'getRepository', ((entity: any) => db!.getRepository(entity)) as any);
        t.mock.method(telegramChatMigrations, 'resolve', (value: string | number) => service.resolve(value));
        const chats = await registry.getAllChats();
        assert.deepEqual(chats.map(c => c.chatId), [next]);
        assert.equal(await registry.isChatPublicMode(Number(old)), false);
        assert.deepEqual(await registry.getChatAllowedDomains(Number(old)), ['health']);
        assert.equal(await registry.getChatForbiddenTopics(Number(old)), 'synthetic restriction');
        await registry.setChatPublicMode(Number(old), true);
        await registry.setChatAllowedDomains(Number(old), ['work']);
        await registry.setChatForbiddenTopics(Number(old), 'updated synthetic restriction');
        assert.equal((await repo.findOneBy({ chatId: next, profile }))!.publicMode, true);
        assert.deepEqual((await repo.findOneBy({ chatId: next, profile }))!.allowedDomains, ['work']);
        assert.equal((await repo.findOneBy({ chatId: next, profile }))!.forbiddenTopics, 'updated synthetic restriction');
        await registry.upsertChat({ chatId: Number(old), title: 'Stale', chatType: 'group' });
        assert.equal((await repo.findOneBy({ chatId: next, profile }))!.title, 'Синтетическая группа');
        await registry.upsertChat({ chatId: Number(next), title: 'Новое название', chatType: 'supergroup' });
        assert.equal((await repo.findOneBy({ chatId: next, profile }))!.title, 'Новое название');
    } finally {
        if (db?.isInitialized) await db.destroy();
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.destroy();
    }
});
