'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readPersonalityDocument(file) {
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Некорректный формат personality.json');
  }
  return data;
}

function writePersonalityProfile(file, profile) {
  const document = readPersonalityDocument(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...document, KiraMindBot: profile }, null, 2));
}

module.exports = { readPersonalityDocument, writePersonalityProfile };
