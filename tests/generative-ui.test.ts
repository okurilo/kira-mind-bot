import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UI_CATALOG_ID, UI_LIMITS } from '../generative-ui/contracts';
import { parseUiRequest } from '../generative-ui/request';
import { compileUi, safeUiUrl } from '../generative-ui/validate';
import { composeUi } from '../generative-ui/compose';
import Ajv2020 from 'ajv/dist/2020';
import snapshotSchema from '../docs/generative-ui.schema.json';
import { evaluateGenerativeUi } from '../scripts/evalGenerativeUi';

const binding = { urls: new Set(['https://example.org/weather']), actions: ['server-signed-token'], replyToken: (text: string) => `signed.${Buffer.from(text).toString('base64url')}` };
const tree = (...children: any[]) => ({ components: [{ id: 'root', component: 'Column', children: children.map(item => item.id) }, ...children] });

test('semantic evaluation never counts provider failures or malformed UI as correct abstentions', async () => {
    const unavailable = await evaluateGenerativeUi(async () => { throw Error('offline'); });
    assert.equal(unavailable.passed, 0); assert.ok(unavailable.cases.every(item => item.status === 'provider_unavailable'));
    const invalid = await evaluateGenerativeUi(async () => '{"components":[]}');
    assert.equal(invalid.passed, 0); assert.ok(invalid.cases.every(item => item.status === 'invalid_schema'));
    const declined = await evaluateGenerativeUi(async () => '{"components":null}');
    assert.equal(declined.passed, 5); assert.ok(declined.cases.every(item => item.status === 'evaluated'));
});

test('UI negotiation is explicit, strict, versioned and off by default', () => {
    assert.equal(parseUiRequest(undefined), undefined);
    assert.equal(parseUiRequest({ enabled: false }), undefined);
    assert.deepEqual(parseUiRequest({ enabled: true, catalogId: UI_CATALOG_ID }), { enabled: true, catalogId: UI_CATALOG_ID });
    for (const value of [null, true, [], 'mobile', {}, { enabled: 'true' }, { enabled: true },
        { enabled: true, catalogId: UI_CATALOG_ID, code: 'js' }, { enabled: false, catalogId: 'untrusted' }]) assert.throws(() => parseUiRequest(value));
    assert.throws(() => parseUiRequest({ enabled: true, catalogId: 'urn:unknown' }), (error: any) => error.code === 'unsupported_ui_catalog');
});

test('catalog composes layouts, metrics, tables, charts and three bounded action kinds into an A2UI snapshot', () => {
    const payload = compileUi(tree(
        { id: 'title', component: 'Text', text: 'Синтетический прогноз', variant: 'title' },
        { id: 'metric', component: 'Metric', label: 'Температура', value: '18 °C', tone: 'neutral' },
        { id: 'table', component: 'Table', columns: ['День', '°C'], rows: [['Сегодня', '18'], ['Завтра', '20']] },
        { id: 'chart', component: 'Chart', kind: 'line', labels: ['Сегодня', 'Завтра'], series: [{ label: 'Температура', values: [18, 20] }], unit: '°C' },
        { id: 'line', component: 'Divider' },
    ), binding)!;
    assert.ok(payload);
    const validate = new Ajv2020({ validateFormats: false }).compile(snapshotSchema);
    assert.equal(validate(payload), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...payload, version: '0.8' }), false);
    assert.equal(payload.messages[0].version, '1.0');
    assert.equal(payload.messages[0].createSurface.catalogId, UI_CATALOG_ID);
    assert.match(payload.messages[0].createSurface.surfaceId, /^kira_[a-f0-9]{32}$/);
    for (const [draft, expected] of [
        [{ type: 'reply', text: 'Покажи завтра' }, { event: { name: 'kira.reply', context: { actionToken: binding.replyToken('Покажи завтра') } } }],
        [{ type: 'existing', index: 0 }, { event: { name: 'kira.action', context: { actionToken: 'server-signed-token' } } }],
        [{ type: 'openUrl', url: 'https://example.org/weather' }, { functionCall: { '@call': 'openUrl', args: { url: 'https://example.org/weather' } } }],
    ]) {
        const compiled = compileUi({ components: [{ id: 'root', component: 'Card', child: 'button' },
            { id: 'button', component: 'Button', child: 'label', action: draft }, { id: 'label', component: 'Text', text: 'Подробнее' }] }, binding)!;
        assert.deepEqual((compiled.messages[0].createSurface.components[1] as any).action, expected);
        assert.equal(validate(compiled), true, JSON.stringify(validate.errors));
    }
    const row = compileUi({ components: [{ id: 'root', component: 'Row', children: ['a'], gap: 'small' }, { id: 'a', component: 'Text', text: 'Текст' }] }, binding);
    assert.ok(row);
});

test('invalid graphs, unknown components, expressions, code and excessive resources fail closed', () => {
    const samples = [
        { components: [] }, { components: null },
        { components: [{ id: 'root', component: 'Column', children: ['missing'] }] },
        { components: [{ id: 'root', component: 'Column', children: ['root'] }] },
        tree({ id: 'root', component: 'Text', text: 'Duplicate' }),
        { components: [{ id: 'root', component: 'Text', text: 'One' }, { id: 'orphan', component: 'Text', text: 'Two' }] },
        { components: [{ id: 'root', component: 'Column', children: ['a', 'a'] }, { id: 'a', component: 'Text', text: 'Shared' }] },
        { components: [{ id: 'root', component: 'WebView', html: '<script>test</script>' }] },
        { components: [{ id: 'root', component: 'Text', text: { '@path': '/private' } }] },
        { components: [{ id: 'root', component: 'Text', text: 'Hello', onLoad: 'execute' }] },
        { components: [{ id: 'root', component: 'Column', children: [] }] },
        tree({ id: 'text', component: 'Text', text: 'a'.repeat(3001) }),
        { components: Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, component: 'Divider' })) },
        { components: Array.from({ length: 9 }, (_, i) => i === 8 ? { id: `n${i}`, component: 'Text', text: 'Deep' }
            : { id: i === 0 ? 'root' : `n${i}`, component: 'Card', child: `n${i + 1}` }) },
        tree({ id: 'bad-id', component: 'Text', text: 'Bad ID' }),
        tree({ id: 'metric', component: 'Metric', label: 'X', value: 18 }),
        tree({ id: 'table', component: 'Table', columns: ['X', 'Y'], rows: [['only one']] }),
        tree({ id: 'chart', component: 'Chart', kind: 'line', labels: ['X'], series: [{ label: 'Y', values: [NaN] }] }),
        tree({ id: 'chart', component: 'Chart', kind: 'line', labels: ['X'], series: [{ label: 'Y', values: [1, 2] }] }),
        tree({ id: 'chart', component: 'Chart', kind: 'donut', labels: ['X'], series: [{ label: 'Y', values: [-1] }] }),
        tree({ id: 'chart', component: 'Chart', kind: 'donut', labels: ['X'], series: [{ label: 'Y', values: [0] }] }),
    ];
    for (const sample of samples) assert.equal(compileUi(sample, binding), undefined, JSON.stringify(sample).slice(0, 160));
    const huge = tree(...Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, component: 'Text', text: 'я'.repeat(2900) })));
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) > UI_LIMITS.bytes);
    assert.equal(compileUi(huge, binding), undefined);
});

test('actions accept no model-provided token, callback, function, arbitrary link or hidden subtree', () => {
    for (const action of [{ type: 'existing', index: -1 }, { type: 'existing', index: 1 }, { type: 'existing', index: 0.5 },
        { type: 'existing', index: 0, actionToken: 'forged' }, { type: 'callback', data: 'send_message' },
        { type: 'reply', text: '' }, { type: 'reply', text: 'x'.repeat(501) },
        { type: 'openUrl', url: 'https://unlisted.example.org' }, { type: 'openUrl', url: 'javascript:alert(1)' },
        { functionCall: { '@call': 'fetch', args: { url: 'https://example.org' } } }]) {
        assert.equal(compileUi({ components: [{ id: 'root', component: 'Button', child: 'label', action },
            { id: 'label', component: 'Text', text: 'Click' }] }, binding), undefined);
    }
    const hidden = { components: [{ id: 'root', component: 'Button', child: 'container', action: { type: 'reply', text: 'Visible' } },
        { id: 'container', component: 'Column', children: ['label'] }, { id: 'label', component: 'Text', text: 'Hidden' }] };
    assert.equal(compileUi(hidden, binding), undefined);
    const tooMany = { components: [{ id: 'root', component: 'Column', children: Array.from({ length: 7 }, (_, i) => `b${i}`) },
        ...Array.from({ length: 7 }, (_, i) => [{ id: `b${i}`, component: 'Button', child: `t${i}`, action: { type: 'reply', text: 'Hi' } },
            { id: `t${i}`, component: 'Text', text: 'Hi' }]).flat()] };
    assert.equal(compileUi(tooMany, binding), undefined);
    const credentials = new URL('https://example.org'); credentials.username = 'synthetic-user'; credentials.password = 'synthetic-password';
    for (const url of ['javascript:alert(1)', 'http://example.org', credentials.toString(), 'https://example.org/\n']) assert.equal(safeUiUrl(url), false);
});

test('composer preserves text, uses only final evidence and exact links, and makes malformed/absent UI optional', async () => {
    const message = { id: -1, type: 'text' as const, text: 'Прогноз: 18 °C. Источник https://example.org/weather.', format: 'plain' as const };
    const before = structuredClone(message);
    let calls = 0;
    const result = await composeUi('Какая погода?', message, binding.replyToken, async (prompt, input) => {
        calls++;
        const data = JSON.parse(input);
        assert.equal(data.answer, message.text);
        assert.deepEqual(data.urls, ['https://example.org/weather']);
        assert.match(prompt, /Не придумывай котировки/);
        return JSON.stringify(tree({ id: 'temp', component: 'Metric', label: 'Температура', value: '18 °C' }));
    });
    assert.ok(result); assert.equal(calls, 1); assert.deepEqual(message, before);
    for (const raw of ['{"components":null}', 'not JSON', '{"components":[]}', 'x'.repeat(33_000)]) {
        assert.equal(await composeUi('Вопрос', message, binding.replyToken, async () => raw), undefined);
    }
    assert.equal(await composeUi('Вопрос', message, binding.replyToken, async () => { throw Error('provider unavailable'); }), undefined);
    let skipped = 0;
    for (const item of [{ ...message, type: 'notice' as const }, { ...message, format: 'html' as const },
        { ...message, replacesMessageId: -1 }, { ...message, text: 'x'.repeat(12_001) }, { ...message, text: '' }]) {
        assert.equal(await composeUi('Вопрос', item, binding.replyToken, async () => { skipped++; return ''; }), undefined);
    }
    assert.equal(skipped, 0);
});
