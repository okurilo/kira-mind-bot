import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { PgUiStore } from '../generative-ui/store';
import { UiService } from '../generative-ui/service';
import { fixtureSnapshot } from '../scripts/generateUiExamples';
import { UI_CATALOG_V2 } from '../generative-ui/contracts';
import { UI_CATALOG_ID } from '../generative-ui/contracts';
import { ApiOperationEntity } from '../entity/ApiOperationEntity';
import { PersistentApiOperations } from '../api/operations';
import { ApiError } from '../api/contracts';
import { UiRefreshService } from '../generative-ui/refresh';
import { compileRefreshRecipe } from '../generative-ui/refreshTemplate';
import { TelegramUiService, type WidgetApi } from '../generative-ui/telegram';
import { scopedBotKey } from '../utils/botIdentity';

test('PostgreSQL UI survives reconnect, isolates owners, rolls back failures and serializes revision races', { skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT }, async () => {
    const connection = { type: 'postgres' as const, host: '127.0.0.1', port: Number(process.env.KIRA_PLATFORM_TEST_PG_PORT), username: 'postgres', password: 'synthetic-platform-test' };
    const admin = await new DataSource({ ...connection, database: 'postgres' }).initialize();
    const database = 'kira_ui_test_' + randomUUID().replace(/-/g, '');
    await admin.query(`CREATE DATABASE "${database}"`);
    let db: DataSource | undefined;
    const open = () => new DataSource({ ...connection, database, entities: [BotSettingEntity, ApiOperationEntity], synchronize: true }).initialize();
    let now = Date.now(); const owner = 730001;
    try {
        db = await open(); let store = new PgUiStore(db), service = new UiService(owner, store, () => now);
        const ui = fixtureSnapshot(undefined, true); ui.meta = { asOf: '2041-04-12T19:00:00Z' };
        const sid = ui.messages[0].createSurface.surfaceId;
        await service.record(ui, -1001, { enabled: true, catalogId: UI_CATALOG_V2 });
        await service.feedback({ surfaceId: sid, messageId: -1001, verdict: 'useful' }, 'pg-feedback');
        assert.equal(await new UiService(owner + 1, store).surface(sid), undefined);
        await assert.rejects(store.transact(owner, async tx => { await tx.put('meta', 'rollback', { value: 'synthetic' }); throw Error('abort'); }));
        assert.equal(await store.transact(owner, tx => tx.get('meta', 'rollback')), undefined);
        await db.destroy(); db = await open(); store = new PgUiStore(db); service = new UiService(owner, store, () => now);
        assert.deepEqual((await service.surface(sid))!.ui, ui); assert.equal((await service.metrics()).useful, 1);
        now += 60_000;
        const outcomes = await Promise.allSettled([service.update(sid, 1, ui), new UiService(owner, store, () => now).update(sid, 1, ui)]);
        assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal((await service.surface(sid))!.revision, 2);
        assert.equal((await service.events()).uiEvents.length, 1);
        await service.delete(sid, 2); assert.equal((await service.surface(sid))!.deleted, true);
        assert.equal((await service.events()).uiEvents.length, 2);
        const refreshUi = fixtureSnapshot([{ id: 'root', component: 'Metric', label: 'Учебная цена', value: '18 USD' }]);
        refreshUi.messages[0].createSurface.surfaceId = 'kira_22222222222242228222222222222222';
        const source = { kind: 'data' as const, adapter: 'mcp' as const, server: 'synthetic', tool: 'quote', authority: 'synthetic', args: { ticker: 'SYNTHETIC' },
            data: { identity: 'synthetic:USD', asOf: '2041-04-12T19:00:00Z', sources: [{ label: 'Источник', url: 'https://example.org/quote' }], values: { price: 18 } } };
        const recipe = compileRefreshRecipe({ source: 0, subject: 'SYNTHETIC цена USD', sourceUrl: 'https://example.org/quote',
            slots: [{ id: 'price', componentId: 'root', path: ['value'], description: 'Цена в USD', sourceField: 'price', suffix: ' USD' }] }, refreshUi, [source])!;
        const request = { enabled: true as const, catalogId: UI_CATALOG_ID, refresh: true as const };
        const meta = (await new UiRefreshService(owner, store, () => now).register(refreshUi, recipe, request))!;
        await db.destroy(); db = await open(); store = new PgUiStore(db); now += 600_000;
        let reads = 0;
        const refresh = new UiRefreshService(owner, store, () => now, { allowed: async () => true, run: async (_key, work) => work(),
            data: async () => { reads++; return { ...source.data, asOf: '2041-04-12T20:00:00Z', values: { price: 19 } }; } });
        const body = { items: [{ token: meta.token, surfaceId: refreshUi.messages[0].createSurface.surfaceId }], ui: request };
        const operations = new PersistentApiOperations(db), result = await operations.runJson('refresh-replay', 'same-body', () => refresh.batch(body, 'synthetic-key'));
        assert.equal(result.results[0].status, 'updated'); assert.equal(reads, 1);
        assert.deepEqual(await operations.runJson('refresh-replay', 'same-body', () => { throw Error('must not execute'); }), result);
        await assert.rejects(operations.runJson('refresh-replay', 'changed-body', () => refresh.batch(body, 'synthetic-key')), (e: any) => e.code === 'idempotency_conflict');
        await assert.rejects(operations.runJson('refresh-rate-refusal', 'body', async () => { throw new ApiError(429, 'rate_limited', 'Synthetic refusal', true); }, { releaseRefusals: true }));
        assert.deepEqual(await operations.runJson('refresh-rate-refusal', 'body', async () => ({ ok: true })), { ok: true });
    } finally {
        if (db?.isInitialized) await db.destroy();
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.destroy();
    }
});

test('PostgreSQL Telegram widgets survive reconnect, isolate the API channel, serialize receipts and honor the canonical Telegram lock', { skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT }, async () => {
    const connection = { type: 'postgres' as const, host: '127.0.0.1', port: Number(process.env.KIRA_PLATFORM_TEST_PG_PORT), username: 'postgres', password: 'synthetic-platform-test' };
    const admin = await new DataSource({ ...connection, database: 'postgres' }).initialize();
    const database = 'kira_tg_ui_test_' + randomUUID().replace(/-/g, '');
    await admin.query(`CREATE DATABASE "${database}"`);
    let db: DataSource | undefined;
    const open = () => new DataSource({ ...connection, database, entities: [BotSettingEntity], synchronize: true }).initialize();
    const owner = 730001, marker = scopedBotKey(`dialogue:${owner}`);
    const draft = { components: [{ id: 'root', component: 'Button', child: 'label', action: { type: 'reply', text: 'Учебный следующий вопрос' } }, { id: 'label', component: 'Text', text: 'Далее' }] };
    const query = { id: 'synthetic-query', from: { id: owner, is_bot: false, first_name: 'Synthetic' }, chat: { id: owner, type: 'private', first_name: 'Synthetic' },
        message_id: 20, chat_instance: 'private', type: { type: 'data' }, data: 'a:0:0' } as any;
    const api: WidgetApi = { sendWidget: async () => ({ message_id: 20 } as any), answerWidgetQuery: async () => true, editMessageWidgetData: async () => true };
    try {
        db = await open(); await db.getRepository(BotSettingEntity).upsert({ key: marker, value: 'tg:1' }, ['key']);
        let store = new PgUiStore(db, 'telegram');
        let service = new TelegramUiService(store, async () => JSON.stringify(draft));
        await service.deliver(owner, api, 'Учебный вопрос', 'Учебный ответ', 10, undefined, 'tg:1');
        assert.equal(await new PgUiStore(db).transact(owner, tx => tx.get('cards', '20')), undefined);
        assert.equal(await store.transact(owner + 1, tx => tx.get('cards', '20')), undefined);
        await db.destroy(); db = await open(); store = new PgUiStore(db, 'telegram'); service = new TelegramUiService(store);
        const results = await Promise.all([service.query(owner, query), new TelegramUiService(new PgUiStore(db, 'telegram')).query(owner, query)]);
        assert.equal(results.filter(r => r.dispatch).length, 1);
        assert.equal((await new TelegramUiService(store).query(owner, query)).dispatch, undefined);
        // A fresh widget must be rejected if a concurrent new canonical turn wins its lock.
        await new TelegramUiService(store, async () => JSON.stringify(draft)).deliver(owner, api, 'Вопрос', 'Ответ', 10, undefined, 'tg:1');
        const runner = db.createQueryRunner(); await runner.connect(); await runner.startTransaction();
        try {
            await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [marker]);
            await runner.query('UPDATE bot_settings SET value=$2 WHERE key=$1', [marker, 'tg:2']);
            const pending = service.query(owner, query);
            await new Promise(resolve => setTimeout(resolve, 40));
            await runner.commitTransaction();
            assert.equal((await pending).dispatch, undefined);
        } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    } finally {
        if (db?.isInitialized) await db.destroy();
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.destroy();
    }
});
