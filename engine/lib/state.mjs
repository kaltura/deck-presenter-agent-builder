import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const STATE_FILE = '.provisioning-state.json';

export function statePath(projectRoot) {
  return resolve(projectRoot, STATE_FILE);
}

export function loadState(projectRoot) {
  const p = statePath(projectRoot);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function newState(partnerId, slug) {
  const now = new Date().toISOString();
  return { partnerId: String(partnerId), slug, createdAt: now, updatedAt: now, steps: {} };
}

/** Atomic write: temp file then rename, so a kill mid-write never corrupts state. */
export function writeState(projectRoot, state) {
  state.updatedAt = new Date().toISOString();
  const p = statePath(projectRoot);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

/** Record one provisioned id the instant it is known, so a kill mid-run is resumable. */
export function recordStep(projectRoot, state, key, value) {
  state.steps[key] = value;
  writeState(projectRoot, state);
  return state;
}

/**
 * Every provisioning and teardown entry point must call this before any
 * network mutation. A mismatch means the state file belongs to a different
 * Kaltura account than the one .env now points at, so ownership cannot be
 * trusted; refuse rather than guess.
 */
export function assertPartnerMatch(state, partnerId) {
  if (state && String(state.partnerId) !== String(partnerId)) {
    throw new Error(
      `.provisioning-state.json was written for partner ${state.partnerId}, but .env now points at partner ${partnerId}. Refusing to proceed.`,
    );
  }
}

/** Ids this project created, in creation order. Only these are ever deleted by teardown. */
export function createdSteps(state) {
  return Object.entries(state.steps).filter(([, v]) => v && v.origin === 'created');
}
