import { ApiError } from '../api/contracts';
import { UI_CATALOG_ID, type UiRequest } from './contracts';

/** Transport capabilities are scoped to one request and never inferred from device/user text or session. */
export function parseUiRequest(value: unknown): UiRequest | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const ui = value as Record<string, unknown>;
    if (Object.keys(ui).some(key => !['enabled', 'catalogId'].includes(key)) || typeof ui.enabled !== 'boolean') throw invalid();
    if (ui.catalogId !== undefined && ui.catalogId !== UI_CATALOG_ID) throw new ApiError(400, 'unsupported_ui_catalog', 'Этот каталог виджетов не поддерживается.');
    if (!ui.enabled) return undefined;
    if (ui.catalogId !== UI_CATALOG_ID) throw invalid();
    return { enabled: true, catalogId: UI_CATALOG_ID };
}
function invalid() { return new ApiError(400, 'invalid_ui', 'Передай ui: { enabled: true, catalogId: "urn:kira:ui:catalog:1" } или enabled: false.'); }
