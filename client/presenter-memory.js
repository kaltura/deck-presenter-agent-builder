// The SDK's Presenter class owns session memory in localStorage: one JSON record
// under a fixed key, shaped roughly as {timestamp, lastSlide, lastSequential}. A
// Presenter instance reloads that record on construction, but at the point where
// this app needs a resume hint (building the KalturaAvatarSession's requestVars,
// before the session or the Presenter exist), there is no Presenter yet to ask.
// So this module peeks the SAME record, read-only, with its own copy of the key
// and max-age Presenter itself uses. It never writes: Presenter still owns the
// real copy and keeps it current for the rest of the session.
export const PRESENTER_MEMORY_KEY = 'kaltura_presenter_memory';
export const PRESENTER_MEMORY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * The 1-based slide to offer resuming into, or 0 when there is nothing to
 * resume (no stored record, an expired one, or a stored slide out of range).
 * @param {{getItem:(key:string)=>string|null}|null} storage
 * @param {() => number} now clock injection, defaults to Date.now
 * @param {number} total total slide count
 * @returns {number}
 */
export function peekResumeSlide(storage, now = Date.now, total = Infinity) {
  if (!storage) return 0;
  let raw;
  try { raw = storage.getItem(PRESENTER_MEMORY_KEY); } catch { return 0; }
  if (!raw) return 0;
  let memory;
  try { memory = JSON.parse(raw); } catch { return 0; }
  if (!memory?.timestamp || now() - memory.timestamp > PRESENTER_MEMORY_MAX_AGE_MS) return 0;
  const last = typeof memory.lastSequential === 'number' ? memory.lastSequential : memory.lastSlide;
  return typeof last === 'number' && last > 1 && last < total ? last : 0;
}
