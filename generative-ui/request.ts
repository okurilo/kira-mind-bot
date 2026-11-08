import { ApiError } from '../api/contracts';
import { UI_CATALOG_ID, UI_CATALOG_V2, type UiRequest } from './contracts';

/** Transport capabilities are scoped to one request and never inferred from device/user text or session. */
export function parseUiRequest(value: unknown): UiRequest | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const ui = value as Record<string, unknown>;
    if (Object.keys(ui).some(key => !['enabled', 'catalogId', 'metadata', 'refresh', 'target', 'device'].includes(key)) || typeof ui.enabled !== 'boolean') throw invalid();
    if (ui.catalogId !== undefined && ![UI_CATALOG_ID, UI_CATALOG_V2].includes(ui.catalogId as any)) throw new ApiError(400, 'unsupported_ui_catalog', 'Этот каталог виджетов не поддерживается.');
    if (ui.metadata !== undefined && typeof ui.metadata !== 'boolean') throw invalid();
    if (ui.refresh !== undefined && typeof ui.refresh !== 'boolean') throw invalid();
    const pair = (v: unknown, fields: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(f => f in v);
    if (ui.target !== undefined && (ui.catalogId !== UI_CATALOG_V2 || !pair(ui.target, ['surfaceId', 'revision'])
        || typeof (ui.target as any).surfaceId !== 'string' || !/^kira_[a-f0-9]{32}$/.test((ui.target as any).surfaceId) || !Number.isSafeInteger((ui.target as any).revision) || (ui.target as any).revision < 1)) throw invalid();
    if (ui.device !== undefined && (!pair(ui.device, ['id', 'bindingId']) || !['id', 'bindingId'].every(f => typeof (ui.device as any)[f] === 'string'
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test((ui.device as any)[f])))) throw invalid();
    if (!ui.enabled) return undefined;
    if (ui.catalogId !== UI_CATALOG_ID && ui.catalogId !== UI_CATALOG_V2) throw invalid();
    return { enabled: true, catalogId: ui.catalogId, ...(ui.metadata === true ? { metadata: true } : {}), ...(ui.refresh === true ? { refresh: true } : {}),
        ...(ui.target ? { target: ui.target as UiRequest['target'] } : {}), ...(ui.device ? { device: ui.device as UiRequest['device'] } : {}) };
}
function invalid() { return new ApiError(400, 'invalid_ui', 'Передай ui: { enabled: true, catalogId: "urn:kira:ui:catalog:1" } или enabled: false.'); }
