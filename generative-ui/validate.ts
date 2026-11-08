import { randomUUID } from 'node:crypto';
import { UI_CATALOG_ID, UI_LIMITS, type UiAction, type UiComponent, type UiPayload } from './contracts';

type ObjectValue = Record<string, any>;
export interface UiActionBinding {
    urls: ReadonlySet<string>;
    /** Existing signed actions, collected by the real transport, never model-supplied callback data. */
    actions: readonly string[];
    replyToken(text: string): string;
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

function action(value: unknown, binding: UiActionBinding): UiAction | undefined {
    if (!object(value)) return;
    if (value.type === 'openUrl' && keys(value, ['type', 'url']) && safeUiUrl(value.url) && binding.urls.has(value.url)) {
        return { functionCall: { '@call': 'openUrl', args: { url: value.url } } };
    }
    if (value.type === 'reply' && keys(value, ['type', 'text']) && string(value.text, 500)) {
        return { event: { name: 'kira.reply', context: { actionToken: binding.replyToken(value.text.trim()) } } };
    }
    if (value.type === 'existing' && keys(value, ['type', 'index']) && Number.isInteger(value.index) && value.index >= 0 && binding.actions[value.index]) {
        return { event: { name: 'kira.action', context: { actionToken: binding.actions[value.index] } } };
    }
}

/** All-or-nothing validation: malformed graphs/actions never reach native renderers. No evaluation or fetching. */
export function compileUi(value: unknown, binding: UiActionBinding): UiPayload | undefined {
    if (!object(value) || !keys(value, ['components']) || !Array.isArray(value.components)
        || value.components.length === 0 || value.components.length > UI_LIMITS.components) return;
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > UI_LIMITS.bytes) return;
    const components: UiComponent[] = [];
    const links = new Map<string, string[]>();
    let buttons = 0;
    for (const raw of value.components) {
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
                const bound = action(raw.action, binding);
                if (!bound) return;
                children = [raw.child]; compiled = { id: raw.id, component: 'Button', child: raw.child, action: bound }; break;
            }
            default: return;
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
    for (const component of components) if (component.component === 'Button'
        && components.find(child => child.id === component.child)?.component !== 'Text') return;
    const payload: UiPayload = { protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_ID, messages: [{ version: '1.0',
        createSurface: { surfaceId: `kira_${randomUUID().replace(/-/g, '')}`, catalogId: UI_CATALOG_ID, components } }] };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > UI_LIMITS.bytes) return;
    return structuredClone(payload);
}
