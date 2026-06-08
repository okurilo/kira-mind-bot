export type AiProvider = 'openai' | 'deepseek' | 'gemini';

export type AiTaskKey =
    | 'defaultText'
    | 'intentClassification'
    | 'intentDedup'
    | 'conversation'
    | 'memoryExtraction'
    | 'memoryConsolidation'
    | 'messageAnalysis'
    | 'webSearchReasoning'
    | 'browserPlanning'
    | 'browserVision'
    | 'embedding'
    | 'transcription';

export interface AiModelRef {
    provider: AiProvider;
    model: string;
}

export type AiPresetName =
    | 'gpt-max'
    | 'gpt-balanced'
    | 'gpt-lean'
    | 'hybrid-deepseek-gpt'
    | 'hybrid-gemini-gpt';

export interface AiPresetConfig {
    name: AiPresetName;
    title: string;
    description: string;
    models: Record<AiTaskKey, AiModelRef>;
}

export const AI_PRESET_NAMES: AiPresetName[] = [
    'gpt-max',
    'gpt-balanced',
    'gpt-lean',
    'hybrid-deepseek-gpt',
    'hybrid-gemini-gpt',
];

const openai = (model: string): AiModelRef => ({ provider: 'openai', model });
const deepseek = (model: string): AiModelRef => ({ provider: 'deepseek', model });
const gemini = (model: string): AiModelRef => ({ provider: 'gemini', model });

export const gptMaxPreset: AiPresetConfig = {
    name: 'gpt-max',
    title: 'GPT Max',
    description: 'Максимальное качество на OpenAI-моделях с системными дефолтами.',
    models: {
        defaultText: openai('gpt-5.4'),
        intentClassification: openai('gpt-5.4'),
        intentDedup: openai('gpt-5.4'),
        conversation: openai('gpt-5.4'),
        memoryExtraction: openai('gpt-5.4'),
        memoryConsolidation: openai('gpt-5.4'),
        messageAnalysis: openai('gpt-5.4'),
        webSearchReasoning: openai('gpt-5.4'),
        browserPlanning: openai('gpt-5.4-nano'),
        browserVision: openai('gpt-4o'),
        embedding: openai('text-embedding-ada-002'),
        transcription: openai('whisper-1'),
    },
};

export const gptBalancedPreset: AiPresetConfig = {
    name: 'gpt-balanced',
    title: 'GPT Balanced',
    description: 'Сбалансированный OpenAI-пресет с основными текстовыми задачами на mini.',
    models: {
        defaultText: openai('gpt-5.4'),
        intentClassification: openai('gpt-5.4-mini'),
        intentDedup: openai('gpt-5.4-mini'),
        conversation: openai('gpt-5.4-mini'),
        memoryExtraction: openai('gpt-5.4'),
        memoryConsolidation: openai('gpt-5.4-mini'),
        messageAnalysis: openai('gpt-5.4-mini'),
        webSearchReasoning: openai('gpt-5.4-mini'),
        browserPlanning: openai('gpt-5.4-nano'),
        browserVision: openai('gpt-4o'),
        embedding: openai('text-embedding-3-small'),
        transcription: openai('whisper-1'),
    },
};

export const gptLeanPreset: AiPresetConfig = {
    name: 'gpt-lean',
    title: 'GPT Lean',
    description: 'Бюджетный OpenAI-пресет с nano для лёгких intent-задач.',
    models: {
        defaultText: openai('gpt-5.4-mini'),
        intentClassification: openai('gpt-5.4-nano'),
        intentDedup: openai('gpt-5.4-nano'),
        conversation: openai('gpt-5.4-mini'),
        memoryExtraction: openai('gpt-5.4-mini'),
        memoryConsolidation: openai('gpt-5.4-mini'),
        messageAnalysis: openai('gpt-5.4-mini'),
        webSearchReasoning: openai('gpt-5.4-mini'),
        browserPlanning: openai('gpt-5.4-nano'),
        browserVision: openai('gpt-4o'),
        embedding: openai('text-embedding-3-small'),
        transcription: openai('whisper-1'),
    },
};

export const hybridDeepSeekGptPreset: AiPresetConfig = {
    name: 'hybrid-deepseek-gpt',
    title: 'Hybrid DeepSeek + GPT',
    description: 'DeepSeek для основного текста и OpenAI для fallback, web/vision/embedding/transcription.',
    models: {
        defaultText: deepseek('deepseek-v4-pro'),
        intentClassification: deepseek('deepseek-v4-flash'),
        intentDedup: deepseek('deepseek-v4-flash'),
        conversation: deepseek('deepseek-v4-pro'),
        memoryExtraction: openai('gpt-5.4-nano'),
        memoryConsolidation: deepseek('deepseek-v4-pro'),
        messageAnalysis: deepseek('deepseek-v4-pro'),
        webSearchReasoning: openai('gpt-5.4-mini'),
        browserPlanning: openai('gpt-5.4-nano'),
        browserVision: openai('gpt-4o'),
        embedding: openai('text-embedding-3-small'),
        transcription: openai('whisper-1'),
    },
};

export const hybridGeminiGptPreset: AiPresetConfig = {
    name: 'hybrid-gemini-gpt',
    title: 'Hybrid Gemini + GPT',
    description: 'Gemini для conversation/analysis/vision и OpenAI для intent, web, embeddings, whisper и fallback.',
    models: {
        defaultText: gemini('gemini-3.1-flash-lite'),
        intentClassification: openai('gpt-5.4-nano'),
        intentDedup: openai('gpt-5.4-nano'),
        conversation: gemini('gemini-3.1-flash-lite'),
        memoryExtraction: openai('gpt-5.4-nano'),
        memoryConsolidation: gemini('gemini-3.1-flash-lite'),
        messageAnalysis: gemini('gemini-3.1-flash-lite'),
        webSearchReasoning: openai('gpt-5.4-mini'),
        browserPlanning: openai('gpt-5.4-nano'),
        browserVision: gemini('gemini-3.1-flash-lite'),
        embedding: openai('text-embedding-3-small'),
        transcription: openai('whisper-1'),
    },
};

export const aiPresets: Record<AiPresetName, AiPresetConfig> = {
    'gpt-max': gptMaxPreset,
    'gpt-balanced': gptBalancedPreset,
    'gpt-lean': gptLeanPreset,
    'hybrid-deepseek-gpt': hybridDeepSeekGptPreset,
    'hybrid-gemini-gpt': hybridGeminiGptPreset,
};

export function parseAiPresetName(raw: string | undefined | null): AiPresetName | null {
    if (!raw) return null;
    return AI_PRESET_NAMES.includes(raw as AiPresetName) ? raw as AiPresetName : null;
}
