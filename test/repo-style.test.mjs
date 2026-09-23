import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const EM_DASH = '\u2014';
// Recorded agent replies and timing runs are kept verbatim as evidence.
const RECORDED_OUTPUT = /(^|\/)docs\/(eval-runs|timing-runs)\//;
const BINARY = /\.(pptx|pdf|png|jpe?g|gif|ico|woff2?|zip)$/i;

test('no tracked file contains an em dash', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !RECORDED_OUTPUT.test(f) && !BINARY.test(f) && existsSync(f));
  const offenders = files.filter((f) => readFileSync(f, 'utf8').includes(EM_DASH));
  assert.deepEqual(offenders, [], `Replace the em dashes with a period, comma, or "and"/"but".`);
});
