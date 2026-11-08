/** Pinned, literal-only A2UI profile. A different component contract requires a new catalog ID. */
export const UI_CATALOG_ID = 'urn:kira:ui:catalog:1' as const;
export const UI_CATALOG_V2 = 'urn:kira:ui:catalog:2' as const;
export type UiCatalogId = typeof UI_CATALOG_ID | typeof UI_CATALOG_V2;
export interface UiRequest {
    enabled: true; catalogId: UiCatalogId; metadata?: true;
    target?: { surfaceId: string; revision: number };
    device?: { id: string; bindingId: string };
}
export interface UiMeta { title?: string; asOf?: string; sources?: Array<{ label: string; url: string }> }
export type UiAction =
    | { event: { name: 'kira.reply' | 'kira.action'; context: { actionToken: string } } }
    | { event: { name: 'kira.submit'; context: { actionToken: string; fields: string[] } } }
    | { functionCall: { '@call': 'openUrl'; args: { url: string } } };
export type UiInput = { id: string; label: string } & (
    | { component: 'Choice'; options: Array<{ value: string; label: string }>; value?: string }
    | { component: 'Slider'; min: number; max: number; step: number; value: number }
    | { component: 'Toggle'; value: boolean }
    | { component: 'DateTime'; min?: string; max?: string; value?: string }
);
export type UiComponent = UiInput | { id: string } & (
    | { component: 'Column' | 'Row'; children: string[]; gap?: 'small' | 'medium' | 'large' }
    | { component: 'Card'; child: string }
    | { component: 'Text'; text: string; variant?: 'title' | 'body' | 'caption' }
    | { component: 'Divider' }
    | { component: 'Metric'; label: string; value: string; detail?: string; tone?: 'neutral' | 'positive' | 'negative' }
    | { component: 'Table'; columns: string[]; rows: string[][] }
    | { component: 'Chart'; kind: 'line' | 'bar' | 'donut'; labels: string[]; series: Array<{ label: string; values: number[] }>; unit?: string }
    | { component: 'Button'; child: string; action: UiAction }
    | { component: 'Progress'; label: string; value: number; detail?: string }
    | { component: 'Steps'; items: Array<{ label: string; detail?: string; state: 'done' | 'current' | 'todo' }> }
    | { component: 'Map'; pins: Array<{ lat: number; lon: number; label: string }>; region?: { lat: number; lon: number; latitudeDelta: number; longitudeDelta: number } }
    | { component: 'Image'; fileId: string; alt: string }
    | { component: 'Countdown'; until: string; label: string }
    | { component: 'Checklist'; items: Array<{ id: string; label: string; checked: boolean; actionToken?: string }> }
);
export interface UiPayload {
    protocol: 'a2ui';
    version: '1.0';
    catalogId: UiCatalogId;
    meta?: UiMeta;
    revision?: number;
    /** Atomic snapshot in arrival order; v1 emits exactly one createSurface with literal components. */
    messages: Array<{ version: '1.0'; createSurface: { surfaceId: string; catalogId: UiCatalogId; components: UiComponent[] } }>;
}
export interface UiChange {
    protocol: 'a2ui'; version: '1.0'; catalogId: typeof UI_CATALOG_V2; revision: number; meta?: UiMeta;
    messages: Array<{ version: '1.0'; updateComponents: { surfaceId: string; components: UiComponent[] } }
        | { version: '1.0'; deleteSurface: { surfaceId: string } }>;
}
export interface UiPlacement { surfaceId: string; objectId: string; side: 'front' | 'top' | 'wall' }
export type UiValues = Record<string, string | number | boolean>;
export const UI_LIMITS = { bytes: 32_768, components: 64, depth: 8, buttons: 6 } as const;
export const UI_V2_COMPONENTS = ['Progress', 'Steps', 'Map', 'Image', 'Countdown', 'Checklist', 'Choice', 'Slider', 'Toggle', 'DateTime'] as const;
const V1_COMPONENTS = ['Column', 'Row', 'Card', 'Text', 'Divider', 'Metric', 'Table', 'Chart', 'Button'];
const V1_ACTIONS = ['openUrl', 'kira.reply', 'kira.action'];
export const UI_CAPABILITY = {
    protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_ID,
    request: 'ui: { enabled: true, catalogId }', delivery: 'messages[].ui',
    components: V1_COMPONENTS,
    actions: V1_ACTIONS,
    mode: 'snapshot', bindings: false, streaming: false, limits: UI_LIMITS,
    catalogs: [UI_CATALOG_ID, UI_CATALOG_V2],
    catalogDefinitions: {
        [UI_CATALOG_ID]: { components: V1_COMPONENTS, actions: V1_ACTIONS, limits: UI_LIMITS, metadata: false, updates: false },
        [UI_CATALOG_V2]: { components: [...V1_COMPONENTS, ...UI_V2_COMPONENTS], actions: [...V1_ACTIONS, 'kira.submit'], limits: UI_LIMITS, metadata: true, updates: true },
    },
    metadata: { requestFlag: 'metadata', maxTitleLength: 80, maxSources: 8 },
    feedback: true, feedbackPath: '/api/v1/ui-feedback', feedbackRateLimit: 60,
    forms: { catalogId: UI_CATALOG_V2, maxFields: 8, valuesIn: '/api/v1/actions' },
    updates: { catalogId: UI_CATALOG_V2, minIntervalMs: 60_000, pollPath: '/api/v1/dialogue-jobs' },
    proactive: { catalogId: UI_CATALOG_V2, preferencesPath: '/api/v1/ui/devices', delivery: 'widget-note', actions: false },
} as const;
