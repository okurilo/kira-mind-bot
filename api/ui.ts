import { createHash } from 'node:crypto';
import { ApiError, type ApiOperationStore } from './contracts';
import { UiService, parseFeedback } from '../generative-ui/service';
import { parseRefreshRequest } from '../generative-ui/refresh';

const UUID = '[a-f0-9-]{36}';
export function uiRouteAllowed(method: string, path: string) {
    if (method === 'POST') return path === '/api/v1/ui-feedback' || path === '/api/v1/ui/refresh';
    if (method === 'GET') return ['/api/v1/ui/devices', '/api/v1/ui/feedback-metrics', '/api/v1/ui/surfaces'].includes(path);
    if (method === 'PUT') return new RegExp('^/api/v1/ui/devices/' + UUID + '$').test(path);
    return method === 'DELETE' && (new RegExp('^/api/v1/ui/devices/' + UUID + '$').test(path) || /^\/api\/v1\/ui\/surfaces\/kira_[a-f0-9]{32}$/.test(path));
}
export function parseUiPoll(params: URLSearchParams) {
    if (!['uiAfter', 'uiDeviceId', 'uiBindingId'].some(k => params.has(k))) return;
    const result: { after?: string; deviceId?: string; bindingId?: string } = {};
    for (const [name, value] of params) {
        const key = ({ uiAfter: 'after', uiDeviceId: 'deviceId', uiBindingId: 'bindingId' } as const)[name as 'uiAfter'];
        if (!key || result[key] !== undefined) throw invalid();
        result[key] = value;
    }
    return result;
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
    return JSON.stringify(value);
}
export function uiRequestFingerprint(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export class UiHttpApi {
    constructor(readonly service: UiService) {}
    async request(method: string, path: string, params: URLSearchParams, read: () => Promise<Record<string, unknown>>, key: unknown, operations: ApiOperationStore) {
        if (!uiRouteAllowed(method, path)) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        if (path === '/api/v1/ui/refresh' && process.env.KIRA_UI_REFRESH_ENABLED === 'false') throw new ApiError(404, 'not_found', 'Обновления карточек недоступны.');
        if (method === 'GET') {
            if ([...params].length) throw invalid();
            if (path.endsWith('/devices')) return this.service.devices();
            if (path.endsWith('/surfaces')) return this.service.surfaces();
            return this.service.metrics();
        }
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'Нужен Idempotency-Key.');
        if (!operations.runJson) throw new ApiError(503, 'ui_receipts_unavailable', 'Сохранение квитанций временно недоступно.');
        const body = method === 'DELETE' ? {} : await read();
        const revision = Number(params.get('expectedRevision'));
        if (path.includes('/surfaces/')) {
            if ([...params.keys()].some(k => k !== 'expectedRevision') || params.getAll('expectedRevision').length !== 1 || !Number.isSafeInteger(revision) || revision < 1) throw invalid();
        } else if ([...params].length) throw invalid();
        // Reject malformed diagnostic data before writing the durable request receipt.
        if (path === '/api/v1/ui-feedback') parseFeedback(body);
        const refresh = path === '/api/v1/ui/refresh' ? parseRefreshRequest(body) : undefined;
        return operations.runJson(`ui:${this.service.owner}:${uiRequestFingerprint(key)}`, uiRequestFingerprint({ method, path, query: [...params], body }), async () => {
            if (path === '/api/v1/ui-feedback') return this.service.feedback(body, key);
            if (refresh) return this.service.refresh.batch(refresh, key);
            const id = path.split('/').pop()!;
            if (path.includes('/surfaces/')) return this.service.delete(id, revision);
            return method === 'DELETE' ? this.service.revokeDevice(id) : this.service.saveDevice(id, body);
        }, { releaseRefusals: true });
    }
}
function invalid() { return new ApiError(400, 'invalid_ui_request', 'Проверь параметры карточки.'); }
