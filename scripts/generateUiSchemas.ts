import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_CATALOG_ID, UI_CATALOG_V2 } from '../generative-ui/contracts';

const str = (max = 160): any => ({ type: 'string', minLength: 1, maxLength: max });
const en = (...values: string[]): any => ({ type: 'string', enum: values });
const array = (items: any, max: number, min = 1): any => ({ type: 'array', items, minItems: min, maxItems: max });
const obj = (properties: any, required = Object.keys(properties)): any => ({ type: 'object', properties, required, additionalProperties: false });
const id = { ...str(48), pattern: '^[A-Za-z][A-Za-z0-9_]{0,47}$' };
const surfaceId = { type: 'string', pattern: '^kira_[a-f0-9]{32}$' };
const uuid = { type: 'string', format: 'uuid', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const date = { ...str(24), format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' };
const tok = { ...str(32000), pattern: '^[\\x21-\\x7e]+$' };
const number = { type: 'number', minimum: -1e15, maximum: 1e15 };
const component = (name: string, fields: any, required = Object.keys(fields)) => obj({ id, component: { const: name }, ...fields }, ['id', 'component', ...required]);
export function uiSchemas() {
    const v1: any = JSON.parse(readFileSync(join(__dirname, '../docs/generative-ui.schema.json'), 'utf8'));
    v1.$defs.Action.oneOf[0].properties.event.properties.context.properties.actionToken = tok;
    const metadata = { ...obj({ title: str(80), asOf: date, sources: array(obj({ label: str(), url: { ...str(2048), format: 'uri', pattern: '^https://' } }), 8) }, []), minProperties: 1 };
    const extension = { ...structuredClone(v1), $id: 'urn:kira:ui:snapshot:1:metadata', title: 'Kira v1 with negotiated metadata', required: [...v1.required, 'meta'], properties: { ...structuredClone(v1.properties), meta: metadata } };
    const action = { oneOf: [{ $ref: 'urn:kira:ui:snapshot:1#/$defs/Action' }, obj({ event: obj({ name: { const: 'kira.submit' }, context: obj({ actionToken: tok, fields: { ...array(id, 8), uniqueItems: true } }) }) })] };
    const components = structuredClone(v1.$defs.Component.oneOf).filter((c: any) => c.properties.component.const !== 'Button');
    components.push(component('Button', { child: id, action: { $ref: '#/$defs/Action' } }));
    components.push(component('Progress', { label: str(), value: { type: 'number', minimum: 0, maximum: 1 }, detail: str(500) }, ['label', 'value']));
    components.push(component('Steps', { items: array(obj({ label: str(), detail: str(500), state: en('done', 'current', 'todo') }, ['label', 'state']), 16) }));
    const lat = { type: 'number', minimum: -90, maximum: 90 }, lon = { type: 'number', minimum: -180, maximum: 180 };
    components.push(component('Map', { pins: array(obj({ lat, lon, label: str() }), 10), region: obj({ lat, lon, latitudeDelta: { type: 'number', exclusiveMinimum: 0, maximum: 180 }, longitudeDelta: { type: 'number', exclusiveMinimum: 0, maximum: 360 } }) }, ['pins']));
    components.push(component('Image', { fileId: { ...uuid, pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }, alt: str(500) }));
    components.push(component('Countdown', { until: date, label: str() }));
    components.push(component('Checklist', { items: array(obj({ id, label: str(), checked: { type: 'boolean' }, actionToken: tok }, ['id', 'label', 'checked']), 24) }));
    components.push(component('Choice', { label: str(), options: array(obj({ value: str(80), label: str() }), 6), value: str(80) }, ['label', 'options']));
    components.push(component('Slider', { label: str(), min: number, max: number, step: { type: 'number', exclusiveMinimum: 0 }, value: number }));
    components.push(component('Toggle', { label: str(), value: { type: 'boolean' } }));
    components.push(component('DateTime', { label: str(), min: date, max: date, value: date }, ['label']));
    const list = array({ $ref: '#/$defs/Component' }, 64);
    const create = obj({ version: { const: '1.0' }, createSurface: obj({ surfaceId, catalogId: { const: UI_CATALOG_V2 }, components: list }) });
    const update = obj({ version: { const: '1.0' }, updateComponents: obj({ surfaceId, components: list }) });
    const remove = obj({ version: { const: '1.0' }, deleteSurface: obj({ surfaceId }) });
    const v2: any = { $schema: v1.$schema, $id: 'urn:kira:ui:snapshot:2', title: 'Kira A2UI v2 snapshot and atomic changes',
        description: 'Additionally validate graphs, byte budgets, resource ownership, form constraints and revision order.',
        ...obj({ protocol: { const: 'a2ui' }, version: { const: '1.0' }, catalogId: { const: UI_CATALOG_V2 }, revision: { type: 'integer', minimum: 1 }, meta: metadata,
            messages: array({ oneOf: [create, update, remove] }, 1) }, ['protocol', 'version', 'catalogId', 'revision', 'messages']),
        $defs: { Action: action, Component: { oneOf: components } },
        allOf: [{ if: { properties: { messages: { items: { required: ['updateComponents'] } } } }, then: { required: ['meta'], properties: { meta: { required: ['asOf'] }, revision: { minimum: 2 } } } },
            { if: { properties: { messages: { items: { required: ['deleteSurface'] } } } }, then: { properties: { revision: { minimum: 2 } } } }],
    };
    return { v1, extension, v2 };
}
export function updateUiOpenApi(spec: any) {
    const defs = spec.components.schemas, ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
    spec.openapi = '3.1.0';
    defs.UiPayload = { oneOf: [{ $ref: '../docs/generative-ui.schema.json' }, { $ref: '../docs/generative-ui.metadata.schema.json' }, { $ref: '../docs/generative-ui.v2.schema.json' }] };
    defs.UiRequest = { ...obj({ enabled: { type: 'boolean' }, catalogId: en(UI_CATALOG_ID, UI_CATALOG_V2), metadata: { type: 'boolean' },
        target: obj({ surfaceId, revision: { type: 'integer', minimum: 1 } }), device: obj({ id: uuid, bindingId: uuid }) }, ['enabled']),
        allOf: [{ if: { properties: { enabled: { const: true } } }, then: { required: ['catalogId'] } },
            { if: { required: ['target'] }, then: { properties: { catalogId: { const: UI_CATALOG_V2 } }, required: ['catalogId'] } }],
        description: 'Per-turn opt-in. V1 metadata requires metadata:true. Only v2 supports async UI and target updates. Preserve all flags on idempotent retries.' };
    defs.UiValues = { type: 'object', maxProperties: 8, propertyNames: id, additionalProperties: { oneOf: [str(), { type: 'boolean' }, number] } };
    spec.paths['/actions'].post.requestBody.content['application/json'].schema.properties.values = ref('UiValues');
    defs.Reply.properties.widgetPlacement = obj({ surfaceId, objectId: uuid, side: en('front', 'top', 'wall') });
    const device = obj({ id: uuid, bindingId: uuid, revision: { type: 'integer', minimum: 1 }, catalogId: { const: UI_CATALOG_V2 }, proactive: { type: 'boolean' }, diagnostics: { type: 'boolean' }, enabled: { type: 'boolean' } });
    defs.UiDevice = device;
    defs.UiFeedback = { ...obj({ surfaceId, messageId: { type: 'integer', maximum: -1 }, verdict: en('useful', 'not_useful', 'not_shown'), reason: str(200), device: obj({ id: uuid, bindingId: uuid }) }, ['surfaceId', 'messageId', 'verdict']),
        description: 'Only structured reason codes, never answer/widget text. not_shown requires an enabled diagnostics device binding and reason.' };
    let serial = 0;
    const route = (method: string, input: any, output: any, parameters: any[] = []) => ({ operationId: method + 'Ui' + (++serial),
        parameters: [...parameters, ...(method !== 'get' ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : [])],
        ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } } : {}),
        responses: { '200': { description: 'Owner-scoped UI result', content: { 'application/json': { schema: output } } }, default: { $ref: '#/components/responses/Error' } } });
    const ok = obj({ ok: { const: true } });
    const pathParam = (name: string, schema: any) => ({ name, in: 'path', required: true, schema });
    spec.paths['/ui-feedback'] = { post: route('post', ref('UiFeedback'), ok) };
    spec.paths['/ui/devices'] = { get: route('get', null, obj({ devices: array(ref('UiDevice'), 32, 0) })) };
    spec.paths['/ui/devices/{deviceId}'] = {
        put: route('put', obj({ catalogId: { const: UI_CATALOG_V2 }, proactive: { type: 'boolean' }, diagnostics: { type: 'boolean' }, expectedRevision: { type: 'integer', minimum: 1 } }, ['catalogId', 'proactive', 'diagnostics']), obj({ device: ref('UiDevice') }), [pathParam('deviceId', uuid)]),
        delete: route('delete', null, ok, [pathParam('deviceId', uuid)]),
    };
    defs.UiFeedbackMetrics = obj({ useful: { type: 'integer', minimum: 0 }, notUseful: { type: 'integer', minimum: 0 }, shownOnDevice: { type: 'integer', minimum: 0 }, rejectedOnDevice: { type: 'integer', minimum: 0 }, rejectionReasons: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } }, unknownUnreported: { const: true } });
    spec.paths['/ui/feedback-metrics'] = { get: route('get', null, ref('UiFeedbackMetrics')) };
    spec.paths['/ui/surfaces'] = { get: route('get', null, obj({ surfaces: array(obj({ surfaceId, messageId: { type: 'integer', maximum: -1 }, revision: { type: 'integer', minimum: 1 }, deleted: { type: 'boolean' }, ui: ref('UiPayload') }, ['surfaceId', 'messageId', 'revision', 'deleted']), 128, 0) })) };
    spec.paths['/ui/surfaces/{surfaceId}'] = { delete: route('delete', null, ok, [pathParam('surfaceId', surfaceId), { name: 'expectedRevision', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }]) };
    const jobs = spec.paths['/dialogue-jobs'].get;
    jobs.parameters = (jobs.parameters ?? []).filter((p: any) => !['uiAfter', 'uiDeviceId', 'uiBindingId'].includes(p.name));
    jobs.parameters.push(...['uiAfter', 'uiDeviceId', 'uiBindingId'].map(name => ({ name, in: 'query', required: false, schema: name === 'uiAfter' ? { type: 'string', pattern: '^\\d{1,16}$' } : uuid })));
    const jobsSchema = jobs.responses['200'].content['application/json'].schema;
    jobsSchema.properties.uiEvents = array(obj({ seq: { type: 'integer', minimum: 1 }, kind: en('widget-note', 'ui-update'), createdAt: date, deviceId: uuid, bindingId: uuid,
        messages: array(obj({ id: { type: 'integer', maximum: -1 }, type: { const: 'text' }, text: str(12000), ui: ref('UiPayload') }, ['id', 'type', 'ui']), 1) }, ['seq', 'kind', 'createdAt', 'messages']), 50, 0);
    jobsSchema.properties.uiNextCursor = { type: 'string' };
    const jobSchema = defs.DialogueJob ?? jobsSchema.properties.jobs?.items;
    if (jobSchema?.properties) { jobSchema.properties.ui = ref('UiPayload'); jobSchema.properties.uiMessageId = { type: 'integer', maximum: -1 }; }
    return spec;
}
if (require.main === module) {
    const schemas = uiSchemas(), outputs = { 'generative-ui.schema.json': schemas.v1, 'generative-ui.metadata.schema.json': schemas.extension, 'generative-ui.v2.schema.json': schemas.v2 };
    const check = process.argv.includes('--check');
    for (const [name, schema] of Object.entries(outputs)) {
        const path = join(__dirname, '../docs', name), content = JSON.stringify(schema, null, 2) + '\n';
        if (check) { if (readFileSync(path, 'utf8') !== content) throw Error('UI schema drift: ' + name); }
        else writeFileSync(path, content);
    }
    const path = join(__dirname, '../api/openapi.json'), source = JSON.parse(readFileSync(path, 'utf8')), content = JSON.stringify(updateUiOpenApi(source), null, 2) + '\n';
    if (check) { if (readFileSync(path, 'utf8') !== content) throw Error('UI OpenAPI drift'); } else writeFileSync(path, content);
    const accountPath = join(__dirname, '../api/accounts.openapi.json'), accounts = JSON.parse(readFileSync(accountPath, 'utf8'));
    for (const name of Object.keys(source.paths).filter(path => path.startsWith('/ui'))) accounts.paths[name] = { $ref: './openapi.json#/paths/' + name.replace(/~/g, '~0').replace(/\//g, '~1') };
    const accountContent = JSON.stringify(accounts, null, 2) + '\n';
    if (check) { if (readFileSync(accountPath, 'utf8') !== accountContent) throw Error('UI accounts OpenAPI drift'); } else writeFileSync(accountPath, accountContent);
    console.log(check ? 'UI schemas are current' : 'Generated UI wire schemas');
}
