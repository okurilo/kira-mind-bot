'use strict';
const modes = require('./activity-modes.json');
const features = require('./background-features.json');
const keys = Object.keys(features);

function parseActivityMode(value) {
  return typeof value === 'string' && Object.hasOwn(modes, value) ? value : null;
}
function activityPreferences(mode) {
  if (!parseActivityMode(mode) || mode === 'custom') throw Error('Выберите готовый режим активности.');
  const selected = modes[mode].features === 'all' ? keys : modes[mode].features;
  return Object.fromEntries(keys.map(key => [key, selected.includes(key)]));
}
function inferActivityMode(preferences) {
  for (const key of Object.keys(modes).filter(key => key !== 'custom')) {
    const candidate = activityPreferences(key);
    if (keys.every(feature => candidate[feature] === preferences[feature])) return key;
  }
  return 'custom';
}
function activityModes() {
  return Object.entries(modes).map(([key, value]) => ({ key, title: value.title, description: value.description,
    benefits: [...value.benefits], costNote: value.costNote,
    featureKeys: key === 'custom' ? null : keys.filter(feature => activityPreferences(key)[feature]) }));
}
module.exports = { parseActivityMode, activityPreferences, inferActivityMode, activityModes };
