import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommerceStore } from '../services/commerce/store';
import { CommerceService } from '../services/commerce/service';
import { connectCommerceMcp } from '../services/commerce/mcp';
import { cartRevision, type CommerceDriver, type CommerceLine, type CommerceCart, type CommerceProduct } from '../services/commerce/contracts';
import { nativeCommerceServers } from '../services/commerce/config';
import { McpService } from '../services/mcp/client';
import { parseMcpConfig } from '../services/mcp/config';
import { commerceInvocation } from '../services/commerce/context';
import { mcpTools } from '../orchestration/runtime/mcpTools';
import { ToolRegistry } from '../orchestration/runtime/registry';
import { runKiraRuntime, continueQuestionRuntime } from '../orchestration/runtime/kernel';
import { liveBrowserSessions } from '../services/liveBrowserSession';
import type { KiraRuntimeInput } from '../orchestration/runtime/types';

async function fixture(t: any) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-commerce-mcp-synthetic-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new CommerceStore(root, 'yandex-lavka', 'synthetic-owner-a', 'ac'.repeat(32));
    const products: Record<string, CommerceProduct> = {
        alpha: { id: 'alpha', title: 'Продукт Альфа', url: 'https://lavka.yandex.ru/product/alpha', price: { minor: 10000, currency: 'RUB' }, available: true },
        beta: { id: 'beta', title: 'Продукт Бета', url: 'https://lavka.yandex.ru/product/beta', price: { minor: 2500, currency: 'RUB' }, available: true },
    };
    let lines: CommerceLine[] = [], writes = 0, loseReply = false, authenticated = true, binding = 'synthetic-merchant-account-a';
    const cart = (): CommerceCart => ({ items: structuredClone(lines), revision: cartRevision(lines), observedAt: new Date().toISOString() });
    const driver: CommerceDriver = {
        provider: 'yandex-lavka', session: async () => ({ authenticated, accountBinding: binding }),
        connect: async () => ({ sessionId: 'synthetic-browser', kind: 'login', prompt: 'Войди на сайте.' }),
        search: async () => Object.values(products), product: async id => structuredClone(products[id]), cart: async () => cart(),
        orders: async () => [{ id: 'order-a', observedAt: '2026-11-01T10:00:00Z', status: 'delivered', items: [{ product: structuredClone(products.alpha), quantity: 2 }] }],
        order: async () => ({ id: 'order-a', observedAt: '2026-11-01T10:00:00Z', status: 'delivered', items: [] }),
        setCart: async items => {
            writes++; lines = items.filter(item => item.quantity > 0).map(item => ({ product: structuredClone(products[item.id]), quantity: item.quantity }));
            if (loseReply) throw Error('Synthetic lost acknowledgement'); return cart();
        },
        checkout: async () => ({ sessionId: 'synthetic-browser', kind: 'payment', prompt: 'Проверь итог и оплати на сайте.' }), disconnect: async () => { authenticated = false; },
    };
    const service = new CommerceService(driver, store);
    return { root, store, service, driver, products, writes: () => writes, loseReply: () => { loseReply = true; }, loggedOut: () => { authenticated = false; },
        changeAccount: () => { binding = 'synthetic-merchant-account-b'; }, setLines: (value: CommerceLine[]) => { lines = value; } };
}

test('actual MCP protocol discovers and reads native tools; model input cannot grant write authority', async t => {
    const f = await fixture(t), connection = await connectCommerceMcp(f.service, () => undefined); t.after(() => connection.close());
    const catalog = await connection.client.listTools(); assert.ok(catalog.tools.some(tool => tool.name === 'purchase_history'));
    const search = await connection.client.callTool({ name: 'search_products', arguments: { query: 'синтетический продукт' } });
    assert.equal((search.structuredContent as any).data.products.length, 2);
    await assert.rejects(connection.client.callTool({ name: 'apply_cart', arguments: { draftId: 'synthetic', revision: 'a'.repeat(64), confirmed: true } }));
    const rejected = await connection.client.callTool({ name: 'apply_cart', arguments: { draftId: 'synthetic', revision: 'a'.repeat(64) } });
    assert.equal(rejected.isError, true); assert.equal(f.writes(), 0);
});

test('one reviewed draft survives MCP connections and applies exactly once; proposals are never purchases', async t => {
    const f = await fixture(t);
    const draft = await f.service.draft([{ id: 'alpha', quantity: 2 }, { id: 'beta', quantity: 1 }], 'replace');
    assert.equal(f.writes(), 0); assert.equal(draft.estimatedTotal!.minor, 22500);
    assert.deepEqual((await f.store.snapshot()).orders, []);
    const connection = await connectCommerceMcp(f.service, () => ({ operationId: 'synthetic-owner-approved-operation' })); t.after(() => connection.close());
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await connection.client.callTool({ name: 'apply_cart', arguments: { draftId: draft.id, revision: draft.revision } });
        assert.equal(result.isError, undefined); assert.equal((result.structuredContent as any).data.cart.items.length, 2);
    }
    assert.equal(f.writes(), 1);
    const reloaded = new CommerceStore(f.root, 'yandex-lavka', 'synthetic-owner-a', 'ac'.repeat(32));
    assert.equal((await reloaded.snapshot()).drafts[0].status, 'applied');
});

test('changed price, changed source cart or changed merchant account cannot reuse an approval', async t => {
    for (const mode of ['price','cart','account'] as const) {
        const f = await fixture(t), draft = await f.service.draft([{ id: 'alpha', quantity: 1 }], 'replace');
        if (mode === 'price') f.products.alpha.price = { minor: 11000, currency: 'RUB' };
        if (mode === 'cart') f.setLines([{ product: f.products.beta, quantity: 1 }]);
        if (mode === 'account') f.changeAccount();
        await assert.rejects(f.service.applyDraft(draft.id, draft.revision, 'synthetic-approved'), error => ['stale_draft','account_changed'].includes((error as any).code));
        assert.equal(f.writes(), 0);
    }
});

test('lost merchant acknowledgement persists unknown and refuses replay under any operation id', async t => {
    const f = await fixture(t), draft = await f.service.draft([{ id: 'alpha', quantity: 1 }], 'replace'); f.loseReply();
    await assert.rejects(f.service.applyDraft(draft.id, draft.revision, 'operation-a'), (error: any) => error.code === 'operation_uncertain');
    await assert.rejects(f.service.applyDraft(draft.id, draft.revision, 'operation-b'), (error: any) => error.code === 'operation_uncertain');
    assert.equal(f.writes(), 1); assert.equal((await f.store.snapshot()).drafts[0].status, 'unknown');
    for (let index = 0; index < 25; index++) await f.service.draft([{ id: 'beta', quantity: 1 }], 'replace');
    assert.equal((await f.store.snapshot()).drafts.find(item => item.id === draft.id)?.status, 'unknown', 'new previews must retain the unknown operation evidence');
});

test('history remains available as explicitly saved evidence after logout and is encrypted/account-bound', async t => {
    const f = await fixture(t); const history = await f.service.history(); assert.equal(history[0].items[0].quantity, 2);
    f.loggedOut(); assert.equal((await f.service.history(20, false))[0].id, 'order-a');
    const bytes = await fs.readFile(path.join(f.root, 'yandex-lavka', 'state.enc'), 'utf8'); assert.doesNotMatch(bytes, /Продукт|order-a|synthetic-merchant/);
    const other = new CommerceStore(f.root, 'yandex-lavka', 'synthetic-owner-b', 'ac'.repeat(32));
    await assert.rejects(other.snapshot(), /защищённое состояние/);
    assert.equal(await fs.readFile(path.join(f.root, 'yandex-lavka', 'state.enc'), 'utf8'), bytes, 'failed reads must not erase the old history');
});

test('native catalogs are real MCP connections but discovery requires no account, browser, key or filesystem creation', async () => {
    const service = new McpService(nativeCommerceServers);
    assert.equal(service.servers().length, 5);
    const tools = await service.listTools('kira_yandex_lavka'); assert.ok(tools.tools.length);
    const samokat = await service.listTools('kira_samokat'); assert.equal(samokat.total, 4);
    assert.equal(service.toolEffect('kira_samokat', 'apply_cart'), undefined);
    assert.equal(service.toolEffect('kira_yandex_market', 'purchase_history'), undefined);
    const unauthorised = await service.callTool('kira_yandex_lavka', 'session_status', {}, 'read');
    assert.equal((unauthorised.structuredContent as any).status, 'failed');
    assert.throws(() => parseMcpConfig({ servers: nativeCommerceServers() }), /конфигурац/);
});

test('a newer order summary retains previously sourced items and their actual observation time', async t => {
    const f = await fixture(t); await f.service.history();
    await f.store.remember([{ id: 'order-a', status: 'completed', items: [], observedAt: '2026-11-04T11:00:00Z' }], 'synthetic-merchant-account-a');
    const order = (await f.store.snapshot()).orders[0];
    assert.equal(order.items[0].quantity, 2); assert.equal(order.itemsObservedAt, '2026-11-01T10:00:00Z');
    assert.equal(order.observedAt, '2026-11-04T11:00:00Z');
});

test('concurrent cart proposals cannot dispatch two merchant writes from the same initial revision', async t => {
    const f = await fixture(t), a = await f.service.draft([{ id: 'alpha', quantity: 1 }], 'replace'), b = await f.service.draft([{ id: 'beta', quantity: 1 }], 'replace');
    const results = await Promise.allSettled([f.service.applyDraft(a.id, a.revision, 'synthetic-a'), f.service.applyDraft(b.id, b.revision, 'synthetic-b')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.writes(), 1);
});

test('native MCP passes the canonical runtime approval and preserves the draft across a paused dialogue', async t => {
    const f = await fixture(t), draft = await f.service.draft([{ id: 'alpha', quantity: 2 }], 'replace');
    const service = new McpService(() => ({ kira_yandex_lavka: nativeCommerceServers().kira_yandex_lavka }), async () =>
        connectCommerceMcp(f.service, () => { const operationId = commerceInvocation()?.approvedOperation; return operationId ? { operationId } : undefined; }));
    const value: KiraRuntimeInput = { ctx: { from: { id: 96021 }, chat: { id: 96021, type: 'private' }, agentRuntimeStorageKey: 'api:synthetic-commerce-runtime', session: { messageHistory: [], reminders: [], domains: {} } } as any,
        message: 'Собери предложенную корзину в Лавке', classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { mcpAccess: 'write', mcpServers: ['kira_yandex_lavka'] } },
        isForwarded: false, forwardFrom: '', messageHistory: [] };
    const shared = liveBrowserSessions.create(96021, 'api:synthetic-commerce-runtime', 'synthetic-operation'); shared.commerceProvider = 'yandex-lavka'; shared.commercePersistentLogin = true;
    shared.attach({ inspect: async () => { throw Error('No screenshots in hidden synthetic task'); }, capture: async () => { throw Error('No capture'); }, input: async () => {}, close: async () => {} }); t.after(() => shared.dispose());
    let phase = 0;
    const dependencies = { registry: new ToolRegistry(mcpTools(service), () => true), persist: async () => {}, respond: async () => ({ responseText: 'Проверенный итог корзины' }),
        decide: async () => phase++ === 0 ? { calls: [{ id: 'apply', tool: 'mcp.callTool', args: { server: 'kira_yandex_lavka', tool: 'apply_cart', argumentsJson: JSON.stringify({ draftId: draft.id, revision: draft.revision }) } }] } : { finish: true } };
    const first = await runKiraRuntime(value, dependencies);
    assert.equal(first.operationStatus, 'needs_input'); assert.equal(f.writes(), 0); assert.equal(shared.state, 'needs_user');
    assert.match(shared.snapshot().assistanceRequest!.prompt, /2 × Продукт Альфа/);
    assert.match(value.ctx.session.agentRuntime!.question!, /200\.00 ₽/);
    const runId = value.ctx.session.agentRuntime!.runId;
    value.ctx.session.agentRuntime = JSON.parse(JSON.stringify(value.ctx.session.agentRuntime));
    const result = await continueQuestionRuntime(value.ctx, 'да', dependencies);
    assert.equal(result?.operationStatus, 'ok'); assert.equal(f.writes(), 1); assert.equal(value.ctx.session.agentRuntime!.runId, runId);
    assert.equal((await f.store.snapshot()).drafts[0].id, draft.id);
    assert.deepEqual((await f.store.snapshot()).orders, [], 'applied basket is not an order or payment');
});
