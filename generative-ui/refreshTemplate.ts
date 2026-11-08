import type { UiPayload } from './contracts';
import { plainObject, onlyKeys, uiId, uiString, utcDate, evidenceTimes } from './forms';
import { validateUiPayload } from './validate';
import { refreshValue, type RefreshEvidence, type RefreshValue } from './refreshEvidence';

export interface RefreshSlot { id: string; componentId: string; path: Array<string | number>; description: string; sourceField?: string; prefix?: string; suffix?: string }
export interface RefreshRecipe { source: RefreshEvidence; subject: string; sourceUrl: string; slots: RefreshSlot[]; asOf?: string }
export function passiveRefreshUi(ui: UiPayload): boolean {
    return ui.messages[0].createSurface.components.every(c => !['Choice', 'Slider', 'Toggle', 'DateTime', 'Image'].includes(c.component)
        && (c.component !== 'Button' || 'functionCall' in c.action) && (c.component !== 'Checklist' || c.items.every(i => !i.actionToken)));
}
function mutable(component: any, path: Array<string | number>): boolean {
    const p = path.join('.');
    if (component.component === 'Text') return p === 'text';
    if (component.component === 'Metric') return ['value', 'detail', 'tone'].includes(p);
    if (component.component === 'Progress') return ['value', 'detail'].includes(p);
    if (component.component === 'Chart') return p === 'labels' || /^labels\.\d+$/.test(p) || /^series\.\d+\.values(?:\.\d+)?$/.test(p);
    if (component.component === 'Table') return p === 'rows' || /^rows\.\d+\.\d+$/.test(p);
    return false;
}
export function slotValue(ui: UiPayload, slot: RefreshSlot): RefreshValue | undefined {
    const component = ui.messages[0].createSurface.components.find(c => c.id === slot.componentId);
    if (!component || !mutable(component, slot.path)) return;
    let value: any = component;
    for (const key of slot.path) {
        if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) return;
        value = value[key];
    }
    return refreshValue(value) ? value : undefined;
}
export function dataSlot(value: RefreshValue, slot: RefreshSlot): RefreshValue {
    return slot.prefix !== undefined || slot.suffix !== undefined ? (slot.prefix ?? '') + String(value) + (slot.suffix ?? '') : value;
}
export function compileRefreshRecipe(draft: unknown, ui: UiPayload, sources: RefreshEvidence[]): RefreshRecipe | undefined {
    if (!plainObject(draft) || !onlyKeys(draft, ['source', 'subject', 'sourceUrl', 'asOf', 'slots']) || !Number.isInteger(draft.source)
        || !uiString(draft.subject, 160) || !Array.isArray(draft.slots) || !draft.slots.length || draft.slots.length > 24 || !passiveRefreshUi(ui)) return;
    const source = sources[draft.source]; if (!source) return;
    const urls = source.kind === 'data' ? source.data.sources : source.sources;
    if (!urls.some(s => s.url === draft.sourceUrl)) return;
    const asOf = source.kind === 'data' ? source.data.asOf : draft.asOf;
    if (asOf !== undefined && (!utcDate(asOf) || source.kind === 'search' && !evidenceTimes(source.text).includes(asOf))) return;
    const ids = new Set<string>(), paths = new Set<string>(), slots: RefreshSlot[] = [];
    for (const slot of draft.slots) {
        if (!plainObject(slot) || !onlyKeys(slot, ['id', 'componentId', 'path', 'description', 'sourceField', 'prefix', 'suffix']) || !uiId(slot.id) || !uiId(slot.componentId)
            || !uiString(slot.description, 240) || !Array.isArray(slot.path) || !slot.path.length || slot.path.length > 4
            || !slot.path.every(k => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(k) || Number.isSafeInteger(k) && k >= 0 && k < 64)
            || ['prefix', 'suffix'].some(k => slot[k] !== undefined && (typeof slot[k] !== 'string' || slot[k].length > 80))) return;
        const key = slot.componentId + ':' + JSON.stringify(slot.path), old = slotValue(ui, slot as RefreshSlot);
        if (old === undefined || ids.has(slot.id) || paths.has(key)) return;
        if (draft.slots.some(other => other !== slot && other?.componentId === slot.componentId && Array.isArray(other.path)
            && other.path.slice(0, Math.min(other.path.length, slot.path.length)).every((k: unknown, i: number) => k === slot.path[i]))) return;
        ids.add(slot.id); paths.add(key);
        const bound = structuredClone(slot) as RefreshSlot;
        if (source.kind === 'data') {
            if (!uiId(slot.sourceField) || !Object.prototype.hasOwnProperty.call(source.data.values, slot.sourceField)) return;
            const value = source.data.values[slot.sourceField];
            if (Array.isArray(value) && (slot.prefix !== undefined || slot.suffix !== undefined)) return;
            // Metric/Table text often displays a bare API number: bind the exact string conversion once.
            if (typeof old === 'string' && !Array.isArray(value) && typeof value !== 'string' && slot.prefix === undefined && slot.suffix === undefined && String(value) === old) bound.prefix = '';
            if (JSON.stringify(dataSlot(value, bound)) !== JSON.stringify(old)) return;
        } else if (slot.sourceField !== undefined || slot.prefix !== undefined || slot.suffix !== undefined) return;
        slots.push(bound);
    }
    const components = ui.messages[0].createSurface.components;
    for (const c of components) if (c.component === 'Button' && 'functionCall' in c.action) {
        const url = c.action.functionCall.args.url;
        if (!urls.some(s => s.url === url)) return;
    }
    return { source: structuredClone(source), subject: draft.subject, sourceUrl: draft.sourceUrl, slots, ...(asOf ? { asOf } : {}) };
}
export function fillRefreshTemplate(template: UiPayload, slots: RefreshSlot[], values: Record<string, unknown>, asOf: string): UiPayload | undefined {
    if (!plainObject(values) || Object.keys(values).length !== slots.length || !utcDate(asOf)) return;
    const result = structuredClone(template);
    for (const slot of slots) {
        const value = values[slot.id], previous = slotValue(template, slot);
        if (!Object.prototype.hasOwnProperty.call(values, slot.id) || !sameValueShape(value, previous) || !refreshValue(value)) return;
        let target: any = result.messages[0].createSurface.components.find(c => c.id === slot.componentId);
        for (const key of slot.path.slice(0, -1)) target = target[key];
        target[slot.path[slot.path.length - 1]] = value;
    }
    if (result.meta) result.meta.asOf = asOf;
    return validateUiPayload(result, true) && passiveRefreshUi(result) ? result : undefined;
}
function sameValueShape(value: unknown, previous: unknown): boolean {
    return Array.isArray(previous) ? Array.isArray(value) && value.length === previous.length && value.every((v, i) => sameValueShape(v, previous[i]))
        : !Array.isArray(value) && typeof value === typeof previous;
}
export function refreshValueSchema(value: unknown): Record<string, unknown> {
    return Array.isArray(value) ? { type: 'array', minItems: value.length, maxItems: value.length, items: refreshValueSchema(value[0]) }
        : { type: typeof value };
}
