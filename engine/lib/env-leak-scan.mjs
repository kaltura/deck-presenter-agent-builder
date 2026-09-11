/**
 * Scan an assembled bundle string for any raw .env value. Defense in depth:
 * the design never puts a secret in the client bundle, but this catches it if
 * something ever does. Returns the .env KEY names that matched, never the
 * matched value itself, so a caller can report a finding without becoming a
 * second place the secret is written down.
 */

const DEFAULT_MIN_LENGTH = 6;

/** Pure, so it is directly testable without touching the filesystem. */
export function scanForEnvLeaks(text, envValues, { excludeKeys = [], excludeValues = [], minLength = DEFAULT_MIN_LENGTH } = {}) {
  const excludeKeySet = new Set(excludeKeys);
  const excludeValueSet = new Set(excludeValues.map(String));
  const leakedKeys = [];

  for (const [key, value] of Object.entries(envValues || {})) {
    if (!value || excludeKeySet.has(key) || excludeValueSet.has(String(value))) continue;
    if (String(value).length < minLength) continue;
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(escaped).test(text)) leakedKeys.push(key);
  }

  return leakedKeys;
}
