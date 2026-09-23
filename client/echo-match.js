// Shared by client/app.js (bundled into the browser) and test/*.test.mjs.
// No Node-only or DOM-only APIs here, so both can import it as-is.
//
// Normalizes typed/spoken text for fuzzy-match comparison: the SDK's
// transcript echo of a typed question can differ in case, whitespace, or
// punctuation (a live STT pass can drop or add a "?") from what the viewer
// typed, so comparisons go through this first.
export function normalizeTyped(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// True when one normalized string is the other, or is fully contained in the
// other: the SDK can echo back only part of a longer typed question, or merge
// a typed question with app-injected text before echoing it.
export function typedTextsMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
