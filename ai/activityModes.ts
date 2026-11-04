import registry from './activity-modes.json';
import type { BackgroundFeature } from './backgroundFeatures';
import * as catalog from './activityModeCatalog';

export type ActivityMode = keyof typeof registry;
export type ActivityPreset = Exclude<ActivityMode, 'custom'>;
export interface ActivityModeDescriptor {
    key: ActivityMode;
    title: string;
    description: string;
    benefits: string[];
    costNote: string;
    featureKeys: BackgroundFeature[] | null;
}
export const parseActivityMode: (value: unknown) => ActivityMode | null = catalog.parseActivityMode;
export const activityPreferences: (mode: ActivityPreset) => Record<BackgroundFeature, boolean> = catalog.activityPreferences;
export const inferActivityMode: (preferences: Record<string, boolean>) => ActivityMode = catalog.inferActivityMode;
export const activityModes: () => ActivityModeDescriptor[] = catalog.activityModes;
