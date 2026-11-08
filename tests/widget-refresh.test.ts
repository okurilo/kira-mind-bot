import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UiRefreshService, parseRefreshRequest } from '../generative-ui/refresh';
import { compileRefreshRecipe, fillRefreshTemplate } from '../generative-ui/refreshTemplate';
import { uiCapability, UI_CATALOG_ID, UI_CATALOG_V2 } from '../generative-ui/contracts';
import { fixtureSnapshot } from '../scripts/generateUiExamples';
import { MemoryUiStore } from './helpers/generativeUi';
import { UiService } from '../generative-ui/service';
import { ApiError } from '../api/contracts';
import { withUiRefreshCapture, uiRefreshEvidence, rememberRefreshEvidence, citationSources } from '../generative-ui/refreshEvidence';
import * as completion from '../ai/responseCompletion';
import { searchRefreshValues } from '../generative-ui/refreshSearch';
import { composeUi } from '../generative-ui/compose';
import * as policy from '../ai/accountPolicy';
import { evaluateWidgetRefresh } from '../scripts/evalWidgetRefresh';

const owner = 730001, url = 'https://example.org/observations', t0 = '2041-04-12T19:00:00Z', t1 = '2041-04-12T20:00:00Z';
const request = { enabled: true as const, catalogId: UI_CATALOG_ID, refresh: true as const };
function fixture(search = false, v2 = false) {
    const ui = fixtureSnapshot([{ id: 'root', component: 'Metric', label: 'Синтетическая температура', value: '18 °C' }], v2);
    const data = { identity: "synthetic-station:celsius", asOf: t0, sources: [{ label: 'Учебный источник', url }], values: { temperature: 18 } };
    const source = search ? { kind: 'search' as const, query: 'Учебная температура в тестовом городе', text: `Температура 18 °C на ${t0}. ${url}`, sources: data.sources }
        : { kind: 'data' as const, adapter: 'mcp' as const, server: 'synthetic', tool: 'observation', args: { station: 'example' }, authority: 'synthetic-authority', data };
    const draft = { source: 0, subject: 'Учебная температура в тестовом городе, градусы Цельсия', sourceUrl: url, asOf: t0,
        slots: [{ id: 'temperature', componentId: 'root', path: ['value'], description: 'Температура в °C, строка с единицей', ...(search ? {} : { sourceField: 'temperature', suffix: ' °C' }) }] };
    const recipe = compileRefreshRecipe(draft, ui, [source])!; assert.ok(recipe);
    return { ui, source, data, draft, recipe, sid: ui.messages[0].createSurface.surfaceId };
}

test('refresh is an explicit capability/turn opt-in and never inferred from an API call or static text', async t => {
    const capability = uiCapability(); assert.ok('refresh' in capability && capability.refresh.enabled);
    const old = process.env.KIRA_UI_REFRESH_ENABLED; process.env.KIRA_UI_REFRESH_ENABLED = 'false';
    t.after(() => { if (old === undefined) delete process.env.KIRA_UI_REFRESH_ENABLED; else process.env.KIRA_UI_REFRESH_ENABLED = old; });
    assert.equal('refresh' in uiCapability(), false);
    await withUiRefreshCapture(true, async () => { rememberRefreshEvidence(fixture().source); assert.deepEqual(uiRefreshEvidence(), []); });
    assert.throws(() => parseRefreshRequest({ items: [], ui: request }));
    assert.throws(() => parseRefreshRequest({ items: Array.from({ length: 11 }, () => ({ token: 'x', surfaceId: fixture().sid })), ui: request }), (e: any) => e.status === 413);
    for (const ui of [{ ...request, refresh: 'true' }, { ...request, refresh: false }, { enabled: false }]) assert.throws(() => parseRefreshRequest({ items: [{ token: 'x', surfaceId: fixture().sid }], ui }));
});

test('recipe binds only real source evidence and exact mutable leaves, preserving layout/IDs and rejecting interactive widgets', () => {
    const f = fixture();
    assert.equal(compileRefreshRecipe(f.draft, f.ui, []), undefined);
    for (const draft of [{ ...f.draft, sourceUrl: 'https://other.example.org' }, { ...f.draft, slots: [{ ...f.draft.slots[0], path: ['label'] }] },
        { ...f.draft, slots: [{ ...f.draft.slots[0], sourceField: 'unknown' }] }, { ...f.draft, slots: [f.draft.slots[0], f.draft.slots[0]] }]) assert.equal(compileRefreshRecipe(draft, f.ui, [f.source]), undefined);
    for (const values of [{ temperature: { code: 'run' } }, { temperature: '19 °C', injected: 'x' }, { temperature: 19 }, {}]) assert.equal(fillRefreshTemplate(f.ui, f.recipe.slots, values, t1), undefined);
    const next = fillRefreshTemplate(f.ui, f.recipe.slots, { temperature: '19 °C' }, t1)!;
    assert.equal(next.messages[0].createSurface.surfaceId, f.sid); assert.equal(next.messages[0].createSurface.components[0].id, 'root');
    assert.equal((next.messages[0].createSurface.components[0] as any).label, 'Синтетическая температура');
    const actionUi = fixtureSnapshot([{ id: 'root', component: 'Column', children: ['metric', 'button'] },
        { id: 'metric', component: 'Metric', label: 'Показатель', value: '18 °C' },
        { id: 'button', component: 'Button', child: 'label', action: { event: { name: 'kira.reply', context: { actionToken: 'synthetic.signature' } } } },
        { id: 'label', component: 'Text', text: 'Изменить' }]);
    assert.equal(compileRefreshRecipe({ ...f.draft, slots: [{ ...f.draft.slots[0], componentId: 'metric' }] }, actionUi, [f.source]), undefined);
});

test('data refresh changes only bound values, uses no model, rotates a long-lived token and recovers missed responses from cache', async () => {
    const f = fixture(), store = new MemoryUiStore(); let now = 1_000_000, calls = 0, tasks = 0;
    const service = new UiRefreshService(owner, store, () => now, { allowed: async () => true,
        data: async source => { calls++; assert.deepEqual(source.args, { station: 'example' }); return { ...f.data, asOf: t1, values: { temperature: 19 } }; },
        search: async () => { assert.fail('data must not invoke an LLM'); }, run: async (_key, work) => { tasks++; return work(); } });
    const meta = await service.register(f.ui, f.recipe, request); assert.ok(meta); assert.equal(meta.kind, 'data');
    const item = { token: meta.token, surfaceId: f.sid }, body = { items: [item], ui: request };
    assert.equal((await service.batch(body, 'early-key')).results[0].status, 'tooEarly'); assert.equal(calls, 0);
    now += 600_000;
    const result = (await service.batch(body, 'update-key')).results[0]; assert.equal(result.status, 'updated'); assert.equal(calls, 1); assert.equal(tasks, 1);
    assert.equal((result.ui.messages[0].createSurface.components[0] as any).value, '19 °C'); assert.notEqual(result.uiRefresh.token, meta.token);
    const recovered = (await new UiRefreshService(owner, store, () => now).batch(body, 'recover-key')).results[0];
    assert.equal(recovered.status, 'updated'); assert.deepEqual(recovered.ui, result.ui); assert.equal(calls, 1);
    const fresh = { items: [{ ...item, token: result.uiRefresh.token }], ui: request };
    assert.equal((await service.batch(fresh, 'too-early-key')).results[0].status, 'tooEarly');
    now += 600_000;
    const unchanged = (await service.batch(fresh, 'same-values-key')).results[0]; assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.ui, undefined);
    assert.equal((await new UiRefreshService(owner + 1, store, () => now).batch(body, 'other-owner')).results[0].status, 'gone');
    const wrong = { ...body, items: [{ ...item, surfaceId: 'kira_22222222222242228222222222222222' }] };
    assert.equal((await service.batch(wrong, 'wrong-surface')).results[0].status, 'gone');
    now += 30 * 86400_000 + 1;
    assert.equal((await service.batch(fresh, 'expired-key')).results[0].status, 'gone');
});

test('source failure/stale timestamps/layout injection preserve the snapshot; budget and per-account rate do not spend dialogue quota', async () => {
    const f = fixture(true), store = new MemoryUiStore(); let now = 1_000_000, count = 0;
    const service = new UiRefreshService(owner, store, () => now, { allowed: async () => true, run: async (_key, work) => work(),
        search: async () => { count++; if (count === 1) throw Error('source unavailable'); if (count === 2) return { asOf: t0, values: { temperature: '19 °C', surfaceId: 'new' } };
            if (count === 3) throw new ApiError(429, 'background_quota_exhausted', 'Synthetic quota'); return { asOf: '2040-01-01T00:00:00Z', values: { temperature: '1 °C' } }; } });
    const meta = (await service.register(f.ui, f.recipe, request))!, body = { items: [{ token: meta.token, surfaceId: f.sid }], ui: request };
    assert.equal(meta.minIntervalSeconds, 3600);
    for (const status of ['failed', 'failed', 'tooEarly', 'failed']) { now += 3600_000; assert.equal((await service.batch(body, 'case-' + count)).results[0].status, status); }
    const row = [...store.rows.get(owner)!.entries()].find(([k]) => k.startsWith('refresh:'))![1] as any;
    assert.deepEqual(row.ui, f.ui);
    const unknown = { items: [{ token: 'unknown', surfaceId: f.sid }], ui: request };
    now += 60_000;
    for (let i = 0; i < 30; i++) await service.batch(unknown, 'rate-' + i);
    await assert.rejects(service.batch(unknown, 'rate-exceeded'), (e: any) => e.status === 429 && e.retryAfterSeconds > 0 && e.released);
});

test('a lease coalesces concurrent requests and revoked bindings suppress a late result', async () => {
    const f = fixture(), store = new MemoryUiStore(); let now = 1_000_000, calls = 0;
    let release!: () => void; const blocked = new Promise<void>(r => { release = r; });
    const service = new UiService(owner, store, () => now, { allowed: async () => true, run: async (_key, work) => work(), data: async () => { calls++; await blocked; return { ...f.data, asOf: t1, values: { temperature: 19 } }; } });
    const device = (await service.saveDevice('11111111-1111-4111-8111-111111111111', { catalogId: UI_CATALOG_V2, proactive: false, diagnostics: false })).device;
    const meta = (await service.refresh.register(f.ui, f.recipe, { ...request, device: { id: device.id, bindingId: device.bindingId } }))!;
    const body = { items: [{ token: meta.token, surfaceId: f.sid }], ui: request }; now += 600_000;
    const first = service.refresh.batch(body, 'concurrent-one');
    while (!calls) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await service.refresh.batch(body, 'concurrent-two')).results[0].status, 'tooEarly');
    await service.revokeDevice(device.id); release();
    assert.equal((await first).results[0].status, 'gone'); assert.equal(calls, 1);
});

test('search refresh makes one isolated economic structured search call, pins the source and refuses layout keys', async t => {
    const f = fixture(true); let calls = 0;
    const ai = t.mock.method(completion, 'createSingleResponseForTask', async (_task: unknown, body: any) => {
        calls++; assert.equal(body.store, false); assert.equal(body.text.format.type, 'json_schema');
        const input = JSON.stringify(body.input); assert.ok(!input.includes('messageHistory')); assert.ok(!input.includes('components'));
        return { output_text: JSON.stringify({ found: true, asOf: t1, sourceUrl: url, values: { temperature: '19 °C' } }),
            output: [{ type: 'message', content: [{ annotations: [{ type: 'url_citation', url, title: 'Учебный источник' }] }] }] } as any;
    });
    assert.deepEqual(await searchRefreshValues(f.recipe, f.ui), { asOf: t1, values: { temperature: '19 °C' } }); assert.equal(calls, 1);
    ai.mock.mockImplementation(async () => ({ output_text: JSON.stringify({ found: true, asOf: t1, sourceUrl: 'https://wrong.example.org', values: { temperature: '19 °C' } }), output: [] }) as any);
    await assert.rejects(searchRefreshValues(f.recipe, f.ui)); assert.equal(calls, 1);
});

test('compositor can propose a source-bound recipe in the existing call, while its wire snapshot stays strict v1', async () => {
    const f = fixture(); let recipe: unknown;
    const ui = await composeUi('Покажи показатель', { id: -1001, type: 'text', text: `Учебная температура 18 °C. ${url}` }, () => 'synthetic.signature',
        async (_prompt, input) => { assert.equal(JSON.parse(input).refreshSources[0].kind, 'data'); assert.ok(!input.includes('synthetic-authority'));
            return JSON.stringify({ components: f.ui.messages[0].createSurface.components, refresh: f.draft }); }, { request, refreshSources: [f.source], onRefreshRecipe: r => { recipe = r; } });
    assert.ok(ui); assert.ok(recipe); assert.equal('refresh' in ui, false);
    assert.equal(await new UiRefreshService(owner, new MemoryUiStore()).register(ui, f.recipe, { enabled: true, catalogId: UI_CATALOG_ID }), undefined);
});

test('refresh inside a foreground HTTP scope opens a separate background operation and restores the dialogue scope', async t => {
    const f = fixture(), store = new MemoryUiStore(); let now = 1_000_000, tasks = 0;
    t.mock.method(policy, 'withBackgroundAiTask', async <T>(kind: string, key: string, work: () => Promise<T>) => {
        tasks++; assert.equal(kind, 'widget-refresh');
        return policy.withAccountAiOperation({ id: policy.backgroundAiTaskId(kind, key), background: true }, work);
    });
    const service = new UiRefreshService(owner, store, () => now, { allowed: async () => true, data: async () => {
        assert.equal(policy.currentAccountAiOperation()!.background, true); return { ...f.data, asOf: t1, values: { temperature: 19 } };
    } });
    const meta = (await service.register(f.ui, f.recipe, request))!; now += 600_000;
    await policy.withAccountAiOperation({ id: 'synthetic-dialogue-request', background: false }, async () => {
        assert.equal((await service.batch({ items: [{ token: meta.token, surfaceId: f.sid }], ui: request }, 'background-scope-key')).results[0].status, 'updated');
        assert.deepEqual(policy.currentAccountAiOperation(), { id: 'synthetic-dialogue-request', background: false });
    });
    assert.equal(tasks, 1);
});

test('synthetic refresh eval does not count malformed/provider failures as valid decisions to omit a recipe', async () => {
    const report = await evaluateWidgetRefresh(async () => { throw Error('offline'); });
    assert.equal(report.total, 8); assert.equal(report.passed, 0);
    assert.equal((await evaluateWidgetRefresh(async () => '{}')).passed, 0);
});

test('data identities/units and field types are pinned, and an explicit surface deletion revokes the independent token', async () => {
    const f = fixture(false, true), store = new MemoryUiStore(); let now = 1_000_000, attempt = 0;
    const service = new UiService(owner, store, () => now, { allowed: async () => true, run: async (_key, work) => work(), data: async () => {
        attempt++; return { ...f.data, asOf: t1, identity: attempt === 1 ? 'another-unit' : f.data.identity, values: { temperature: attempt === 2 ? '19' : 19 } };
    } });
    const ui = { ...request, catalogId: UI_CATALOG_V2 };
    await service.record(f.ui, -1001, ui);
    const meta = (await service.refresh.register(f.ui, f.recipe, ui))!, body = { items: [{ token: meta.token, surfaceId: f.sid }], ui };
    for (let i = 0; i < 2; i++) { now += 600_000; assert.equal((await service.refresh.batch(body, 'type-' + i)).results[0].status, 'failed'); }
    now += 600_000; const result = (await service.refresh.batch(body, 'good-data')).results[0]; assert.equal(result.status, 'updated'); assert.equal(result.ui.revision, 2);
    assert.equal((await service.surface(f.sid))!.revision, 2); assert.equal((await service.events()).uiEvents.length, 0);
    await service.delete(f.sid, 2);
    assert.equal((await service.refresh.batch(body, 'deleted-data')).results[0].status, 'gone');
});

test('whole chart series and table matrices refresh atomically while dimensions, component IDs and all unbound fields stay fixed', () => {
    const ui = fixtureSnapshot([{ id: 'root', component: 'Column', children: ['chart', 'table', 'progress'] },
        { id: 'chart', component: 'Chart', kind: 'line', labels: ['A', 'B'], series: [{ label: 'Учебный ряд', values: [1, 2] }], unit: 'шт.' },
        { id: 'table', component: 'Table', columns: ['Объект', 'Значение'], rows: [['Первый', '1'], ['Второй', '2']] },
        { id: 'progress', component: 'Progress', label: 'Учебная цель', value: 0.5 }], true);
    const source = { kind: 'data' as const, adapter: 'mcp' as const, server: 'synthetic', tool: 'series', args: {}, authority: 'synthetic', data: {
        identity: 'synthetic-series:unit', asOf: t0, sources: [{ label: 'Источник', url }], values: { series: [1, 2], rows: [['Первый', '1'], ['Второй', '2']], progress: 0.5 } } };
    const slots = [
        { id: 'series', componentId: 'chart', path: ['series', 0, 'values'], description: 'Учебные точки, шт.', sourceField: 'series' },
        { id: 'rows', componentId: 'table', path: ['rows'], description: 'Учебная таблица', sourceField: 'rows' },
        { id: 'progress', componentId: 'progress', path: ['value'], description: 'Доля цели', sourceField: 'progress' },
    ];
    const draft = { source: 0, subject: 'Учебные объекты и ряд', sourceUrl: url, slots };
    const recipe = compileRefreshRecipe(draft, ui, [source]); assert.ok(recipe);
    const next = fillRefreshTemplate(ui, slots, { series: [3, 4], rows: [['Первый', '3'], ['Второй', '4']], progress: 0.7 }, t1)!;
    assert.ok(next); assert.deepEqual((next.messages[0].createSurface.components[1] as any).series[0].values, [3, 4]);
    assert.deepEqual((next.messages[0].createSurface.components[2] as any).columns, ['Объект', 'Значение']);
    assert.equal(fillRefreshTemplate(ui, slots, { series: [3, 4, 5], rows: source.data.values.rows, progress: 0.7 }, t1), undefined);
    assert.equal(fillRefreshTemplate(ui, slots, { series: [3, 4], rows: [['Первый', 3], ['Второй', '4']], progress: 0.7 }, t1), undefined);
    assert.equal(compileRefreshRecipe({ ...draft, slots: [...slots, { ...slots[0], id: 'nested', path: ['series', 0, 'values', 0] }] }, ui, [source]), undefined);
});

test('bare API numbers bind to their exact string display and search cannot invent API fields', () => {
    const f = fixture(), ui = fixtureSnapshot([{ id: 'root', component: 'Metric', label: 'Учебное значение', value: '18' }]);
    const { suffix, ...slot } = f.draft.slots[0];
    const recipe = compileRefreshRecipe({ ...f.draft, slots: [slot] }, ui, [f.source]); assert.ok(recipe);
    assert.equal(recipe.slots[0].prefix, '');
    const search = fixture(true);
    assert.equal(compileRefreshRecipe({ ...search.draft, slots: [{ ...search.draft.slots[0], sourceField: 'invented' }] }, search.ui, [search.source]), undefined);
});

test('structured search accepts authoritative tool source lists without requiring inline prose citations', async t => {
    const f = fixture(true);
    t.mock.method(completion, 'createSingleResponseForTask', async (_task: unknown, body: any) => {
        assert.deepEqual(body.include, ['web_search_call.action.sources']);
        return { output_text: JSON.stringify({ found: true, asOf: t1, sourceUrl: url, values: { temperature: '19 °C' } }),
            output: [{ type: 'web_search_call', action: { sources: [{ type: 'url', url }] } }] } as any;
    });
    assert.equal((await searchRefreshValues(f.recipe, f.ui)).asOf, t1);
    assert.deepEqual(citationSources({ output: [{ type: 'web_search_call', action: { sources: [{ url: 'http://example.org/unsafe' }] } }] }), []);
});

test('freshness-only refresh keeps the exact v2 snapshot/revision and prevents a later explicit update from rolling data time back', async () => {
    const f = fixture(false, true); f.ui.meta = { asOf: t0 };
    let now = 1_000_000; const service = new UiService(owner, new MemoryUiStore(), () => now, { allowed: async () => true, run: async (_key, work) => work(), data: async () => ({ ...f.data, asOf: t1 }) });
    const ui = { ...request, catalogId: UI_CATALOG_V2 };
    await service.record(f.ui, -1001, ui);
    const meta = (await service.refresh.register(f.ui, f.recipe, ui))!; now += 600_000;
    const result = (await service.refresh.batch({ items: [{ token: meta.token, surfaceId: f.sid }], ui }, 'freshness-only')).results[0];
    assert.equal(result.status, 'unchanged'); assert.equal(result.uiRefresh.asOf, t1);
    assert.deepEqual((await service.surface(f.sid))!.ui, f.ui);
    now += 60_000;
    await assert.rejects(service.update(f.sid, 1, f.ui), (e: any) => e.code === 'ui_data_stale');
});
