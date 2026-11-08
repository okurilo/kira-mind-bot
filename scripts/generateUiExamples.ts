import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { UI_CAPABILITY, UI_CATALOG_ID, UI_CATALOG_V2, type UiComponent, type UiPayload } from '../generative-ui/contracts';

const sid = 'kira_11111111111141118111111111111111';
const token = 'synthetic_reply.signature';
const text = (id = 'root', content = 'Синтетический пример') => ({ id, component: 'Text', text: content });
const tree = (...children: any[]) => [{ id: 'root', component: 'Column', children: children.map(c => c.id) }, ...children];
export function fixtureSnapshot(components: any[] = [text()], v2 = false): UiPayload {
    const catalogId = v2 ? UI_CATALOG_V2 : UI_CATALOG_ID;
    return { protocol: 'a2ui', version: '1.0', catalogId, ...(v2 ? { revision: 1 } : {}), messages: [{ version: '1.0', createSurface: { surfaceId: sid, catalogId, components } }] };
}
export function uiExampleFiles(): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    const valid = (name: string, components: any[]) => { files[`valid/${name}.json`] = fixtureSnapshot(components); };
    const invalid = (name: string, modify: (value: any) => void, base = fixtureSnapshot()) => {
        const value = structuredClone(base); modify(value); files[`invalid/${name}.json`] = value;
    };
    const surface = (v: any) => v.messages[0].createSurface;
    const component = (v: any) => surface(v).components[0];
    valid('text', [text()]); valid('text-3000', [text('root', 'x'.repeat(3000))]);
    valid('metric-string', [{ id: 'root', component: 'Metric', label: 'Температура', value: '18 °C', detail: 'Учебные данные', tone: 'neutral' }]);
    valid('card-row', [{ id: 'root', component: 'Card', child: 'row' }, { id: 'row', component: 'Row', children: ['a', 'b'], gap: 'small' }, text('a'), text('b')]);
    valid('divider', [{ id: 'root', component: 'Divider' }]);
    const table = (columns = 6, rows = 1) => [{ id: 'root', component: 'Table', columns: Array.from({ length: columns }, (_, i) => `Колонка ${i + 1}`), rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => 'Учебное значение')) }];
    valid('table-6-columns', table()); valid('table-24-rows', table(2, 24));
    const chart = (points = 48, count = 4, kind = 'line') => [{ id: 'root', component: 'Chart', kind, labels: Array.from({ length: points }, (_, i) => String(i + 1)), series: Array.from({ length: count }, (_, i) => ({ label: `Ряд ${i + 1}`, values: Array.from({ length: points }, (_, j) => j + 1) })), unit: 'шт.' }];
    valid('chart-48-points-4-series', chart()); valid('chart-bar', chart(3, 1, 'bar')); valid('chart-donut', chart(3, 1, 'donut'));
    const button = (action: unknown) => [{ id: 'root', component: 'Button', child: 'label', action }, { ...text('label', 'Подробнее'), variant: 'caption' }];
    valid('button-reply-text-variant', button({ event: { name: 'kira.reply', context: { actionToken: token } } }));
    valid('button-existing', button({ event: { name: 'kira.action', context: { actionToken: token } } }));
    valid('button-open-url', button({ functionCall: { '@call': 'openUrl', args: { url: 'https://example.org/details' } } }));
    valid('token-4097', button({ event: { name: 'kira.reply', context: { actionToken: 'a'.repeat(4097) } } }));
    valid('children-16', tree(...Array.from({ length: 16 }, (_, i) => text(`t${i}`))));
    const depth = (n: number) => Array.from({ length: n }, (_, i) => i === n - 1 ? text(`n${i}`) : { id: i === 0 ? 'root' : `n${i}`, component: 'Card', child: `n${i + 1}` });
    valid('depth-8', depth(8));
    const nodes = (n: number) => [{ id: 'root', component: 'Column', children: ['g0', 'g1', 'g2', 'g3'] }, ...Array.from({ length: 4 }, (_, g) => {
        const children = Array.from({ length: g < 3 ? 15 : n - 50 }, (_, i) => text(`t${g}_${i}`));
        return [{ id: `g${g}`, component: 'Column', children: children.map(c => c.id) }, ...children];
    }).flat()];
    valid('nodes-64', nodes(64));
    const bytes = (size: number) => {
        const value = fixtureSnapshot(tree(...Array.from({ length: 11 }, (_, i) => text(`t${i}`, 'x'))));
        let missing = size - Buffer.byteLength(JSON.stringify(value));
        for (const c of value.messages[0].createSurface.components) if (c.component === 'Text') { const add = Math.min(2999, missing); c.text += 'x'.repeat(add); missing -= add; }
        if (missing !== 0) throw Error('Fixture size'); return value;
    };
    files['valid/bytes-32768.json'] = bytes(32768);
    files['invalid/bytes-32769.json'] = bytes(32769);
    invalid('unknown-envelope-field', v => { v.code = 'untrusted'; });
    invalid('unknown-message-field', v => { v.messages[0].unknown = true; });
    invalid('surface-theme', v => { surface(v).theme = {}; }); invalid('surface-send-data-model', v => { surface(v).sendDataModel = true; });
    invalid('protocol-version', v => { v.version = '0.8'; }); invalid('message-version', v => { v.messages[0].version = '0.9'; });
    invalid('unknown-catalog', v => { v.catalogId = 'urn:unknown'; }); invalid('catalog-mismatch', v => { surface(v).catalogId = UI_CATALOG_V2; });
    invalid('two-messages', v => { v.messages.push(structuredClone(v.messages[0])); }); invalid('empty-messages', v => { v.messages = []; });
    invalid('surface-id', v => { surface(v).surfaceId = 'arbitrary-surface'; });
    invalid('id-starts-digit', v => { component(v).id = '1root'; }); invalid('id-too-long', v => { component(v).id = 'a'.repeat(49); });
    invalid('empty-components', v => { surface(v).components = []; }); invalid('null-components', v => { surface(v).components = null; });
    invalid('missing-child', v => { surface(v).components = [{ id: 'root', component: 'Card', child: 'missing' }]; });
    invalid('cycle', v => { surface(v).components = [{ id: 'root', component: 'Card', child: 'root' }]; });
    invalid('duplicate-id', v => { surface(v).components.push(text()); }); invalid('orphan', v => { surface(v).components.push(text('orphan')); });
    invalid('shared-child', v => { surface(v).components = [{ id: 'root', component: 'Column', children: ['t', 't'] }, text('t')]; });
    invalid('empty-children', v => { surface(v).components = [{ id: 'root', component: 'Column', children: [] }]; });
    invalid('children-17', v => { surface(v).components = tree(...Array.from({ length: 17 }, (_, i) => text(`t${i}`))); });
    invalid('depth-9', v => { surface(v).components = depth(9); }); invalid('nodes-65', v => { surface(v).components = nodes(65); });
    invalid('webview', v => { component(v).component = 'WebView'; }); invalid('expression', v => { component(v).text = { '@path': '/secret' }; });
    invalid('text-3001', v => { component(v).text = 'x'.repeat(3001); }); invalid('blank-text', v => { component(v).text = '  '; });
    invalid('null-optional', v => { component(v).variant = null; }); invalid('unknown-component-field', v => { component(v).onLoad = 'execute'; });
    invalid('metric-number', v => { surface(v).components = [{ id: 'root', component: 'Metric', label: 'Цена', value: 18 }]; });
    invalid('table-7-columns', v => { surface(v).components = table(7); }); invalid('table-25-rows', v => { surface(v).components = table(2, 25); });
    invalid('empty-table', v => { surface(v).components = table(2, 0); }); invalid('table-row-width', v => { surface(v).components = table(2); component(v).rows[0].pop(); });
    invalid('chart-49-points', v => { surface(v).components = chart(49); }); invalid('chart-5-series', v => { surface(v).components = chart(3, 5); });
    invalid('chart-empty-labels', v => { surface(v).components = chart(0, 1); }); invalid('chart-length-mismatch', v => { surface(v).components = chart(3, 1); component(v).series[0].values.pop(); });
    invalid('chart-non-number', v => { surface(v).components = chart(3, 1); component(v).series[0].values[0] = '1'; });
    invalid('donut-negative', v => { surface(v).components = chart(3, 1, 'donut'); component(v).series[0].values[0] = -1; });
    invalid('donut-zero', v => { surface(v).components = chart(3, 1, 'donut'); component(v).series[0].values.fill(0); });
    invalid('button-container-child', v => { surface(v).components = [{ id: 'root', component: 'Button', child: 'c', action: { event: { name: 'kira.reply', context: { actionToken: token } } } }, { id: 'c', component: 'Column', children: ['t'] }, text('t')]; });
    invalid('token-whitespace', v => { surface(v).components = button({ event: { name: 'kira.reply', context: { actionToken: 'token value' } } }); });
    invalid('token-32001', v => { surface(v).components = button({ event: { name: 'kira.reply', context: { actionToken: 'x'.repeat(32001) } } }); });
    invalid('arbitrary-function', v => { surface(v).components = button({ functionCall: { '@call': 'fetch', args: { url: 'https://example.org' } } }); });
    invalid('insecure-url', v => { surface(v).components = button({ functionCall: { '@call': 'openUrl', args: { url: 'http://example.org' } } }); });
    invalid('seven-buttons', v => { surface(v).components = tree(...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, component: 'Button', child: `t${i}`, action: { event: { name: 'kira.reply', context: { actionToken: token } } } })), ...Array.from({ length: 7 }, (_, i) => text(`t${i}`))); surface(v).components[0].children = Array.from({ length: 7 }, (_, i) => `b${i}`); });
    invalid('surface-id-array', v => { surface(v).surfaceId = [surface(v).surfaceId]; });
    invalid('v1-metadata-without-negotiation', v => { v.meta = { title: 'Заголовок' }; }); invalid('v1-new-component', v => { surface(v).components = [{ id: 'root', component: 'Progress', label: 'Цель', value: 0.5 }]; });
    const v2 = (name: string, components: any[]) => { files[`v2/valid/${name}.json`] = fixtureSnapshot(components, true); };
    v2('progress', [{ id: 'root', component: 'Progress', label: 'Синтетическая цель', value: 0.5, detail: '50 из 100' }]);
    v2('steps', [{ id: 'root', component: 'Steps', items: [{ label: 'Первый этап', state: 'done' }, { label: 'Второй этап', state: 'current' }, { label: 'Третий этап', state: 'todo' }] }]);
    v2('map', [{ id: 'root', component: 'Map', pins: [{ lat: 52.37, lon: 4.89, label: 'Учебная точка' }], region: { lat: 52.37, lon: 4.89, latitudeDelta: 0.1, longitudeDelta: 0.1 } }]);
    v2('image', [{ id: 'root', component: 'Image', fileId: '11111111-1111-4111-8111-111111111111', alt: 'Синтетическая иллюстрация' }]);
    v2('countdown', [{ id: 'root', component: 'Countdown', until: '2041-04-12T19:00:00Z', label: 'Учебный таймер' }]);
    v2('checklist', [{ id: 'root', component: 'Checklist', items: [{ id: 'milk', label: 'Молоко', checked: false, actionToken: token }, { id: 'bread', label: 'Хлеб', checked: true }] }]);
    const fields = [
        { id: 'choice', component: 'Choice', label: 'Способ', options: [{ value: 'a', label: 'Первый' }, { value: 'b', label: 'Второй' }], value: 'a' },
        { id: 'slider', component: 'Slider', label: 'Минуты', min: 10, max: 60, step: 5, value: 20 },
        { id: 'toggle', component: 'Toggle', label: 'С разминкой', value: true },
        { id: 'when', component: 'DateTime', label: 'Время', min: '2041-04-12T18:00:00Z', max: '2041-04-12T22:00:00Z', value: '2041-04-12T19:00:00Z' },
    ];
    v2('form', [{ id: 'root', component: 'Column', children: [...fields.map(f => f.id), 'submit'] }, ...fields,
        { id: 'submit', component: 'Button', child: 'submitLabel', action: { event: { name: 'kira.submit', context: { actionToken: token, fields: fields.map(f => f.id) } } } }, text('submitLabel', 'Подготовить план')]);
    const withMeta = fixtureSnapshot([text()], true); withMeta.meta = { title: 'Учебный прогноз', asOf: '2041-04-12T19:00:00Z', sources: [{ label: 'Учебный источник', url: 'https://example.org/weather' }] };
    files['v2/valid/metadata.json'] = withMeta;
    const extension = fixtureSnapshot(); extension.meta = withMeta.meta; files['metadata/valid/v1-explicit-extension.json'] = extension;
    const change = { protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_V2, revision: 2, meta: withMeta.meta,
        messages: [{ version: '1.0', updateComponents: { surfaceId: sid, components: [text('root', 'Обновлённые учебные данные')] } }] };
    files['v2/valid/update.json'] = change;
    files['v2/valid/delete.json'] = { protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_V2, revision: 3, messages: [{ version: '1.0', deleteSurface: { surfaceId: sid } }] };
    const badV2 = (name: string, source: string, edit: (v: any) => void) => { const value = structuredClone(files['v2/valid/' + source + '.json']); edit(value); files['v2/invalid/' + name + '.json'] = value; };
    badV2('progress-out-of-range', 'progress', v => { component(v).value = 1.1; });
    badV2('map-latitude', 'map', v => { component(v).pins[0].lat = 91; });
    badV2('image-external-url', 'image', v => { component(v).fileId = 'https://example.org/image.png'; });
    badV2('image-id-array', 'image', v => { component(v).fileId = [component(v).fileId]; });
    badV2('countdown-invalid-date', 'countdown', v => { component(v).until = '2041-02-30T19:00:00Z'; });
    badV2('slider-off-grid', 'form', v => { surface(v).components.find((c: any) => c.id === 'slider').value = 21; });
    badV2('submit-unknown-field', 'form', v => { surface(v).components.find((c: any) => c.id === 'submit').action.event.context.fields.push('unknown'); });
    badV2('metadata-null', 'metadata', v => { v.meta.asOf = null; });
    badV2('metadata-title-81', 'metadata', v => { v.meta.title = 'x'.repeat(81); });
    badV2('metadata-credentials-url', 'metadata', v => { const u = new URL('https://example.org'); u.username = 'synthetic'; v.meta.sources[0].url = u.href; });
    badV2('update-no-asof', 'update', v => { delete v.meta; });
    badV2('update-revision-one', 'update', v => { v.revision = 1; });
    badV2('update-id-array', 'update', v => { v.messages[0].updateComponents.surfaceId = [sid]; });
    badV2('delete-id-array', 'delete', v => { v.messages[0].deleteSurface.surfaceId = [sid]; });
    files['capabilities.json'] = UI_CAPABILITY;
    files['history.json'] = { messages: [{ role: 'assistant', text: 'Учебный план', createdAt: '2041-04-12T19:00:00Z', id: -1001, ui: fixtureSnapshot() },
        { role: 'assistant', text: 'Привет!', createdAt: '2041-04-12T18:59:00Z' }] };
    return files;
}
if (require.main === module) {
    const check = process.argv.includes('--check');
    for (const [name, value] of Object.entries(uiExampleFiles())) {
        const path = join(__dirname, '../generative-ui/examples', name), contents = JSON.stringify(value);
        if (check) { if (readFileSync(path, 'utf8') !== contents) throw Error('UI fixture drift: ' + name); }
        else { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, contents); }
    }
    console.log(check ? 'UI examples are current' : 'Generated synthetic UI examples');
}
