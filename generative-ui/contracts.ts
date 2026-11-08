/** Pinned, literal-only A2UI profile. A different component contract requires a new catalog ID. */
export const UI_CATALOG_ID = 'urn:kira:ui:catalog:1' as const;
export interface UiRequest { enabled: true; catalogId: typeof UI_CATALOG_ID }
export type UiAction =
    | { event: { name: 'kira.reply' | 'kira.action'; context: { actionToken: string } } }
    | { functionCall: { '@call': 'openUrl'; args: { url: string } } };
export type UiComponent = { id: string } & (
    | { component: 'Column' | 'Row'; children: string[]; gap?: 'small' | 'medium' | 'large' }
    | { component: 'Card'; child: string }
    | { component: 'Text'; text: string; variant?: 'title' | 'body' | 'caption' }
    | { component: 'Divider' }
    | { component: 'Metric'; label: string; value: string; detail?: string; tone?: 'neutral' | 'positive' | 'negative' }
    | { component: 'Table'; columns: string[]; rows: string[][] }
    | { component: 'Chart'; kind: 'line' | 'bar' | 'donut'; labels: string[]; series: Array<{ label: string; values: number[] }>; unit?: string }
    | { component: 'Button'; child: string; action: UiAction }
);
export interface UiPayload {
    protocol: 'a2ui';
    version: '1.0';
    catalogId: typeof UI_CATALOG_ID;
    /** Atomic snapshot in arrival order; v1 emits exactly one createSurface with literal components. */
    messages: Array<{ version: '1.0'; createSurface: { surfaceId: string; catalogId: typeof UI_CATALOG_ID; components: UiComponent[] } }>;
}
export const UI_LIMITS = { bytes: 32_768, components: 64, depth: 8, buttons: 6 } as const;
export const UI_CAPABILITY = {
    protocol: 'a2ui', version: '1.0', catalogId: UI_CATALOG_ID,
    request: 'ui: { enabled: true, catalogId }', delivery: 'messages[].ui',
    components: ['Column', 'Row', 'Card', 'Text', 'Divider', 'Metric', 'Table', 'Chart', 'Button'],
    actions: ['openUrl', 'kira.reply', 'kira.action'],
    mode: 'snapshot', bindings: false, streaming: false, limits: UI_LIMITS,
} as const;
