import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { COMMERCE_PROVIDERS, commerceCatalog, commerceHostAllowed, commerceProvider, commerceRequestAllowed, commerceTask, storefront } from '../services/commerce/catalog';
import { installCommercePolicy, startCommerceProxy } from '../services/commerce/browserPolicy';
import { LiveBrowserSession, BrowserInterrupted, type BrowserPageInfo } from '../services/liveBrowserSession';
import { runReviewedBrowserAction } from '../services/liveBrowserActionPolicy';
import { createBrowserWorkspace, attachBrowserWorkspace, availableBrowserWorkspace } from '../services/browserWorkspace';
import { normalizeClassificationEnvelope } from '../orchestration/intentPrompt';
import { agentTools } from '../orchestration/runtime/agents';
import { ToolRegistry } from '../orchestration/runtime/registry';
import type { ToolContext } from '../orchestration/runtime/types';
import { createKiraToolRegistry } from '../orchestration/runtime/kernel';
import { config } from '../config';

test('all five consumer services have explicit capabilities, fixed entry points and no secret-taking tools', async () => {
    const catalog = commerceCatalog();
    assert.deepEqual(catalog.map(row => row.id), [...COMMERCE_PROVIDERS]);
    assert.equal(commerceProvider('https://outside.invalid'), undefined);
    assert.equal(commerceProvider('__proto__'), undefined);
    assert.throws(() => storefront('__proto__' as any));
    for (const row of catalog) {
        assert.equal(row.mode, 'isolated_browser');
        assert.ok(row.capabilities.includes('manual_checkout'));
        assert.ok(commerceRequestAllowed(row.id, row.url, 'GET', false));
        assert.match(commerceTask(row.id, 'Сравни два товара'), /Сравни два товара/);
        assert.ok(commerceTask(row.id, 'Запрос').includes(row.url));
    }
    const registry = new ToolRegistry(agentTools(), ctx => ctx.ctx.from?.id === 95101);
    const ctx = { ctx: { from: { id: 95101 }, chat: { type: 'private' }, session: {} }, signal: new AbortController().signal } as unknown as ToolContext;
    const result = await registry.execute('commerce.listServices', {}, ctx);
    assert.equal(result.status, 'ok'); assert.deepEqual(result.data, catalog);
    assert.equal((await registry.execute('commerce.listServices', {}, { ...ctx, ctx: { ...ctx.ctx, from: { id: 95102 } } as any })).status, 'failed');
    assert.equal((await registry.execute('commerce.listServices', {}, { ...ctx, ctx: { ...ctx.ctx, chat: { type: 'group' } } as any })).status, 'failed');
    assert.equal((await registry.execute('agents.start', { kind: 'research', task: 'Synthetic', commerceProvider: 'ozon' }, ctx)).status, 'failed');
    assert.equal((await registry.execute('agents.start', { kind: 'browser', task: 'Synthetic', commerceProvider: 'ozon', headers: { Cookie: 'synthetic' } }, ctx)).status, 'failed');
});

test('credentials cannot cross origins through userinfo, suffixes, ports, schemes or encoded action paths', () => {
    for (const provider of COMMERCE_PROVIDERS) {
        const host = new URL(storefront(provider).url).hostname;
        for (const url of [
            `https://${host}` + ':443' + '@outside.invalid/', `https://${host}.outside.invalid/`,
            `https://outside.invalid@${host}/`, `http://${host}/`, `https://${host}:8443/`,
            `https://${host}./`, 'https://127.0.0.1/', 'https://[::1]/', 'file:///etc/passwd',
            `https://${host}/%255Faction/cartAdd`, `https://${host}/%73ubmit`, `https://${host}/logout`,
        ]) assert.equal(commerceRequestAllowed(provider, url, 'GET', false), false, url);
        assert.equal(commerceHostAllowed(provider, `${host}:443@outside.invalid`), false);
        assert.equal(commerceRequestAllowed(provider, `https://${host}/search?text=a%26url%3Dhttps%3A%2F%2Foutside.invalid`, 'GET', false), true);
    }
    assert.equal(commerceRequestAllowed('yandex-lavka', 'https://market.yandex.ru/', 'GET', false), false);
    assert.equal(commerceRequestAllowed('yandex-market', 'https://lavka.yandex.ru/', 'GET', false), false);
});

test('model cannot turn a network mutation into read; manual control remains constrained to merchant origins', () => {
    for (const provider of COMMERCE_PROVIDERS) {
        const url = `${storefront(provider).url}api/create-order`;
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            assert.equal(commerceRequestAllowed(provider, url, method, false), false);
            assert.equal(commerceRequestAllowed(provider, url, method, true), true);
            assert.equal(commerceRequestAllowed(provider, 'https://outside.invalid/collect', method, true), false);
        }
    }
    const read = 'https://lavka.yandex.ru/api/v1/providers/search/v3/lavka';
    assert.equal(commerceRequestAllowed('yandex-lavka', read, 'POST', false), true);
    assert.equal(commerceRequestAllowed('yandex-lavka', read + '/submit', 'POST', false), false);
    assert.equal(commerceRequestAllowed('yandex-lavka', 'https://id.yandex.ru/api/v1/providers/search/v3/lavka', 'POST', false), false);
    assert.equal(commerceRequestAllowed('yandex-lavka', 'https://lavka.yandex.ru/api/v1/orders/submit', 'POST', false), false);
    assert.equal(commerceRequestAllowed('yandex-lavka', 'https://yastatic.net/collect', 'POST', true), false);
    for (const host of ['smartcaptcha.yandexcloud.net', 'smartcaptcha.cloud.yandex.ru']) {
        assert.equal(commerceRequestAllowed('yandex-market', `https://${host}/check`, 'POST', false), false);
        assert.equal(commerceRequestAllowed('yandex-market', `https://${host}/check`, 'POST', true), true, 'only human control can submit a merchant CAPTCHA response');
        assert.equal(commerceRequestAllowed('yandex-market', `https://${host}.outside.invalid/check`, 'POST', true), false);
    }
});

test('Playwright route rechecks human control on each request and closes websocket channels', async () => {
    let handler: any, websocket: any, human = false, notices = 0;
    await installCommercePolicy({ route: async (_pattern: string, callback: any) => { handler = callback; },
        routeWebSocket: async (_pattern: string, callback: any) => { websocket = callback; }, on: () => {} } as any, 'ozon', () => human, () => { notices++; });
    const sent: string[] = [], blocked: string[] = [];
    const request = (url: string, method = 'GET') => handler({ request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => false }),
        continue: async () => { sent.push(url); }, abort: async () => { blocked.push(url); } });
    await request('https://www.ozon.ru/search/?text=test');
    await request('https://outside.invalid/?cookie=synthetic-secret');
    await request('https://www.ozon.ru/api/create-order', 'POST');
    human = true;
    await request('https://www.ozon.ru/api/create-order', 'POST');
    human = false;
    await request('https://www.ozon.ru/api/create-order', 'POST');
    assert.equal(sent.length, 2); assert.equal(blocked.length, 3);
    assert.equal(notices, 2, 'blocked merchant writes require human help without repeating a click');
    let closed = false; websocket({ close: () => { closed = true; } }); assert.equal(closed, true);
});

test('actual proxy rejects foreign CONNECT targets and plaintext before DNS and cleans up open connections', async () => {
    const proxy = await startCommerceProxy('ozon'), url = new URL(proxy.url);
    try {
        for (const target of ['outside.invalid:443', 'www.ozon.ru:443@outside.invalid:443', 'www.ozon.ru:8443', '127.0.0.1:443', 'www.ozon.ru:443#fragment']) {
            const response = await new Promise<string>((resolve, reject) => {
                const socket = net.connect(Number(url.port), url.hostname);
                socket.once('error', reject);
                socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
                socket.once('data', data => { resolve(data.toString()); socket.destroy(); });
            });
            // Malformed CONNECT authority can be rejected by Node's HTTP parser before our handler.
            assert.match(response, /^HTTP\/1.1 (400|403) /, target);
        }
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request({ hostname: url.hostname, port: url.port, path: 'http://www.ozon.ru/' }, res => { res.resume(); resolve(res.statusCode!); });
            req.once('error', reject); req.end();
        });
        assert.equal(status, 403);
        const held = net.connect(Number(url.port), url.hostname);
        await new Promise<void>(resolve => held.once('connect', resolve));
        await proxy.close();
        await proxy.close();
        held.destroy();
    } finally { await proxy.close(); }
});

test('merchant access denial and throttling are explicit blockers, never empty product results', async () => {
    let response!: (value: any) => void, human = false;
    const notices: string[] = [];
    await installCommercePolicy({ route: async () => {}, routeWebSocket: async () => {},
        on: (_event: string, handler: any) => { response = handler; } } as any, 'samokat', () => human, reason => { notices.push(reason); });
    const frame = { page: () => ({ mainFrame: () => frame }) };
    const report = (status: number, navigation = true) => response({ status: () => status,
        request: () => ({ isNavigationRequest: () => navigation, frame: () => frame }) });
    report(200); report(403, false); report(401); report(403); report(429);
    human = true; report(403); report(429);
    assert.deepEqual(notices, ['access_denied', 'access_denied', 'rate_limited']);
});

test('deterministic adapter silently blocks background writes but still reports blocked main navigation', async () => {
    let handler: any; const notices: string[] = [];
    await installCommercePolicy({ route: async (_pattern: string, callback: any) => { handler = callback; }, routeWebSocket: async () => {}, on: () => {} } as any,
        'kuper', () => false, reason => { notices.push(reason); }, undefined, { notifyMerchantWrites: false });
    const frame = { page: () => ({ mainFrame: () => frame }) }; let blocked = 0;
    const request = (url: string, navigation: boolean) => handler({ request: () => ({ url: () => url, method: () => 'POST', isNavigationRequest: () => navigation, frame: () => frame }),
        continue: async () => { throw Error('Unapproved write'); }, abort: async () => { blocked++; } });
    await request('https://kuper.ru/api/background-event', false); assert.deepEqual(notices, []);
    await request('https://outside.invalid/', true); assert.deepEqual(notices, ['request_denied']); assert.equal(blocked, 2);
});

test('checkout never becomes an automated click after a model commitment review', async t => {
    const session = new LiveBrowserSession(95101, '95101', randomUUID()); session.commerceProvider = 'kuper';
    const page: BrowserPageInfo = { pageId: 'synthetic', navigationEpoch: 1, viewportRevision: 1, title: 'Synthetic', url: 'https://kuper.ru/',
        origin: 'https://kuper.ru', viewport: { width: 100, height: 100, deviceScaleFactor: 1 }, focus: { editable: false, kind: 'none' } };
    session.attach({ inspect: async () => page, capture: async () => ({ page, jpeg: Buffer.from('synthetic'), width: 100, height: 100 }), input: async () => {}, close: async () => {} });
    t.after(() => session.dispose());
    let effects = 0;
    await assert.rejects(session.runAgent(() => runReviewedBrowserAction({ method: 'click', target: 'pay' }, {}, async () => { effects++; },
        async () => ({ kind: 'commitment', summary: 'Отправить синтетический заказ' }))), BrowserInterrupted);
    assert.equal(effects, 0); assert.equal(session.state, 'needs_user');
    assert.deepEqual(session.snapshot().commerce, { provider: 'kuper', manualCheckout: true, persistentLogin: false });
    assert.equal(session.snapshot().pendingConfirmation, null);
    assert.match(session.snapshot().assistanceRequest!.prompt, /самостоятельно/);
});

test('store narrowing survives serialized continuations and rejects invented classification providers', () => {
    const workspace = createBrowserWorkspace(95101, 'api:95101', 'operation-a', 'Synthetic'); workspace.commerceProvider = 'samokat';
    const restored = attachBrowserWorkspace(JSON.parse(JSON.stringify(workspace)), 'operation-b', 'Другой размер');
    assert.equal(restored.commerceProvider, 'samokat'); assert.equal(restored.owner, 95101);
    const classification = { intent: 'БРАУЗЕР_ЗАДАЧА', confidenceLevel: 'ВЫСОКИЙ', details: { commerceProvider: 'outside.invalid' } } as any;
    assert.equal(normalizeClassificationEnvelope(classification).details.commerceProvider, undefined);
    classification.details.commerceProvider = 'samokat';
    assert.equal(normalizeClassificationEnvelope(classification).details.commerceProvider, 'samokat');
});

test('API-only account can use its own commerce tools and workspace without granting other negative principals access', async () => {
    const saved = { mode: process.env.KIRA_RUNTIME_MODE, tenant: process.env.KIRA_TENANT_ID,
        principal: process.env.KIRA_RUNTIME_PRINCIPAL, owner: config.allowedUserId };
    try {
        Object.assign(process.env, { KIRA_RUNTIME_MODE: 'api_only', KIRA_TENANT_ID: '00000000-0000-4000-8000-000000095101', KIRA_RUNTIME_PRINCIPAL: '-95101' });
        config.allowedUserId = -95101;
        const registry = createKiraToolRegistry();
        const ctx = { ctx: { from: { id: -95101 }, chat: { type: 'private' }, session: {} }, signal: new AbortController().signal } as unknown as ToolContext;
        assert.equal((await registry.execute('commerce.listServices', {}, ctx)).status, 'ok');
        assert.equal((await registry.execute('commerce.listServices', {}, { ...ctx, ctx: { ...ctx.ctx, from: { id: -95102 } } as any })).status, 'failed');
        const workspace = createBrowserWorkspace(-95101, 'api:-95101', 'synthetic', 'Synthetic');
        assert.ok(availableBrowserWorkspace(workspace, -95101, 'api:-95101'));
        assert.equal(availableBrowserWorkspace(workspace, -95102, 'api:-95101'), undefined);
        assert.equal(availableBrowserWorkspace(workspace, -95101, 'api:-95102'), undefined);
        delete process.env.KIRA_RUNTIME_MODE;
        assert.equal((await registry.execute('commerce.listServices', {}, ctx)).status, 'failed');
        assert.equal(availableBrowserWorkspace(workspace, -95101, 'api:-95101'), undefined);
    } finally {
        for (const [key, value] of Object.entries({ KIRA_RUNTIME_MODE: saved.mode, KIRA_TENANT_ID: saved.tenant, KIRA_RUNTIME_PRINCIPAL: saved.principal })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        config.allowedUserId = saved.owner;
    }
});
