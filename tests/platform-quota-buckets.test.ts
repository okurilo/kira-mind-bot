import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { initializePublicAccounts } from '../platform/publicAccounts/schema';
import { digest } from '../platform/crypto';
import { publicTestConfig, publicTestPort, withPublicRegistry } from './support/publicAccounts';

const send = (operationId: string, background = false) => ({ operationId, background, provider: 'openai', endpoint: 'https://synthetic.example.invalid/v1/chat/completions', image: false });

test('exhausted background cannot consume or block dialogue; stages and concurrent retries charge one logical task', { skip: !publicTestPort }, async () => {
  await withPublicRegistry(async (db, store) => {
    const account = await store.create('synthetic_quota_split', 'disabled'), cfg = { ...publicTestConfig(), aiLimit: 2, backgroundAiLimit: 1 };
    const p = new PublicAccountPolicy(db, () => cfg);
    await p.setConsent(account.id, { version: 1, consentVersion: cfg.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
    await db.query('UPDATE kira_accounts SET autonomous_ai_enabled=true WHERE id=$1', [account.id]);
    await p.reserve(account.id, 'background-batch', false, true);
    await Promise.all(Array.from({ length: 4 }, () => p.authorizeOutbound(account.id, send('background-batch', true))));
    assert.deepEqual((await p.quota(account.id)).background, { limit: 1, used: 1, reserved: 0, remaining: 0 });
    assert.equal((await p.quota(account.id)).dialogue.remaining, 2);
    await assert.rejects(p.authorizeOutbound(account.id, send('new-background', true)), (e: any) => e.code === 'background_quota_exhausted');
    await Promise.all(Array.from({ length: 5 }, () => p.authorizeOutbound(account.id, send('user-task'))));
    assert.equal((await p.quota(account.id)).dialogue.used, 1);
    await p.authorizeOutbound(account.id, send('other-user-task'));
    await assert.rejects(p.authorizeOutbound(account.id, send('third-user-task')), (e: any) => e.code === 'dialogue_quota_exhausted');
    await p.authorizeOutbound(account.id, send('background-batch', true));
    assert.equal((await p.quota(account.id)).background.used, 1, 'continuing an admitted task does not buy another unit');
    await assert.rejects(p.authorizeOutbound(account.id, send('background-batch')), (e: any) => e.code === 'operation_scope_mismatch');
    await assert.rejects(p.authorizeOutbound(account.id, send('user-task', true)), (e: any) => e.code === 'operation_scope_mismatch');
    assert.deepEqual((await p.quota(account.id)).ai, (await p.quota(account.id)).dialogue, 'native v1 alias remains usable');
  });
});

test('unused leases, explicit retry, UTC rollover, request caps and authority checks stay isolated by pool', { skip: !publicTestPort }, async () => {
  await withPublicRegistry(async (db, store) => {
    const account = await store.create('synthetic_pool_leases', 'disabled'), cfg = { ...publicTestConfig(), aiLimit: 2, backgroundAiLimit: 2, maxAiCallsPerOperation: 2 };
    let now = new Date('2038-05-06T23:59:00Z'); const p = new PublicAccountPolicy(db, () => cfg, () => now);
    await p.setConsent(account.id, { version: 1, consentVersion: cfg.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
    await db.query('UPDATE kira_accounts SET autonomous_ai_enabled=false WHERE id=$1', [account.id]);
    await assert.rejects(p.reserve(account.id, 'disabled-background', false, true), (e: any) => e.code === 'autonomous_ai_disabled');
    await db.query('UPDATE kira_accounts SET autonomous_ai_enabled=true WHERE id=$1', [account.id]);
    await p.reserve(account.id, 'unused', false, true); await p.release(account.id, 'unused', false);
    assert.equal((await p.quota(account.id)).background.reserved, 0);
    await assert.rejects(p.authorizeOutbound(account.id, send('unused', true)), (e: any) => e.code === 'operation_closed');
    await p.reserve(account.id, 'unused', false, true);
    await p.authorizeOutbound(account.id, { ...send('unused', true), reserveOnly: true });
    await p.authorizeOutbound(account.id, send('unused', true)); await p.authorizeOutbound(account.id, send('unused', true));
    await assert.rejects(p.authorizeOutbound(account.id, send('unused', true)), (e: any) => e.code === 'operation_limit_exceeded');
    await p.reserve(account.id, 'foreground-lease'); await p.reserve(account.id, 'background-lease', false, true);
    now = new Date('2038-05-07T00:06:00Z');
    const next = await p.quota(account.id); assert.equal(next.dialogue.used, 0); assert.equal(next.background.used, 0);
    const [old] = await db.query('SELECT * FROM kira_public_quota WHERE account_id=$1 AND day=$2', [account.id, '2038-05-06']);
    assert.equal(old.dialogue_reserved, 0); assert.equal(old.background_reserved, 0); assert.equal(old.background_used, 1);
    await p.authorizeOutbound(account.id, send('new-day'));
    await p.authorizeOutbound(account.id, send('new-background-day', true));
    await p.setConsent(account.id, { version: 1, consentVersion: cfg.catalog.version, accepted: false, recipientIds: [] });
    await assert.rejects(p.authorizeOutbound(account.id, send('new-day')), (e: any) => e.code === 'consent_required');
  });
});

test('migration preserves unclassified history without charging it to dialogue or background and never resets new counters', { skip: !publicTestPort }, async () => {
  await withPublicRegistry(async (db, store) => {
    const account = await store.create('synthetic_legacy_quota', 'disabled'), cfg = publicTestConfig(); const now = new Date('2038-05-06T12:00:00Z');
    await db.query('INSERT INTO kira_public_quota(account_id,day,ai_used,ai_reserved) VALUES($1,$2,7,1)', [account.id, '2038-05-06']);
    await db.query(`INSERT INTO kira_public_ai_operations(account_id,operation_hash,day,ai_state,image_state,lease_expires_at)
      VALUES($1,$2,$3,'committed','none',NULL),($1,$4,$3,'reserved','none',$5)`, [account.id, digest('legacy-paid'), '2038-05-06', digest('legacy-unused'), new Date(now.getTime() - 1)]);
    await initializePublicAccounts(db);
    const p = new PublicAccountPolicy(db, () => cfg, () => now);
    assert.deepEqual((await p.quota(account.id)).legacyAi, { used: 7, reserved: 0 });
    assert.equal((await p.quota(account.id)).dialogue.used, 0); assert.equal((await p.quota(account.id)).background.used, 0);
    await p.setConsent(account.id, { version: 1, consentVersion: cfg.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
    await p.authorizeOutbound(account.id, send('legacy-paid'));
    await p.authorizeOutbound(account.id, send('new-dialogue'));
    await initializePublicAccounts(db);
    const current = await p.quota(account.id);
    assert.equal(current.dialogue.used, 1); assert.equal(current.legacyAi.used, 7); assert.equal(current.background.used, 0);
    await p.release(account.id, 'legacy-paid'); assert.equal((await p.quota(account.id)).legacyAi.used, 7);
  });
});
