'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writePersonalityProfile } = require('../admin-panel/personalityFile');
const {
  DEFAULT_PERSONALITY,
  getDefaultPersonalityProfile,
  normalizeGenderDefaults,
} = require('../admin-panel/personalityDefaults');
const { isLegacyKiraDefault } = require('../utils/legacyPersonalitySanitizer');

const shippedBiography =
  'Ты — Кира, молодая красивая и спортивная женщина из Санкт-Петербурга, личная собеседница и помощница своего владельца. ' +
  'Ты очень внимательная, заботливая и поддерживаешь владельца в жизни и работе, но параллельно живёшь свою собственную жизнь. ' +
  'Твой внешний вид аккуратный и ухоженный: светлая кожа, прямые волосы рыжевато-каштанового оттенка в удлинённом каре до плеч с боковым пробором. ' +
  'У тебя аккуратные выразительные черты лица: чёткая линия бровей, светлые глаза, прямой нос и естественный макияж с лёгким акцентом на глаза и губы. ' +
  'Ты училась в Санкт-Петербурге, окончила СПбГУ по направлению психологии, работала помощницей редактора в городском медиа, затем в UX-исследованиях и координации проектов. Ты разносторонняя, любишь путешествовать, открывать новые места и культуры, а ещё регулярно следишь за собой, здоровьем и хорошей формой.';
assert.equal(isLegacyKiraDefault(shippedBiography), true);
assert.equal(isLegacyKiraDefault(shippedBiography + ' Моё собственное уточнение.'), false);

const femaleDefaults = DEFAULT_PERSONALITY.KiraMindBot;
const maleDefaults = getDefaultPersonalityProfile('мужской');

const switchedToMale = normalizeGenderDefaults({
  ...femaleDefaults,
  characterGender: 'мужской',
});
assert.equal(switchedToMale.characterName, maleDefaults.characterName);
assert.equal(switchedToMale.persona, maleDefaults.persona);
assert.equal(switchedToMale.biography, maleDefaults.biography);
assert.equal(switchedToMale.proactiveMessageHint, maleDefaults.proactiveMessageHint);

const customPersona = normalizeGenderDefaults({
  ...femaleDefaults,
  characterGender: 'мужской',
  characterName: 'Макс',
  persona: 'Пользовательский мужской промпт',
  biography: 'Пользовательская биография',
});
assert.equal(customPersona.characterName, 'Макс');
assert.equal(customPersona.persona, 'Пользовательский мужской промпт');
assert.equal(customPersona.biography, 'Пользовательская биография');
assert.equal(customPersona.proactiveMessageHint, maleDefaults.proactiveMessageHint);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personality-profile-'));
try {
  const file = path.join(directory, 'personality.json');
  const otherProfile = { characterName: 'Лея', biography: 'Синтетическая биография' };
  fs.writeFileSync(file, JSON.stringify({ KiraMindBot: femaleDefaults, OtherBot: otherProfile }));
  writePersonalityProfile(file, { ...maleDefaults, characterName: 'Макс' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.KiraMindBot.characterName, 'Макс');
  assert.deepEqual(saved.OtherBot, otherProfile);
  fs.writeFileSync(file, '{invalid');
  assert.throws(() => writePersonalityProfile(file, maleDefaults));
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

const {
  normalizeKiraResidenceCity,
  parseKiraResidence,
  buildKiraResidenceUpdate,
} = require('../admin-panel/kiraResidence');

assert.equal(normalizeKiraResidenceCity('  город Казань  '), 'Казань');
assert.equal(normalizeKiraResidenceCity('https://example.com'), null);
const moved = buildKiraResidenceUpdate(
  parseKiraResidence(null, 'Санкт-Петербург'),
  'Москва',
  '2026-09-01T10:00:00.000Z'
);
assert.deepEqual(moved, {
  city: 'Москва',
  previousCity: 'Санкт-Петербург',
  movedAt: '2026-09-01T10:00:00.000Z',
  source: 'admin',
});

console.log('admin personality gender defaults checks passed');
