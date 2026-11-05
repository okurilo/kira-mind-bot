import assert from 'node:assert/strict';
import { test } from 'node:test';
const { registerAccountQuotaRoutes } = require('../admin-panel/accountQuota.js');

const budget = (limit: number, used = 0) => ({ limit, used, reserved: 0, remaining: limit - used });
const quota = { day: '2026-11-05', resetAt: '2026-11-06T00:00:00Z', dialogue: budget(20, 3), background: budget(60, 60), images: budget(1) };
async function request(options: any = {}, query = {}) {
    let handler: any; const app = { get: (_path: string, _auth: any, route: any) => { handler = route; } };
    registerAccountQuotaRoutes(app, { requireAuth: () => {}, operatorAuth: { accountQuota: async () => undefined }, readEnvFile: () => ({}), env: {}, ...options });
    const response = { statusCode: 200, headers: {} as any, body: undefined as any,
        status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; }, setHeader(key: string, value: string) { this.headers[key] = value; } };
    await handler({ query }, response); return response;
}
test('private admin fetches only its configured account, keeping the runtime credential server-side', async () => {
    let calls = 0;
    const result = await request({ env: { KIRA_ACCOUNT_AUTH_URL: 'http://authority.test' }, readEnvFile: () => ({ KIRA_API_TOKEN: '"synthetic-secret"' }),
        fetcher: async (url: URL, options: any) => { calls++; assert.equal(url.href, 'http://authority.test/api/v1/account/quota');
            assert.equal(options.headers.Authorization, 'Bearer synthetic-secret'); assert.equal(options.redirect, 'error');
            return new Response(JSON.stringify({ version: 1, quota })); } });
    assert.equal(calls, 1); assert.equal(result.statusCode, 200); assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(result.body, { available: true, version: 1, quota }); assert.ok(!JSON.stringify(result.body).includes('synthetic-secret'));
});
test('canonical operator failures never fall back to the private account credential', async () => {
    const options = { operatorAuth: { accountQuota: async () => ({ ok: false, status: 401 }) }, env: { KIRA_ACCOUNT_AUTH_URL: 'http://authority.test', KIRA_API_TOKEN: 'synthetic' },
        fetcher: async () => { throw Error('Forbidden fallback'); } };
    assert.equal((await request(options)).statusCode, 503);
    assert.equal((await request(options, { accountId: 'other' })).statusCode, 400);
});
test('standalone state and failed or invalid quota reads remain distinct from zero balances', async () => {
    assert.deepEqual((await request()).body, { available: false, reason: 'standalone' });
    for (const value of [{ version: 1, quota: { ...quota, background: { ...quota.background, remaining: 50 } } }, { version: 2, quota }, {}]) {
        const result = await request({ operatorAuth: { accountQuota: async () => ({ ok: true, body: value }) } });
        assert.equal(result.statusCode, 503); assert.equal(result.body.quota, undefined);
    }
    assert.equal((await request({ env: { KIRA_ACCOUNT_AUTH_URL: 'http://authority.test/unsafe', KIRA_API_TOKEN: 'synthetic' } })).statusCode, 503);
});
