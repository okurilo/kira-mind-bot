import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { plainObject, onlyKeys, uiId, uiString, utcDate } from './forms';
import { safeUiUrl } from './validate';

type Scalar = string | number | boolean;
export type RefreshValue = Scalar | Scalar[] | Scalar[][];
export function refreshValue(value: unknown, depth = 0): value is RefreshValue {
    return typeof value === 'string' && value.length <= 3000 || typeof value === 'boolean'
        || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15
        || depth < 2 && Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(v => refreshValue(v, depth + 1));
}
export interface RefreshData { identity: string; asOf: string; sources: Array<{ label: string; url: string }>; values: Record<string, RefreshValue> }
export type RefreshEvidence =
    | { kind: 'search'; query: string; text: string; sources: RefreshData['sources'] }
    | { kind: 'data'; adapter: 'mcp'; server: string; tool: string; args: Record<string, unknown>; authority: string; data: RefreshData };
const capture = new AsyncLocalStorage<RefreshEvidence[]>();
export function withUiRefreshCapture<T>(enabled: boolean, work: () => Promise<T>): Promise<T> {
    return enabled && process.env.KIRA_UI_REFRESH_ENABLED !== 'false' ? capture.run([], work) : work();
}
export function uiRefreshEvidence(): RefreshEvidence[] { return capture.getStore() ?? []; }
export function rememberRefreshEvidence(value: RefreshEvidence) {
    const records = capture.getStore();
    if (!records || records.length >= 4 || Buffer.byteLength(JSON.stringify(value)) > 24_000) return;
    records.push(structuredClone(value));
}
export function citationSources(response: unknown): RefreshData['sources'] {
    const urls = new Map<string, string>();
    const output = (response as any)?.output;
    if (!Array.isArray(output)) return [];
    for (const item of output) if (item?.type === 'web_search_call' && Array.isArray(item.action?.sources)) {
        for (const source of item.action.sources) if (safeUiUrl(source?.url)) urls.set(source.url, typeof source.title === 'string' && source.title.trim() ? source.title.slice(0, 160) : 'Источник');
    }
    for (const message of output) for (const part of Array.isArray(message?.content) ? message.content : []) {
        for (const a of Array.isArray(part?.annotations) ? part.annotations : []) if (a?.type === 'url_citation' && safeUiUrl(a.url)) {
            urls.set(a.url, typeof a.title === 'string' && a.title.trim() ? a.title.slice(0, 160) : 'Источник');
        }
    }
    return [...urls].slice(0, 64).map(([url, label]) => ({ label, url }));
}
export function parseRefreshData(value: unknown): RefreshData | undefined {
    if (!plainObject(value) || !onlyKeys(value, ['identity', 'asOf', 'sources', 'values']) || !uiString(value.identity, 500) || !utcDate(value.asOf) || !Array.isArray(value.sources)
        || value.sources.length < 1 || value.sources.length > 8 || !value.sources.every(s => plainObject(s) && onlyKeys(s, ['label', 'url']) && uiString(s.label, 160) && safeUiUrl(s.url))
        || !plainObject(value.values) || Object.keys(value.values).length < 1 || Object.keys(value.values).length > 64
        || !Object.entries(value.values).every(([k, v]) => uiId(k) && refreshValue(v))
        || Buffer.byteLength(JSON.stringify(value)) > 20_000) return;
    return value as RefreshData;
}
/** No credentials are persisted in recipes; endpoint/fixed identity changes invalidate replay. */
export function mcpRefreshAuthority(config: any, tool: string): string {
    return createHash('sha256').update(JSON.stringify({ transport: config.transport, url: config.url, command: config.command, args: config.args,
        fixedArguments: config.fixedArguments, effect: config.tools[tool], enabled: config.refreshTools?.includes(tool) === true })).digest('hex');
}
export function refreshSourceView(source: RefreshEvidence, index: number) {
    return source.kind === 'search' ? { index, kind: source.kind, query: source.query, text: source.text, sources: source.sources,
        slotKeys: ['id', 'componentId', 'path', 'description'] }
        : { index, kind: source.kind, ...source.data, slotKeys: ['id', 'componentId', 'path', 'description', 'sourceField', 'prefix', 'suffix'] };
}
