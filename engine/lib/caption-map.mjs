/**
 * Derives the live-caption replacement map from prompts/pronunciation-guide.md,
 * so the caption track can show normal spelling for a term the TTS is told to
 * speak in some other written form. One generic transform, per ARCHITECTURE.md 5,
 * never a per-project hand-maintained map.
 *
 * Each guide line has the shape `TERM -> "spoken form"`. The map inverts it:
 * the caption track sees "spoken form" in the text stream and replaces it
 * with TERM for display.
 */
const LINE_RE = /^(.+?)\s*->\s*"(.+)"\s*$/;

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];

/** For a comma-grouped whole-number term that's a round multiple of 100 in the 1,100-9,900
 * range (e.g. "1,700"), returns the fully expanded word form ("one thousand seven hundred") as
 * an extra alias for the display term, beyond whatever compact form the guide itself asks the
 * model to speak (e.g. "seventeen hundred"). Returns null for any other term. Defense in depth:
 * captions still land right if the model ever speaks the number the older, fully-expanded way. */
export function expandedNumberWordForm(term) {
  const digits = term.replace(/,/g, '').replace(/\+$/, '');
  if (!/^\d+$/.test(digits)) return null;
  const value = parseInt(digits, 10);
  if (value < 1100 || value >= 10000 || value % 100 !== 0) return null;
  const thousands = Math.floor(value / 1000);
  const hundredsDigit = Math.floor((value % 1000) / 100);
  const words = [`${ONES[thousands]} thousand`];
  if (hundredsDigit) words.push(`${ONES[hundredsDigit]} hundred`);
  return words.join(' ');
}

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
  for (const term of new Set(Object.values(map))) {
    const expanded = expandedNumberWordForm(term);
    if (expanded && !(expanded in map)) map[expanded] = term;
  }
  return map;
}
