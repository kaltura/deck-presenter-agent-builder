#!/usr/bin/env node
/**
 * Keep hand-copied generic files in sync with their canonical source.
 *
 * content.mjs and client/prompt-format.js each resolve paths relative to
 * their own directory (import.meta.url, or the client bundle), so every
 * self-contained project directory needs its own physical copy: they can't
 * be replaced by a single shared import. Canonical source is
 * templates/project/content.mjs (the scaffold every new project starts
 * from) and client/prompt-format.js (the real generic app).
 *
 * Run with no flag to fix drift. Run with --check to only report it (used
 * by test/vendored-files.test.mjs and CI).
 *
 * Exit codes: 0 in sync or fixed, 1 unexpected error, 4 drift found in --check mode.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VENDORED_FILES = [
  {
    source: 'templates/project/content.mjs',
    copies: ['demo/content.mjs', 'fixtures/smoke-project/content.mjs'],
  },
  {
    source: 'client/prompt-format.js',
    copies: ['demo/client/prompt-format.js', 'fixtures/smoke-project/client/prompt-format.js'],
  },
];

/** Pure, so it's directly testable: which copies differ from their canonical source. */
export function findDrift(root = ROOT) {
  const drift = [];
  for (const { source, copies } of VENDORED_FILES) {
    const canonical = readFileSync(resolve(root, source), 'utf8');
    for (const copy of copies) {
      if (readFileSync(resolve(root, copy), 'utf8') !== canonical) drift.push({ source, copy });
    }
  }
  return drift;
}

function main() {
  const check = process.argv.includes('--check');
  const drift = findDrift();

  if (check) {
    if (drift.length === 0) {
      console.log(`sync-vendored: ${VENDORED_FILES.length} source(s) in sync.`);
      process.exit(0);
    }
    console.error(`sync-vendored: ${drift.length} file(s) out of sync with their canonical source.\n`);
    for (const { source, copy } of drift) console.error(`  ${copy} !== ${source}`);
    console.error('\nRun `npm run sync-vendored` to fix.');
    process.exit(4);
  }

  for (const { source, copy } of drift) {
    writeFileSync(resolve(ROOT, copy), readFileSync(resolve(ROOT, source), 'utf8'));
    console.log(`sync-vendored: updated ${copy} from ${source}`);
  }
  if (drift.length === 0) console.log(`sync-vendored: ${VENDORED_FILES.length} source(s) already in sync.`);
  process.exit(0);
}

// Run only when invoked directly, so tests can import VENDORED_FILES/findDrift.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`sync-vendored: ${err.message}`);
    process.exit(1);
  }
}
