import type { ActivityMode, ActivityPreset, ActivityModeDescriptor } from './activityModes';
import type { BackgroundFeature } from './backgroundFeatures';
export function parseActivityMode(value: unknown): ActivityMode | null;
export function activityPreferences(mode: ActivityPreset): Record<BackgroundFeature, boolean>;
export function inferActivityMode(preferences: Record<string, boolean>): ActivityMode;
export function activityModes(): ActivityModeDescriptor[];
