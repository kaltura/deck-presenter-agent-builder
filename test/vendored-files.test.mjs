import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDrift, VENDORED_FILES } from '../bin/sync-vendored.mjs';

// content.mjs and client/prompt-format.js are hand-copied into every
// self-contained project directory (demo/, fixtures/smoke-project/) since
// each resolves paths relative to its own location. This guards against
// editing one copy and forgetting the others: a real edit to only one copy
// fails here instead of silently shipping stale logic. Fix with:
//   npm run sync-vendored

for (const { source, copies } of VENDORED_FILES) {
  test(`${source} is in sync with ${copies.join(', ')}`, () => {
    const drift = findDrift().filter((d) => d.source === source);
    assert.deepEqual(drift, [], `${drift.map((d) => d.copy).join(', ')} drifted from ${source}. Run: npm run sync-vendored`);
  });
}
