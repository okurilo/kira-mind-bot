import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('saved system self-image is corrected on read without rewriting personal memory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kira-self-image-'));
  const memoryFile = path.join(directory, 'self-memory.json');
  const personalityFile = path.join(directory, 'personality.json');
  const legacy = 'Я воспринимаю себя как живого собеседницу с собственным темпом, вкусом и внутренними сдвигами.';
  const custom = `${legacy} Это моя собственная формулировка.`;
  const previous = {
    PERSONALITY_FILE: process.env.PERSONALITY_FILE,
    KIRA_SELF_MEMORY_PATH: process.env.KIRA_SELF_MEMORY_PATH,
    KIRA_RUNTIME_DATA_DIR: process.env.KIRA_RUNTIME_DATA_DIR,
    KIRA_BOT_TOKEN: process.env.KIRA_BOT_TOKEN,
  };

  try {
    fs.writeFileSync(personalityFile, JSON.stringify({ KiraMindBot: { characterName: 'Лея', characterGender: 'женский' } }));
    process.env.PERSONALITY_FILE = personalityFile;
    process.env.KIRA_SELF_MEMORY_PATH = memoryFile;
    process.env.KIRA_RUNTIME_DATA_DIR = directory;
    process.env.KIRA_BOT_TOKEN = 'synthetic-test-token';

    fs.writeFileSync(memoryFile, JSON.stringify({ events: [{ id: 'synthetic-event' }], state: { personality: { selfImage: legacy } } }));
    const { getKiraSelfMemoryState } = require('../utils/kiraSelfMemory') as typeof import('../utils/kiraSelfMemory');
    const state = await getKiraSelfMemoryState();
    assert.match(state.personality.selfImage, /живую собеседницу/u);
    assert.equal(JSON.parse(fs.readFileSync(memoryFile, 'utf8')).state.personality.selfImage, legacy);

    fs.writeFileSync(memoryFile, JSON.stringify({ events: [{ id: 'synthetic-event' }], state: { personality: { selfImage: custom } } }));
    delete require.cache[require.resolve('../utils/kiraSelfMemory')];
    const customMemory = require('../utils/kiraSelfMemory') as typeof import('../utils/kiraSelfMemory');
    assert.equal((await customMemory.getKiraSelfMemoryState()).personality.selfImage, custom);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
