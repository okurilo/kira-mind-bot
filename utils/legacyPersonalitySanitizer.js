const { createHash } = require('node:crypto');

// Exact hashes of previously shipped defaults. User-authored text is never rewritten by a name search.
const LEGACY_KIRA_DEFAULTS = new Set([
  '3365d964238945acc169f342789a915c00cb756fc24e96dbf4ff6092da9ad58b',
  '0d234c998c26985bedffc5234cef600ae30c26ab8e96145d76135730a88f6ea6',
  '2f1861e01d736078b7c7f86ef2949d2b8af3fc3ad6a967b76ecc18617b439150',
  'd8b40a4a94358c9f08de07ee0a48adadc51cebaa76cdfadcae0b6d5305459c44',
]);

function isLegacyKiraDefault(value) {
  return typeof value === 'string' && LEGACY_KIRA_DEFAULTS.has(createHash('sha256').update(value).digest('hex'));
}

const STRONG_LEGACY_PATTERNS = [
  /сны данных/iu,
  /лицей контекста/iu,
  /хранительниц[аы] малых архивов/iu,
  /учебные залы/iu,
  /город потоков/iu,
];

function hasLegacyDigitalBiography(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;

  return STRONG_LEGACY_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = {
  hasLegacyDigitalBiography,
  isLegacyKiraDefault,
};
