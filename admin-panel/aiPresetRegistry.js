'use strict';

const AI_PRESET_NAMES = [
  'gpt-max',
  'gpt-balanced',
  'gpt-lean',
  'hybrid-deepseek-gpt',
  'hybrid-gemini-gpt',
];

const o = (model) => ({ provider: 'openai', model });
const d = (model) => ({ provider: 'deepseek', model });
const g = (model) => ({ provider: 'gemini', model });

const AI_PRESETS = {
  'gpt-max': {
    name: 'gpt-max',
    title: 'GPT Max',
    description: 'Максимальное качество на OpenAI-моделях.',
    models: {
      defaultText: o('gpt-5.4'), intentClassification: o('gpt-5.4'), intentDedup: o('gpt-5.4'), conversation: o('gpt-5.4'),
      memoryExtraction: o('gpt-5.4'), memoryConsolidation: o('gpt-5.4'), messageAnalysis: o('gpt-5.4'), webSearchReasoning: o('gpt-5.4'),
      browserPlanning: o('gpt-5.4-nano'), browserVision: o('gpt-4o'), embedding: o('text-embedding-ada-002'), transcription: o('whisper-1'),
    },
  },
  'gpt-balanced': {
    name: 'gpt-balanced',
    title: 'GPT Balanced',
    description: 'Сбалансированный OpenAI-пресет с основными текстовыми задачами на mini.',
    models: {
      defaultText: o('gpt-5.4'), intentClassification: o('gpt-5.4-mini'), intentDedup: o('gpt-5.4-mini'), conversation: o('gpt-5.4-mini'),
      memoryExtraction: o('gpt-5.4'), memoryConsolidation: o('gpt-5.4-mini'), messageAnalysis: o('gpt-5.4-mini'), webSearchReasoning: o('gpt-5.4-mini'),
      browserPlanning: o('gpt-5.4-nano'), browserVision: o('gpt-4o'), embedding: o('text-embedding-3-small'), transcription: o('whisper-1'),
    },
  },
  'gpt-lean': {
    name: 'gpt-lean',
    title: 'GPT Lean',
    description: 'Бюджетный OpenAI-пресет с nano для лёгких intent-задач.',
    models: {
      defaultText: o('gpt-5.4-mini'), intentClassification: o('gpt-5.4-nano'), intentDedup: o('gpt-5.4-nano'), conversation: o('gpt-5.4-mini'),
      memoryExtraction: o('gpt-5.4-mini'), memoryConsolidation: o('gpt-5.4-mini'), messageAnalysis: o('gpt-5.4-mini'), webSearchReasoning: o('gpt-5.4-mini'),
      browserPlanning: o('gpt-5.4-nano'), browserVision: o('gpt-4o'), embedding: o('text-embedding-3-small'), transcription: o('whisper-1'),
    },
  },
  'hybrid-deepseek-gpt': {
    name: 'hybrid-deepseek-gpt',
    title: 'Hybrid DeepSeek + GPT',
    description: 'DeepSeek для основного текста, OpenAI для web/vision/embedding/transcription и fallback.',
    models: {
      defaultText: d('deepseek-v4-pro'), intentClassification: d('deepseek-v4-flash'), intentDedup: d('deepseek-v4-flash'), conversation: d('deepseek-v4-pro'),
      memoryExtraction: o('gpt-5.4-nano'), memoryConsolidation: d('deepseek-v4-pro'), messageAnalysis: d('deepseek-v4-pro'), webSearchReasoning: o('gpt-5.4-mini'),
      browserPlanning: o('gpt-5.4-nano'), browserVision: o('gpt-4o'), embedding: o('text-embedding-3-small'), transcription: o('whisper-1'),
    },
  },
  'hybrid-gemini-gpt': {
    name: 'hybrid-gemini-gpt',
    title: 'Hybrid Gemini + GPT',
    description: 'Gemini для conversation/analysis/vision, OpenAI для intent, web, embeddings, whisper и fallback.',
    models: {
      defaultText: g('gemini-3.1-flash-lite'), intentClassification: o('gpt-5.4-nano'), intentDedup: o('gpt-5.4-nano'), conversation: g('gemini-3.1-flash-lite'),
      memoryExtraction: o('gpt-5.4-nano'), memoryConsolidation: g('gemini-3.1-flash-lite'), messageAnalysis: g('gemini-3.1-flash-lite'), webSearchReasoning: o('gpt-5.4-mini'),
      browserPlanning: o('gpt-5.4-nano'), browserVision: g('gemini-3.1-flash-lite'), embedding: o('text-embedding-3-small'), transcription: o('whisper-1'),
    },
  },
};

function parseAiPresetName(raw) {
  return AI_PRESET_NAMES.includes(raw) ? raw : null;
}

module.exports = { AI_PRESET_NAMES, AI_PRESETS, parseAiPresetName };
