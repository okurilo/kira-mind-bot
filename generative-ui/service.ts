import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../api/contracts';
import { UI_CATALOG_ID, UI_CATALOG_V2, type UiPayload, type UiChange, type UiRequest } from './contracts';
import { plainObject, onlyKeys, uiString } from './forms';
import { validateUiPayload } from './validate';
import { PgUiStore, type UiStore, type UiTransaction } from './store';
import { UiRefreshService, type RefreshDependencies } from './refresh';

const SURFACE = /^kira_[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface UiDevice {
    id: string; bindingId: string; revision: number; catalogId: typeof UI_CATALOG_V2; proactive: boolean; diagnostics: boolean; enabled: boolean;
}
export interface UiSurface {
    surfaceId: string; messageId: number; ui: UiPayload; request: UiRequest; revision: number;
    updatedAt: number; createdAt: number; deleted: boolean;
    dataAsOf?: string;
}
export interface UiEvent {
    seq: number; kind: 'widget-note' | 'ui-update'; createdAt: string; deviceId?: string; bindingId?: string;
    messages: Array<{ id: number; type: 'text'; text?: string; ui: UiPayload | UiChange }>;
}
export interface UiFeedback {
    surfaceId: string; messageId: number; verdict: 'useful' | 'not_useful' | 'not_shown'; reason?: string;
    device?: { id: string; bindingId: string };
}
export function parseFeedback(value: unknown): UiFeedback {
    if (!plainObject(value) || !onlyKeys(value, ['surfaceId', 'messageId', 'verdict', 'reason', 'device']) || typeof value.surfaceId !== 'string' || !SURFACE.test(value.surfaceId)
        || !Number.isSafeInteger(value.messageId) || value.messageId >= 0 || !['useful', 'not_useful', 'not_shown'].includes(value.verdict)) throw invalid();
    if (value.verdict === 'not_shown') {
        if (!uiString(value.reason, 200) || !/^(unknownField|unknownComponent|unknownVersion|invalidGraph|tooLarge|limitExceeded|invalidValue|invalidAction|unsupportedCatalog|rendererError)(?::[A-Za-z0-9_.\[\]-]+)?$/.test(value.reason)) throw invalid();
    } else if (value.reason !== undefined) throw invalid();
    if (value.device !== undefined && (!plainObject(value.device) || !onlyKeys(value.device, ['id', 'bindingId']) || typeof value.device.id !== 'string'
        || typeof value.device.bindingId !== 'string' || !UUID.test(value.device.id) || !UUID.test(value.device.bindingId))) throw invalid();
    return value as UiFeedback;
}
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export class UiService {
    private refresher?: UiRefreshService;
    get refresh() { return this.refresher ??= new UiRefreshService(this.owner, this.store, this.now, this.refreshDeps); }
    constructor(readonly owner: number, private store: UiStore = new PgUiStore(), private now = () => Date.now(), private refreshDeps: Partial<RefreshDependencies> = {}) {}
    async record(ui: UiPayload, messageId: number, request: UiRequest, active?: () => Promise<boolean>): Promise<void> {
        if (!validateUiPayload(ui, request.metadata === true) || !Number.isSafeInteger(messageId) || messageId >= 0 || ui.catalogId !== request.catalogId) throw invalid();
        await this.store.transact(this.owner, async tx => {
            if (active && !await active()) throw new ApiError(409, 'ui_turn_superseded', 'Диалог уже продолжился.');
            if (request.device) await this.requireDevice(tx, request.device);
            const surfaceId = ui.messages[0].createSurface.surfaceId;
            const prior = await tx.get<UiSurface>('surface', surfaceId);
            if (prior) {
                if (prior.messageId !== messageId || JSON.stringify(prior.ui) !== JSON.stringify(ui)) throw conflict();
                return;
            }
            await tx.put('surface', surfaceId, { surfaceId, messageId, ui, request, revision: ui.revision ?? 1,
                createdAt: this.now(), updatedAt: this.now(), deleted: false } satisfies UiSurface);
            await tx.trim('surface', 128);
        });
    }
    surface(id: string) {
        if (!SURFACE.test(id)) throw invalid();
        return this.store.transact(this.owner, tx => tx.get<UiSurface>('surface', id));
    }
    surfaces() {
        return this.store.transact(this.owner, async tx => ({ surfaces: (await tx.list<UiSurface>('surface', 128)).map(({ value }) => ({
            surfaceId: value.surfaceId, messageId: value.messageId, revision: value.revision, deleted: value.deleted, ...(value.deleted ? {} : { ui: value.ui }),
        })) }));
    }
    async feedback(raw: unknown, key: string) {
        const value = parseFeedback(raw);
        return this.store.transact(this.owner, async tx => {
            const receipt = hash(key), old = await tx.get<{ fingerprint: string }>('feedback', receipt), fingerprint = hash(JSON.stringify(value));
            if (old) { if (old.fingerprint !== fingerprint) throw conflict(); return { ok: true }; }
            const surface = await tx.get<UiSurface>('surface', value.surfaceId);
            if (!surface || surface.messageId !== value.messageId) throw missing();
            if (value.verdict === 'not_shown' && (!value.device || !(await this.requireDevice(tx, value.device)).diagnostics)) {
                throw new ApiError(403, 'ui_diagnostics_consent_required', 'Включи диагностику карточек на этом устройстве.');
            }
            const minute = Math.floor(this.now() / 60_000), counter = await tx.get<{ minute: number; count: number }>('meta', 'feedbackrate');
            if (counter?.minute === minute && counter.count >= 60) throw new ApiError(429, 'rate_limited', 'Слишком много отзывов о карточках.');
            await tx.put('meta', 'feedbackrate', { minute, count: counter?.minute === minute ? counter.count + 1 : 1 });
            // No answer/widget content or raw SDK errors in diagnostics.
            await tx.put('feedback', receipt, { ...value, device: value.device ? { id: value.device.id } : undefined, fingerprint, createdAt: this.now() });
            await tx.trim('feedback', 1000);
            return { ok: true };
        });
    }
    metrics() {
        return this.store.transact(this.owner, async tx => {
            const rows = await tx.list<UiFeedback>('feedback', 1000);
            return feedbackMetrics(rows.map(row => row.value));
        });
    }
    devices() { return this.store.transact(this.owner, async tx => ({ devices: (await tx.list<UiDevice>('device', 32)).map(row => row.value) })); }
    async saveDevice(id: string, value: unknown): Promise<{ device: UiDevice }> {
        if (!UUID.test(id) || !plainObject(value) || !onlyKeys(value, ['catalogId', 'proactive', 'diagnostics', 'expectedRevision'])
            || value.catalogId !== UI_CATALOG_V2 || typeof value.proactive !== 'boolean' || typeof value.diagnostics !== 'boolean'
            || value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) throw invalid();
        return this.store.transact(this.owner, async tx => {
            const old = await tx.get<UiDevice>('device', id);
            if (old ? value.expectedRevision !== old.revision : value.expectedRevision !== undefined) throw conflict();
            if (!old && (await tx.list('device', 32)).length >= 32) throw new ApiError(409, 'ui_device_limit', 'Достигнут предел устройств для карточек.');
            const device: UiDevice = { id, bindingId: old?.enabled ? old.bindingId : randomUUID(), revision: (old?.revision ?? 0) + 1,
                catalogId: UI_CATALOG_V2, proactive: value.proactive, diagnostics: value.diagnostics, enabled: true };
            await tx.put('device', id, device); return { device };
        });
    }
    revokeDevice(id: string) {
        if (!UUID.test(id)) throw invalid();
        return this.store.transact(this.owner, async tx => {
            const device = await tx.get<UiDevice>('device', id); if (!device) throw missing();
            await tx.put('device', id, { ...device, enabled: false, proactive: false, diagnostics: false, bindingId: randomUUID(), revision: device.revision + 1 });
            return { ok: true };
        });
    }
    private async requireDevice(tx: UiTransaction, value: { id: string; bindingId: string }) {
        const device = await tx.get<UiDevice>('device', value.id);
        if (!device || !device.enabled || device.bindingId !== value.bindingId) throw new ApiError(409, 'ui_device_binding_changed', 'Подключение карточек на устройстве изменилось.');
        return device;
    }
    async update(id: string, revision: number, ui: UiPayload, active?: () => Promise<boolean>): Promise<UiChange> {
        if (!SURFACE.test(id) || !Number.isSafeInteger(revision) || !validateUiPayload(ui) || ui.catalogId !== UI_CATALOG_V2 || !ui.meta?.asOf) throw invalid();
        const asOf = ui.meta.asOf;
        return this.store.transact(this.owner, async tx => {
            if (active && !await active()) throw new ApiError(409, 'ui_turn_superseded', 'Диалог уже продолжился.');
            const surface = await tx.get<UiSurface>('surface', id); if (!surface || surface.deleted || surface.ui.catalogId !== UI_CATALOG_V2) throw missing();
            if (surface.revision !== revision) throw conflict();
            if (this.now() - surface.updatedAt < 60_000) throw new ApiError(429, 'ui_update_rate_limited', 'Карточку можно обновлять не чаще раза в минуту.');
            if (surface.request.device) await this.requireDevice(tx, surface.request.device);
            const priorAsOf = surface.dataAsOf ?? surface.ui.meta?.asOf;
            if (priorAsOf && Date.parse(asOf) < Date.parse(priorAsOf)) throw new ApiError(409, 'ui_data_stale', 'Новые данные старше текущей карточки.');
            const next = revision + 1, components = ui.messages[0].createSurface.components;
            const change: UiChange = { protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_V2, revision: next, meta: ui.meta,
                messages: [{ version: '1.0', updateComponents: { surfaceId: id, components } }] };
            const snapshot: UiPayload = { ...ui, revision: next, messages: [{ version: '1.0', createSurface: { surfaceId: id, catalogId: UI_CATALOG_V2, components } }] };
            await tx.put('surface', id, { ...surface, ui: snapshot, revision: next, updatedAt: this.now(), dataAsOf: asOf });
            await tx.put('refreshrevoked', id, { at: this.now() });
            await tx.trim('refreshrevoked', 1000);
            await this.event(tx, surface, change); return change;
        });
    }
    async delete(id: string, revision: number): Promise<{ ok: true }> {
        if (!SURFACE.test(id) || !Number.isSafeInteger(revision) || revision < 1) throw invalid();
        return this.store.transact(this.owner, async tx => {
            const surface = await tx.get<UiSurface>('surface', id); if (!surface || surface.ui.catalogId !== UI_CATALOG_V2) throw missing();
            if (surface.revision !== revision) throw conflict();
            const change: UiChange = { protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_V2, revision: revision + 1,
                messages: [{ version: '1.0', deleteSurface: { surfaceId: id } }] };
            await tx.put('surface', id, { ...surface, deleted: true, revision: revision + 1, updatedAt: this.now() });
            await tx.put('refreshrevoked', id, { at: this.now() });
            await tx.trim('refreshrevoked', 1000);
            await this.event(tx, surface, change); return { ok: true };
        });
    }
    private async event(tx: UiTransaction, surface: UiSurface, ui: UiPayload | UiChange, text?: string, device?: UiDevice) {
        const seq = (await tx.get<number>('meta', 'seq') ?? 0) + 1;
        const binding = device ? { id: device.id, bindingId: device.bindingId } : surface.request.device;
        const event: UiEvent = { seq, kind: text === undefined ? 'ui-update' : 'widget-note', createdAt: new Date(this.now()).toISOString(),
            ...(binding ? { deviceId: binding.id, bindingId: binding.bindingId } : {}), messages: [{ id: surface.messageId, type: 'text', ...(text ? { text } : {}), ui }] };
        await tx.put('meta', 'seq', seq); await tx.put('event', String(seq).padStart(16, '0'), event); await tx.trim('event', 500);
    }
    async events(query: { deviceId?: string; bindingId?: string; after?: string } = {}) {
        if (query.after !== undefined && !/^\d{1,16}$/.test(query.after) || (query.deviceId !== undefined) !== (query.bindingId !== undefined)
            || query.deviceId !== undefined && (!UUID.test(query.deviceId) || !UUID.test(query.bindingId!))) throw invalid();
        const after = Number(query.after ?? 0);
        return this.store.transact(this.owner, async tx => {
            if (query.deviceId) await this.requireDevice(tx, { id: query.deviceId, bindingId: query.bindingId! });
            const events = (await tx.list<UiEvent>('event', 500)).map(row => row.value).sort((a, b) => a.seq - b.seq);
            if (after && events[0] && after < events[0].seq - 1) throw new ApiError(409, 'ui_cursor_expired', 'История обновлений сокращена. Перечитай карточки из истории.');
            const selected = events.filter(e => e.seq > after && (!e.deviceId || e.deviceId === query.deviceId && e.bindingId === query.bindingId)).slice(0, 50);
            const latest = await tx.get<number>('meta', 'seq') ?? 0;
            return { uiEvents: selected, uiNextCursor: String(selected.length === 50 ? selected[49].seq : latest) };
        });
    }
    async publishNote(ui: UiPayload, messageId: number, text: string, device: UiDevice, sourceKey: string) {
        if (!validateUiPayload(ui) || ui.catalogId !== UI_CATALOG_V2 || !uiString(text, 12_000)) throw invalid();
        return this.store.transact(this.owner, async tx => {
            const current = await this.requireDevice(tx, { id: device.id, bindingId: device.bindingId });
            if (!current.proactive) return false;
            const key = hash(sourceKey + ':' + device.id);
            if (await tx.get('note', key)) return false;
            ui = structuredClone(ui);
            ui.messages[0].createSurface.surfaceId = 'kira_' + randomUUID().replace(/-/g, '');
            const surface: UiSurface = { surfaceId: ui.messages[0].createSurface.surfaceId, messageId, ui, revision: 1, deleted: false,
                request: { enabled: true, catalogId: UI_CATALOG_V2, device: { id: device.id, bindingId: device.bindingId } }, createdAt: this.now(), updatedAt: this.now() };
            await tx.put('surface', surface.surfaceId, surface); await tx.trim('surface', 128);
            await this.event(tx, surface, ui, text, device); await tx.put('note', key, { at: this.now() }); await tx.trim('note', 500); return true;
        });
    }
    hasNote(sourceKey: string, deviceId: string) {
        return this.store.transact(this.owner, async tx => !!await tx.get('note', hash(sourceKey + ':' + deviceId)));
    }
}
export function feedbackMetrics(rows: UiFeedback[]) {
    const reasons: Record<string, number> = {};
    for (const row of rows) if (row.verdict === 'not_shown' && row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    const useful = rows.filter(r => r.verdict === 'useful').length, notUseful = rows.filter(r => r.verdict === 'not_useful').length, rejected = rows.filter(r => r.verdict === 'not_shown').length;
    return { useful, notUseful, shownOnDevice: useful + notUseful, rejectedOnDevice: rejected, rejectionReasons: reasons, unknownUnreported: true };
}
function invalid() { return new ApiError(400, 'invalid_ui_request', 'Проверь параметры карточки.'); }
function conflict() { return new ApiError(409, 'ui_revision_conflict', 'Карточка или настройки уже изменились.'); }
function missing() { return new ApiError(404, 'ui_surface_not_found', 'Карточка не найдена в этом аккаунте.'); }
