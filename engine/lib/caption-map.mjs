/**
 * Derives the live-caption replacement map from prompts/pronunciation-guide.md,
 * so the caption track can show normal spelling for a term the TTS is told to
 * speak in some other written form. One generic transform, per ARCHITECTURE.md 5 —
 * never a per-project hand-maintained map.
 *
 * Each guide line has the shape `TERM -> "spoken form"`. The map inverts it:
 * the caption track sees "spoken form" in the text stream and replaces it
 * with TERM for display.
 */
const LINE_RE = /^(.+?)\s*->\s*"(.+)"\s*$/;

export function buildCaptionMap(guideText) {
  const map = {};
  for (const line of guideText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    const m = trimmed.match(LINE_RE);
    if (!m) {
      if (trimmed.includes('->')) {
        throw new Error(`pronunciation-guide.md line does not match TERM -> "spoken form": ${JSON.stringify(trimmed)}`);
      }
      continue;
    }
    const [, term, spokenForm] = m;
    map[spokenForm.trim()] = term.trim();
  }
  return map;
}
