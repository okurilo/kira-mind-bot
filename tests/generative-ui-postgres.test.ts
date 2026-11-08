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

test('PostgreSQL UI survives reconnect, isolates owners, rolls back failures and serializes revision races', { skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT }, async () => {
    const connection = { type: 'postgres' as const, host: '127.0.0.1', port: Number(process.env.KIRA_PLATFORM_TEST_PG_PORT), username: 'postgres', password: 'synthetic-platform-test' };
    const admin = await new DataSource({ ...connection, database: 'postgres' }).initialize();
    const database = 'kira_ui_test_' + randomUUID().replace(/-/g, '');
    await admin.query(`CREATE DATABASE "${database}"`);
    let db: DataSource | undefined;
    const open = () => new DataSource({ ...connection, database, entities: [BotSettingEntity], synchronize: true }).initialize();
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
    } finally {
        if (db?.isInitialized) await db.destroy();
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.destroy();
    }
});
