import { randomUUID } from 'node:crypto';
import { UI_CATALOG_ID, UI_CATALOG_V2, UI_LIMITS, type UiAction, type UiComponent, type UiPayload, type UiRequest, type UiMeta, type UiInput, type UiChange } from './contracts';
import { utcDate, uiToken, validateInput, evidenceTimes } from './forms';

type ObjectValue = Record<string, any>;
export interface UiActionBinding {
    urls: ReadonlySet<string>;
    /** Existing signed actions, collected by the real transport, never model-supplied callback data. */
    actions: readonly string[];
    replyToken(text: string): string;
    submitToken?(text: string, fields: UiInput[]): string;
    files?: ReadonlySet<string>;
    evidence?: string;
}
function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: ObjectValue, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function string(value: unknown, max = 1000): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value); }
function strings(value: unknown, max: number, width: number): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(item => string(item, width));
}
function option(value: unknown, allowed: string[]) { return value === undefined || allowed.includes(value as string); }

export function safeUiUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f]/.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname;
    } catch { return false; }
}

function action(value: unknown, binding: UiActionBinding, inputs: UiInput[], v2: boolean, wire = false): UiAction | undefined {
    if (!object(value)) return;
    if (wire) return wireAction(value, v2);
    if (value.type === 'openUrl' && keys(value, ['type', 'url']) && safeUiUrl(value.url) && binding.urls.has(value.url)) {
        return { functionCall: { '@call': 'openUrl', args: { url: value.url } } };
    }
    if (value.type === 'reply' && keys(value, ['type', 'text']) && string(value.text, 500)) {
        return { event: { name: 'kira.reply', context: { actionToken: binding.replyToken(value.text.trim()) } } };
    }
    if (value.type === 'existing' && keys(value, ['type', 'index']) && Number.isInteger(value.index) && value.index >= 0 && binding.actions[value.index]) {
        return { event: { name: 'kira.action', context: { actionToken: binding.actions[value.index] } } };
    }
    if (v2 && value.type === 'submit' && keys(value, ['type', 'text', 'fields']) && string(value.text, 500) && Array.isArray(value.fields)
        && value.fields.length > 0 && value.fields.length <= 8 && value.fields.every(id) && new Set(value.fields).size === value.fields.length && binding.submitToken) {
        const fields = value.fields.map((name: string) => inputs.find(f => f.id === name));
        if (fields.some(f => !f)) return;
        return { event: { name: 'kira.submit', context: { actionToken: binding.submitToken(value.text, fields as UiInput[]), fields: value.fields } } };
    }
}

function wireAction(value: ObjectValue, v2: boolean): UiAction | undefined {
    if (keys(value, ['functionCall']) && object(value.functionCall) && keys(value.functionCall, ['@call', 'args'])
        && value.functionCall['@call'] === 'openUrl' && object(value.functionCall.args) && keys(value.functionCall.args, ['url']) && safeUiUrl(value.functionCall.args.url)) return value as UiAction;
    const event = value.event;
    if (!keys(value, ['event']) || !object(event) || !keys(event, ['name', 'context']) || !object(event.context) || !uiToken(event.context.actionToken)) return;
    if (['kira.reply', 'kira.action'].includes(event.name) && keys(event.context, ['actionToken'])) return value as UiAction;
    if (v2 && event.name === 'kira.submit' && keys(event.context, ['actionToken', 'fields']) && Array.isArray(event.context.fields)
        && event.context.fields.length > 0 && event.context.fields.length <= 8 && event.context.fields.every(id)
        && new Set(event.context.fields).size === event.context.fields.length) return value as UiAction;
}

function meta(value: unknown, binding?: UiActionBinding): UiMeta | undefined {
    if (!object(value) || !keys(value, ['title', 'asOf', 'sources']) || !Object.keys(value).length
        || value.title !== undefined && !string(value.title, 80) || value.asOf !== undefined && !utcDate(value.asOf)) return;
    if (value.asOf && binding && !evidenceTimes(binding.evidence ?? '').includes(value.asOf)) return;
    if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length > 8 || !value.sources.length
        || !value.sources.every(source => object(source) && keys(source, ['label', 'url']) && string(source.label, 160) && safeUiUrl(source.url)
            && (!binding || binding.urls.has(source.url))))) return;
    return value as UiMeta;
}

/** All-or-nothing validation: malformed graphs/actions never reach native renderers. No evaluation or fetching. */
export function compileUi(value: unknown, binding: UiActionBinding, request: UiRequest = { enabled: true, catalogId: UI_CATALOG_ID }): UiPayload | undefined {
    const v2 = request.catalogId === UI_CATALOG_V2;
    const metadata = v2 || request.metadata;
    if (!object(value) || !keys(value, ['components', ...(metadata ? ['meta'] : []), ...(v2 ? ['placement'] : [])])) return;
    const components = parseComponents(value.components, binding, v2);
    if (!components) return;
    const metadataValue = value.meta === undefined ? undefined : meta(value.meta, binding);
    if (value.meta !== undefined && !metadataValue) return;
    const payload: UiPayload = { protocol: 'a2ui', version: '1.0', catalogId: request.catalogId, ...(v2 ? { revision: 1 } : {}),
        ...(metadataValue ? { meta: metadataValue } : {}), messages: [{ version: '1.0', createSurface: {
            surfaceId: `kira_${randomUUID().replace(/-/g, '')}`, catalogId: request.catalogId, components } }] };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > UI_LIMITS.bytes) return;
    return structuredClone(payload);
}

function parseComponents(rawComponents: unknown, binding: UiActionBinding, v2: boolean, wire = false): UiComponent[] | undefined {
    if (!Array.isArray(rawComponents)
        || rawComponents.length === 0 || rawComponents.length > UI_LIMITS.components) return;
    if (Buffer.byteLength(JSON.stringify(rawComponents), 'utf8') > UI_LIMITS.bytes) return;
    const components: UiComponent[] = [];
    const links = new Map<string, string[]>();
    const inputs = v2 ? rawComponents.map(validateInput).filter((v): v is UiInput => !!v) : [];
    let buttons = 0;
    for (const raw of rawComponents) {
        if (!object(raw) || !id(raw.id) || links.has(raw.id)) return;
        const base = ['id', 'component'];
        let children: string[] = [];
        let compiled: UiComponent;
        switch (raw.component) {
            case 'Column': case 'Row':
                if (!keys(raw, [...base, 'children', 'gap']) || !Array.isArray(raw.children) || !raw.children.length
                    || raw.children.length > 16 || !raw.children.every(id) || !option(raw.gap, ['small', 'medium', 'large'])) return;
                children = raw.children; compiled = raw as UiComponent; break;
            case 'Card':
                if (!keys(raw, [...base, 'child']) || !id(raw.child)) return;
                children = [raw.child]; compiled = raw as UiComponent; break;
            case 'Text':
                if (!keys(raw, [...base, 'text', 'variant']) || !string(raw.text, 3000) || !option(raw.variant, ['title', 'body', 'caption'])) return;
                compiled = raw as UiComponent; break;
            case 'Divider':
                if (!keys(raw, base)) return;
                compiled = raw as UiComponent; break;
            case 'Metric':
                if (!keys(raw, [...base, 'label', 'value', 'detail', 'tone']) || !string(raw.label, 160) || !string(raw.value, 160)
                    || raw.detail !== undefined && !string(raw.detail, 500) || !option(raw.tone, ['neutral', 'positive', 'negative'])) return;
                compiled = raw as UiComponent; break;
            case 'Table':
                if (!keys(raw, [...base, 'columns', 'rows']) || !strings(raw.columns, 6, 160) || !Array.isArray(raw.rows)
                    || !raw.rows.length || raw.rows.length > 24 || !raw.rows.every(row => strings(row, 6, 500) && row.length === raw.columns.length)) return;
                compiled = raw as UiComponent; break;
            case 'Chart':
                if (!keys(raw, [...base, 'kind', 'labels', 'series', 'unit']) || !['line', 'bar', 'donut'].includes(raw.kind)
                    || !strings(raw.labels, 48, 160) || raw.unit !== undefined && !string(raw.unit, 40)
                    || !Array.isArray(raw.series) || !raw.series.length || raw.series.length > 4
                    || !raw.series.every(series => object(series) && keys(series, ['label', 'values']) && string(series.label, 160)
                        && Array.isArray(series.values) && series.values.length === raw.labels.length
                        && series.values.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e15))) return;
                if (raw.kind === 'donut' && (raw.series.length !== 1 || raw.series[0].values.some((n: number) => n < 0)
                    || !raw.series[0].values.some((n: number) => n > 0))) return;
                compiled = raw as UiComponent; break;
            case 'Button': {
                if (!keys(raw, [...base, 'child', 'action']) || !id(raw.child) || ++buttons > UI_LIMITS.buttons) return;
                const bound = action(raw.action, binding, inputs, v2, wire);
                if (!bound) return;
                children = [raw.child]; compiled = { id: raw.id, component: 'Button', child: raw.child, action: bound }; break;
            }
            default: {
                if (!v2) return;
                if (['Choice', 'Slider', 'Toggle', 'DateTime'].includes(raw.component)) {
                    const input = validateInput(raw); if (!input) return; compiled = input; break;
                }
                if (raw.component === 'Progress') {
                    if (!keys(raw, [...base, 'label', 'value', 'detail']) || !string(raw.label, 160) || typeof raw.value !== 'number'
                        || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > 1 || raw.detail !== undefined && !string(raw.detail, 500)) return;
                } else if (raw.component === 'Steps') {
                    if (!keys(raw, [...base, 'items']) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 16
                        || !raw.items.every(item => object(item) && keys(item, ['label', 'detail', 'state']) && string(item.label, 160)
                            && ['done', 'current', 'todo'].includes(item.state) && (item.detail === undefined || string(item.detail, 500)))) return;
                } else if (raw.component === 'Map') {
                    const coordinate = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
                    if (!keys(raw, [...base, 'pins', 'region']) || !Array.isArray(raw.pins) || !raw.pins.length || raw.pins.length > 10
                        || !raw.pins.every(pin => object(pin) && keys(pin, ['lat', 'lon', 'label']) && coordinate(pin.lat, 90) && coordinate(pin.lon, 180) && string(pin.label, 160))) return;
                    if (raw.region !== undefined && (!object(raw.region) || !keys(raw.region, ['lat', 'lon', 'latitudeDelta', 'longitudeDelta'])
                        || !coordinate(raw.region.lat, 90) || !coordinate(raw.region.lon, 180) || !coordinate(raw.region.latitudeDelta, 180)
                        || !coordinate(raw.region.longitudeDelta, 360) || raw.region.latitudeDelta <= 0 || raw.region.longitudeDelta <= 0)) return;
                } else if (raw.component === 'Image') {
                    if (!keys(raw, [...base, 'fileId', 'alt']) || typeof raw.fileId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.fileId)
                        || !string(raw.alt, 500) || !wire && !binding.files?.has(raw.fileId)) return;
                } else if (raw.component === 'Countdown') {
                    if (!keys(raw, [...base, 'until', 'label']) || !utcDate(raw.until) || !string(raw.label, 160)
                        || !wire && !evidenceTimes(binding.evidence ?? '').includes(raw.until)) return;
                } else if (raw.component === 'Checklist') {
                    if (!keys(raw, [...base, 'items']) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 24
                        || new Set(raw.items.map(item => item?.id)).size !== raw.items.length) return;
                    const items = [];
                    for (const item of raw.items) {
                        if (!object(item) || !keys(item, ['id', 'label', 'checked', wire ? 'actionToken' : 'action']) || !id(item.id)
                            || !string(item.label, 160) || typeof item.checked !== 'boolean') return;
                        let token = item.actionToken;
                        if (!wire && item.action !== undefined) {
                            const bound = action(item.action, binding, [], false);
                            if (!bound || !('event' in bound)) return;
                            token = bound.event.context.actionToken;
                        }
                        if (token !== undefined && !uiToken(token)) return;
                        items.push({ id: item.id, label: item.label, checked: item.checked, ...(token ? { actionToken: token } : {}) });
                    }
                    compiled = { id: raw.id, component: 'Checklist', items }; break;
                } else return;
                compiled = raw as UiComponent; break;
            }
        }
        links.set(raw.id, children);
        components.push(compiled);
    }
    // Exactly one rooted tree: reject cycles, missing refs, shared children, or unreachable hidden actions.
    const seen = new Set<string>();
    function visit(node: string, depth: number): boolean {
        if (depth > UI_LIMITS.depth || seen.has(node) || !links.has(node)) return false;
        seen.add(node);
        return links.get(node)!.every(child => visit(child, depth + 1));
    }
    if (!visit('root', 1) || seen.size !== components.length) return;
    for (const component of components) if (component.component === 'Button') {
        if (components.find(child => child.id === component.child)?.component !== 'Text' || !wireAction(component.action, v2)) return;
        if ('event' in component.action && component.action.event.name === 'kira.submit'
            && !component.action.event.context.fields.every(name => inputs.some(input => input.id === name))) return;
    }
    return components;
}

/** Public wire validator used by shared fixtures; optional metadata on v1 needs explicit negotiated support. */
export function validateUiPayload(value: unknown, allowV1Metadata = false): value is UiPayload {
    if (!object(value) || !keys(value, ['protocol', 'version', 'catalogId', 'messages', 'revision', 'meta']) || value.protocol !== 'a2ui' || value.version !== '1.0'
        || ![UI_CATALOG_ID, UI_CATALOG_V2].includes(value.catalogId) || Buffer.byteLength(JSON.stringify(value)) > UI_LIMITS.bytes) return false;
    const v2 = value.catalogId === UI_CATALOG_V2;
    if (v2 ? !Number.isSafeInteger(value.revision) || value.revision < 1 : value.revision !== undefined) return false;
    if (value.meta !== undefined && (!v2 && !allowV1Metadata || !meta(value.meta))) return false;
    if (!Array.isArray(value.messages) || value.messages.length !== 1) return false;
    const envelope = value.messages[0];
    if (!object(envelope) || !keys(envelope, ['version', 'createSurface']) || envelope.version !== '1.0' || !object(envelope.createSurface)) return false;
    const surface = envelope.createSurface;
    if (!keys(surface, ['surfaceId', 'catalogId', 'components']) || !validSurfaceId(surface.surfaceId) || surface.catalogId !== value.catalogId) return false;
    return !!parseComponents(surface.components, { urls: new Set(), actions: [], replyToken: () => '' }, v2, true);
}

export function validateUiChange(value: unknown): value is UiChange {
    if (!object(value) || !keys(value, ['protocol', 'version', 'catalogId', 'revision', 'meta', 'messages']) || value.protocol !== 'a2ui' || value.version !== '1.0'
        || value.catalogId !== UI_CATALOG_V2 || !Number.isSafeInteger(value.revision) || value.revision < 2
        || Buffer.byteLength(JSON.stringify(value)) > UI_LIMITS.bytes || !Array.isArray(value.messages) || value.messages.length !== 1
        || value.meta !== undefined && !meta(value.meta)) return false;
    const envelope = value.messages[0];
    if (!object(envelope) || envelope.version !== '1.0') return false;
    if (keys(envelope, ['version', 'deleteSurface']) && object(envelope.deleteSurface) && keys(envelope.deleteSurface, ['surfaceId'])) return validSurfaceId(envelope.deleteSurface.surfaceId);
    if (!keys(envelope, ['version', 'updateComponents']) || !object(envelope.updateComponents) || !keys(envelope.updateComponents, ['surfaceId', 'components'])
        || !validSurfaceId(envelope.updateComponents.surfaceId) || !value.meta?.asOf) return false;
    return !!parseComponents(envelope.updateComponents.components, { urls: new Set(), actions: [], replyToken: () => '' }, true, true);
}
const SURFACE_ID = /^kira_[a-f0-9]{32}$/;
function validSurfaceId(value: unknown): value is string { return typeof value === 'string' && SURFACE_ID.test(value); }
