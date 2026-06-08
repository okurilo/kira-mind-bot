export interface ConfigEntry {
  value: string;
  masked: boolean;
  rawValue?: string | null;
  rawState?: 'missing' | 'empty' | 'value';
  source?: 'env_file' | 'inherited_default_text' | 'system_default';
  configPath?: string;
  sourceInfo?: ConfigSourceInfo;
}

export interface ConfigResponse {
  [key: string]: ConfigEntry;
}

export type FieldType = 'text' | 'password' | 'number' | 'toggle' | 'textarea' | 'duration';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  placeholder?: string;
}

export interface SectionDef {
  id: string;
  title: string;
  icon: string;
  fields: FieldDef[];
}

export interface Toast {
  message: string;
  severity: 'success' | 'error' | 'info';
}

export interface ModelPreset {
  id: string;
  title: string;
  description: string;
  riskLabel: string;
  costLabel: string;
  qualityLabel: string;
  values: Record<string, string | null>;
}

export interface ConfigSourceInfo {
  kind: 'env_file' | 'database' | 'env_fallback' | 'system_default' | 'runtime_setting';
  label: string;
  description?: string;
  technicalPath?: string;
  appliesImmediately?: boolean;
}

export interface ModelPresetResponse {
  presets: ModelPreset[];
  activePresetId: string | null;
  source?: ConfigSourceInfo;
  configPath?: string;
}

export type AiProvider = 'openai' | 'deepseek' | 'gemini';
export type AiPresetName = 'gpt-max' | 'gpt-balanced' | 'gpt-lean' | 'hybrid-deepseek-gpt' | 'hybrid-gemini-gpt';

export interface AiModelRef {
  provider: AiProvider;
  model: string;
}

export interface AiPresetConfig {
  name: AiPresetName;
  title: string;
  description: string;
  models: Record<string, AiModelRef>;
}

export interface AiPresetResponse {
  activePresetName: AiPresetName;
  storedPresetName?: AiPresetName | null;
  envDefaultPreset: AiPresetName;
  availablePresets: AiPresetConfig[];
  source: ConfigSourceInfo;
}

export interface PersonalityProfile {
  characterName: string;
  persona: string;
  communicationStyle: string;
  biography: string;
  ownerName: string;
  ownerUsername: string;
  userName: string;
  userBirthDate: string;
  moodVariants: string; // one per line
  defaultMood: string;  // empty = random from moodVariants
  proactiveMessageHint: string;
}

export interface PersonalityConfig {
  KiraMindBot: PersonalityProfile;
  SergeyBrainBot: PersonalityProfile;
}

export interface ChatInfo {
  chatId: string;
  title: string;
  chatType: string;
  username?: string;
  profile: string;
  publicMode: boolean;
  allowedDomains: string[];
  forbiddenTopics?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type HealthLogKind =
  | 'food'
  | 'drink'
  | 'symptom'
  | 'medication'
  | 'activity'
  | 'skin'
  | 'blood_pressure'
  | 'note';

export interface HealthLogRecord {
  id: string;
  userId: string | null;
  chatId: string | null;
  kind: HealthLogKind;
  rawText: string;
  summary: string | null;
  severity: number | null;
  occurredAt: string;
  timeOfDay: string | null;
  structured: Record<string, unknown> | null;
  tags: string[];
  photoFileId: string | null;
  createdAt: string;
}

export interface HealthLogKindStat {
  kind: HealthLogKind;
  count: number;
}

export interface HealthLogStats {
  total: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  avgSeverity: number | null;
  byKind: HealthLogKindStat[];
}

export interface HealthLogsResponse {
  records: HealthLogRecord[];
  total: number;
  limit: number;
  offset: number;
  filters: {
    userId?: string;
    kind?: HealthLogKind;
    from?: string;
    to?: string;
    days?: number;
    q?: string;
  };
  stats: HealthLogStats;
}

export interface HealthLogQuery {
  userId?: string;
  kind?: HealthLogKind | '';
  from?: string;
  to?: string;
  days?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export type HealthExportFormat = 'txt' | 'csv' | 'json';
