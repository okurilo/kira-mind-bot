import type { BackgroundFeature, BackgroundFeatureState } from '../ai/backgroundFeatures';
import { BACKGROUND_FEATURES } from '../ai/backgroundFeatures';
import { parseBudgetMode, type BudgetMode } from '../ai/budgetMode';
import { ApiError } from './contracts';
import { activityPreferences, parseActivityMode, type ActivityMode, type ActivityModeDescriptor } from '../ai/activityModes';

export interface ApiSettings {
    budgetMode: BudgetMode;
    budgetModes: { key: BudgetMode; title: string }[];
    telegram: { personalSessionConfigured: boolean };
    features: BackgroundFeatureState[];
    activityMode: ActivityMode;
    activityModes: ActivityModeDescriptor[];
}

export interface ApiSettingsPatch {
    budgetMode?: BudgetMode;
    background?: Partial<Record<BackgroundFeature, boolean>>;
    activityMode?: ActivityMode;
}

/** Strict allowlist: client input never becomes an arbitrary bot_settings key or credential. */
export function parseSettingsPatch(body: Record<string, unknown>): ApiSettingsPatch {
    const invalid = () => new ApiError(400, 'invalid_settings', 'Передай activityMode из каталога, budgetMode (normal или maximum) или background с булевыми переключателями. Готовый режим и ручной набор сохраняются отдельно.');
    if (Object.keys(body).some(key => !['budgetMode', 'background', 'activityMode'].includes(key))) throw invalid();
    const patch: ApiSettingsPatch = {};
    if ('budgetMode' in body) {
        const mode = parseBudgetMode(body.budgetMode);
        if (!mode) throw invalid();
        patch.budgetMode = mode;
    }
    if ('background' in body) {
        const values = body.background;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid();
        const entries = Object.entries(values);
        if (entries.some(([key, value]) => !Object.prototype.hasOwnProperty.call(BACKGROUND_FEATURES, key) || typeof value !== 'boolean')) throw invalid();
        patch.background = Object.fromEntries(entries);
    }
    if ('activityMode' in body) {
        const mode = parseActivityMode(body.activityMode);
        if (!mode || (mode !== 'custom' && 'background' in body) || (mode === 'custom' && !Object.keys(patch.background || {}).length)) throw invalid();
        patch.activityMode = mode;
        if (mode !== 'custom') {
            patch.background = activityPreferences(mode);
            patch.budgetMode ??= 'normal';
        }
    }
    if (!patch.budgetMode && !Object.keys(patch.background || {}).length) throw invalid();
    return patch;
}
