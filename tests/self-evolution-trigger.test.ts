import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config';
import { shouldAnalyzeConversation } from '../services/kiraSelfEvolutionService';

test('ordinary mention of a common-word character name does not start self-evolution', () => {
  const previousName = config.characterName;
  config.characterName = 'Мир';
  try {
    assert.equal(shouldAnalyzeConversation('Мир вокруг меня сегодня кажется удивительно спокойным.', undefined), false);
    assert.equal(shouldAnalyzeConversation('Мир, расскажи про погоду на завтра, пожалуйста.', undefined), false);
    assert.equal(shouldAnalyzeConversation('Мир, мне не нравится твой стиль общения сегодня.', undefined), true);
    assert.equal(shouldAnalyzeConversation('Мир вокруг меня сегодня кажется удивительно спокойным.', new Date().toISOString()), false);
  } finally {
    config.characterName = previousName;
  }
});

test('direct feedback about a changed assistant triggers self-evolution regardless of name or gender', () => {
  assert.equal(shouldAnalyzeConversation('Кира, ты сильно изменилась за последние месяцы.', undefined), true);
  assert.equal(shouldAnalyzeConversation('Салем, ты сильно изменился за последние месяцы.', undefined), true);
  assert.equal(shouldAnalyzeConversation('Салем, ты сильно изменился за последние месяцы.', new Date().toISOString()), false);
});
