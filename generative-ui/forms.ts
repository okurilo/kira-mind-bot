import { ApiError } from '../api/contracts';
import type { UiInput, UiValues } from './contracts';

export const plainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const onlyKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export const uiString = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
export const uiId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(v);
export function utcDate(v: unknown): v is string {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)
        && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace(/\.0{1,3}Z$/, 'Z');
}
/** Source timestamps are copied literally; human dates never authorize an inferred clock/timezone. */
export function evidenceTimes(text: string): string[] {
    return [...new Set(Array.from(text.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g), m => m[0]).filter(utcDate))];
}
export const uiToken = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32_000 && /^[\x21-\x7e]+$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15;
export function validateInput(v: unknown): UiInput | undefined {
    if (!plainObject(v) || !uiId(v.id) || !uiString(v.label, 160)) return;
    const base = ['id', 'component', 'label'];
    if (v.component === 'Choice') {
        if (!onlyKeys(v, [...base, 'options', 'value']) || !Array.isArray(v.options) || v.options.length < 1 || v.options.length > 6
            || !v.options.every(o => plainObject(o) && onlyKeys(o, ['value', 'label']) && uiString(o.value, 80) && uiString(o.label, 160))
            || new Set(v.options.map(o => o.value)).size !== v.options.length || v.value !== undefined && !v.options.some(o => o.value === v.value)) return;
    } else if (v.component === 'Slider') {
        if (!onlyKeys(v, [...base, 'min', 'max', 'step', 'value']) || ![v.min, v.max, v.step, v.value].every(finite)
            || v.max <= v.min || v.step <= 0 || (v.max - v.min) / v.step > 1e6 || !onGrid(v.value, { min: v.min, max: v.max, step: v.step })) return;
    } else if (v.component === 'Toggle') {
        if (!onlyKeys(v, [...base, 'value']) || typeof v.value !== 'boolean') return;
    } else if (v.component === 'DateTime') {
        if (!onlyKeys(v, [...base, 'min', 'max', 'value']) || !['min', 'max', 'value'].every(k => v[k] === undefined || utcDate(v[k]))
            || v.min && v.max && Date.parse(v.min) > Date.parse(v.max) || v.value && !inDateRange(v.value, v)) return;
    } else return;
    return v as UiInput;
}
function onGrid(value: number, field: { min: number; max: number; step: number }) {
    const steps = (value - field.min) / field.step;
    return value >= field.min && value <= field.max && Math.abs(steps - Math.round(steps)) <= 1e-7;
}
function inDateRange(value: string, field: { min?: string; max?: string }) {
    return (!field.min || Date.parse(value) >= Date.parse(field.min)) && (!field.max || Date.parse(value) <= Date.parse(field.max));
}
export interface UiSubmission { text: string; fields: UiInput[] }
export function validateSubmission(value: unknown): UiSubmission {
    if (!plainObject(value) || !onlyKeys(value, ['text', 'fields']) || !uiString(value.text, 500) || !Array.isArray(value.fields)
        || !value.fields.length || value.fields.length > 8 || !value.fields.every(validateInput)
        || new Set(value.fields.map(f => f.id)).size !== value.fields.length) throw invalid();
    return value as UiSubmission;
}
export function submissionText(submission: UiSubmission, value: unknown): string {
    const { fields, text } = validateSubmission(submission);
    if (!plainObject(value) || Object.keys(value).length !== fields.length || !fields.every(f => Object.prototype.hasOwnProperty.call(value, f.id))) throw invalid();
    const values = value as UiValues;
    const lines = fields.map(field => {
        const v = values[field.id];
        let label: string;
        switch (field.component) {
            case 'Choice': {
                const choice = field.options.find(o => o.value === v); if (!choice) throw invalid(); label = choice.label; break;
            }
            case 'Slider': if (typeof v !== 'number' || !Number.isFinite(v) || !onGrid(v, field)) throw invalid(); label = String(v); break;
            case 'Toggle': if (typeof v !== 'boolean') throw invalid(); label = v ? 'Да' : 'Нет'; break;
            case 'DateTime': if (!utcDate(v) || !inDateRange(v, field)) throw invalid(); label = v; break;
        }
        return `${field.label}: ${label}`;
    });
    return `${text}\n\nВыбранные значения формы:\n${lines.join('\n')}`;
}
export function actionValues(value: unknown): UiValues | undefined {
    if (value === undefined) return;
    if (!plainObject(value) || Object.keys(value).length > 8 || !Object.entries(value).every(([id, v]) => uiId(id)
        && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 160))) throw invalid();
    return value as UiValues;
}
function invalid() { return new ApiError(400, 'invalid_ui_values', 'Проверь поля формы и допустимые значения.'); }
