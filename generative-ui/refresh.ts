import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../api/contracts';
import { withBackgroundAiTask, accountPolicyError } from '../ai/accountPolicy';
import { isMaximumSavingsEnabled } from '../services/budgetModeService';
import { plainObject, onlyKeys, utcDate } from './forms';
import { parseUiRequest } from './request';
import { validateUiPayload } from './validate';
import { UI_CATALOG_V2, type UiPayload, type UiRequest, type UiRefreshMeta } from './contracts';
import type { UiStore } from './store';
import { fillRefreshTemplate, dataSlot, slotValue, passiveRefreshUi, type RefreshRecipe } from './refreshTemplate';
import { parseRefreshData, mcpRefreshAuthority, type RefreshEvidence } from './refreshEvidence';
import { searchRefreshValues } from './refreshSearch';

const TTL = 30 * 86400_000, MAX_RECIPES = 512;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const surfaceId = (s: unknown): s is string => typeof s === 'string' && /^kira_[a-f0-9]{32}$/.test(s);
export interface RefreshRequest { items: Array<{ token: string; surfaceId: string }>; ui: UiRequest }
export interface RefreshRecord { recipe: RefreshRecipe; ui: UiPayload; expiresAt: number; checkedAt: number; asOf?: string; interval: number; generation: number;
    device?: UiRequest['device']; lease?: { id: string; until: number }; failed?: boolean }
export interface RefreshDependencies {
    data(source: Extract<RefreshEvidence, { kind: 'data' }>): Promise<unknown>;
    search(recipe: RefreshRecipe, ui: UiPayload): Promise<{ asOf: string; values: Record<string, unknown> }>;
    run<T>(key: string, work: () => Promise<T>): Promise<T>;
    allowed(): Promise<boolean>;
}
async function readData(source: Extract<RefreshEvidence, { kind: 'data' }>) {
    const { readMcpConfig } = await import('../services/mcp/config');
    const config = readMcpConfig()[source.server];
    if (!config || config.tools[source.tool] !== 'read' || !config.refreshTools?.includes(source.tool) || mcpRefreshAuthority(config, source.tool) !== source.authority) throw Error('source_changed');
    const { mcpService } = await import('../services/mcp/client');
    const result = await mcpService.callTool(source.server, source.tool, source.args, 'read', AbortSignal.timeout(45_000));
    if (result.isError) throw Error('source_failed');
    return (result.structuredContent as any)?.uiRefresh;
}
export function parseRefreshRequest(value: unknown): RefreshRequest {
    if (!plainObject(value) || !onlyKeys(value, ['items', 'ui']) || !Array.isArray(value.items) || !value.items.length) throw invalid();
    if (value.items.length > 10) throw new ApiError(413, 'too_many_widgets', 'Не больше 10 карточек за запрос.');
    const ui = parseUiRequest(value.ui);
    if (!ui?.refresh || ui.target) throw invalid();
    if (!value.items.every(i => plainObject(i) && onlyKeys(i, ['token', 'surfaceId']) && typeof i.token === 'string'
        && /^[\x21-\x7e]{1,512}$/.test(i.token) && surfaceId(i.surfaceId)) || new Set(value.items.map(i => i.surfaceId)).size !== value.items.length) throw invalid();
    return { items: value.items, ui };
}
export class UiRefreshService {
    private deps: RefreshDependencies;
    constructor(readonly owner: number, private store: UiStore, private now = () => Date.now(), deps: Partial<RefreshDependencies> = {}) {
        this.deps = { data: readData, search: searchRefreshValues, run: (key, work) => withBackgroundAiTask('widget-refresh', `${owner}:${key}`, work),
            allowed: async () => !await isMaximumSavingsEnabled(), ...deps };
    }
    async register(ui: UiPayload, recipe: RefreshRecipe | undefined, request: UiRequest): Promise<UiRefreshMeta | undefined> {
        if (!request.refresh || !recipe || process.env.KIRA_UI_REFRESH_ENABLED === 'false' || !validateUiPayload(ui, true) || !passiveRefreshUi(ui)) return;
        const token = 'rf_' + randomBytes(32).toString('base64url');
        return this.store.transact(this.owner, async tx => {
            const rows = await tx.list<{ expiresAt: number }>('refreshindex', 1000);
            // Do not evict a still-valid 30-day token because the ordinary history has a shorter retention.
            for (const row of rows) if (row.value.expiresAt <= this.now()) { await tx.delete('refresh', row.id); await tx.delete('refreshindex', row.id); }
            if (rows.filter(row => row.value.expiresAt > this.now()).length >= MAX_RECIPES) return;
            const record: RefreshRecord = { recipe, ui: structuredClone(ui), expiresAt: this.now() + TTL, checkedAt: this.now(),
                interval: recipe.source.kind === 'search' ? 3600 : 600, generation: 0, ...(recipe.asOf ? { asOf: recipe.asOf } : {}), ...(request.device ? { device: request.device } : {}) };
            await tx.put('refresh', hash(token), record);
            await tx.put('refreshindex', hash(token), { expiresAt: record.expiresAt });
            return metadata(record, token);
        });
    }
    async batch(body: RefreshRequest, requestKey: string): Promise<{ results: any[] }> {
        await this.store.transact(this.owner, async tx => {
            const minute = Math.floor(this.now() / 60_000), old = await tx.get<{ minute: number; count: number }>('meta', 'refreshrate');
            if (old?.minute === minute && old.count >= 30) throw limited(Math.ceil((60_000 - this.now() % 60_000) / 1000));
            await tx.put('meta', 'refreshrate', { minute, count: old?.minute === minute ? old.count + 1 : 1 });
        });
        const results = [];
        for (const item of body.items) results.push(await this.one(item, body.ui, requestKey));
        return { results };
    }
    private async one(item: RefreshRequest['items'][number], request: UiRequest, requestKey: string) {
        const parts = item.token.match(/^(rf_[A-Za-z0-9_-]{43})\.(\d{1,10})$/);
        if (!parts) return { surfaceId: item.surfaceId, status: 'gone' };
        const key = hash(parts[1]), sid = item.surfaceId, leaseId = randomUUID(), generation = Number(parts[2]);
        const base = { surfaceId: sid };
        const claimed = await this.store.transact(this.owner, async tx => {
            const record = await tx.get<RefreshRecord>('refresh', key);
            if (!record || generation > record.generation || record.expiresAt <= this.now() || record.ui.messages[0].createSurface.surfaceId !== sid || record.ui.catalogId !== request.catalogId
                || await tx.get('refreshrevoked', sid)) return { result: { ...base, status: 'gone' } };
            if (record.device) {
                const device = await tx.get<any>('device', record.device.id);
                if (!device?.enabled || device.bindingId !== record.device.bindingId) return { result: { ...base, status: 'gone' } };
            }
            const surface = await tx.get<any>('surface', sid);
            if (surface?.deleted || surface && surface.revision !== (record.ui.revision ?? 1)) return { result: { ...base, status: 'gone' } };
            if (generation < record.generation) return { result: { ...base, status: 'updated', ui: record.ui, uiRefresh: metadata(record, parts[1]) } };
            const remaining = Math.max(record.checkedAt + record.interval * 1000 - this.now(), (record.lease?.until ?? 0) - this.now());
            if (remaining > 0) return { result: { ...base, status: 'tooEarly', retryAfterSeconds: Math.ceil(remaining / 1000) } };
            record.lease = { id: leaseId, until: this.now() + 180_000 }; record.checkedAt = this.now();
            await tx.put('refresh', key, record); return { record };
        });
        if (claimed.result) return claimed.result;
        const record = claimed.record!;
        try {
            if (!await this.deps.allowed()) throw limited(3600);
            const answer = await this.deps.run(`${requestKey}:${key}:${leaseId}`, async () => {
                if (record.recipe.source.kind === 'search') return this.deps.search(record.recipe, record.ui);
                const data = parseRefreshData(await this.deps.data(record.recipe.source));
                if (!data || data.identity !== record.recipe.source.data.identity || !data.sources.some(s => s.url === record.recipe.sourceUrl)) throw Error('source_changed');
                const values: Record<string, unknown> = {};
                for (const slot of record.recipe.slots) {
                    if (!Object.prototype.hasOwnProperty.call(data.values, slot.sourceField!)
                        || typeof data.values[slot.sourceField!] !== typeof record.recipe.source.data.values[slot.sourceField!]) throw Error('missing_value');
                    values[slot.id] = dataSlot(data.values[slot.sourceField!], slot);
                }
                return { asOf: data.asOf, values };
            });
            if (!utcDate(answer.asOf) || record.asOf && Date.parse(answer.asOf) < Date.parse(record.asOf)) throw Error('stale_data');
            const next = fillRefreshTemplate(record.ui, record.recipe.slots, answer.values, answer.asOf);
            if (!next) throw Error('invalid_values');
            const changed = record.recipe.slots.some(s => JSON.stringify(slotValue(next, s)) !== JSON.stringify(slotValue(record.ui, s)));
            return await this.store.transact(this.owner, async tx => {
                const current = await tx.get<RefreshRecord>('refresh', key), surface = await tx.get<any>('surface', sid);
                const device = current?.device ? await tx.get<any>('device', current.device.id) : undefined;
                if (!current || current.lease?.id !== leaseId || current.expiresAt <= this.now() || await tx.get('refreshrevoked', sid)
                    || current.device && (!device?.enabled || device.bindingId !== current.device.bindingId)
                    || surface?.deleted || surface && surface.revision !== (record.ui.revision ?? 1)) return { ...base, status: 'gone' };
                if (next.catalogId === UI_CATALOG_V2 && changed) next.revision = (record.ui.revision ?? 1) + 1;
                // Freshness-only changes live in the sidecar; a revision never identifies two different snapshots.
                const snapshot = changed ? next : record.ui;
                current.ui = snapshot; current.asOf = answer.asOf; delete current.lease; delete current.failed;
                if (changed) { current.generation++; current.expiresAt = this.now() + TTL; }
                await tx.put('refresh', key, current);
                await tx.put('refreshindex', key, { expiresAt: current.expiresAt });
                // Presentation cache only. No history/session, memory, dialogue turn or UI-event writes.
                if (surface) await tx.put('surface', sid, { ...surface, ui: snapshot, revision: snapshot.revision ?? 1, updatedAt: this.now(), dataAsOf: answer.asOf });
                return { ...base, status: changed ? 'updated' : 'unchanged', ...(changed ? { ui: next } : {}), uiRefresh: metadata(current, parts[1]) };
            });
        } catch (error) {
            await this.store.transact(this.owner, async tx => {
                const current = await tx.get<RefreshRecord>('refresh', key);
                if (current?.lease?.id === leaseId) { delete current.lease; current.failed = true; await tx.put('refresh', key, current); }
            });
            const policy = accountPolicyError(error);
            if (error instanceof ApiError && error.status === 429 || policy?.status === 429) return { ...base, status: 'tooEarly', retryAfterSeconds: 3600 };
            return { ...base, status: 'failed' };
        }
    }
}
function metadata(record: RefreshRecord, token: string): UiRefreshMeta {
    return { token: token + '.' + record.generation, kind: record.recipe.source.kind, ...(record.asOf ? { asOf: record.asOf } : {}), minIntervalSeconds: record.interval };
}
function invalid() { return new ApiError(400, 'invalid_ui_refresh', 'Передай карточки и явное разрешение ui.refresh.'); }
function limited(seconds: number, code = 'ui_refresh_rate_limited') {
    const error = new ApiError(429, code, 'Обновления карточек временно приостановлены.', true); error.retryAfterSeconds = seconds; return error;
}
