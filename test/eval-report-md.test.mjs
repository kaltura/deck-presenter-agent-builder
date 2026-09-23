import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(import.meta.dirname, '../templates/project/.github/scripts/eval-report-md.mjs');

function render(report) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(report));
  const r = spawnSync('node', [SCRIPT, path], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('an item with its own pass: true is not failed by a false diagnostic field', () => {
  const out = render({
    summary: '1/1 checks passed', timestamp: 'fixture',
    checks: [{ n: 8, name: 'pronunciation_spot_check', pass: true, detail: [{ term: 'Lumen', pass: true, saidSpokenForm: true, wroteRawTerm: false }] }],
  });
  assert.match(out, /\| 8 \| pronunciation_spot_check \| pass \| 0 \/ 1 \|/);
  assert.doesNotMatch(out, /Failed items/);
});

test('failed items list their own failure, or the false sub-checks when there is no own pass', () => {
  const out = render({
    summary: '0/2 checks passed', timestamp: 'fixture',
    checks: [
      { n: 8, name: 'pronunciation_spot_check', pass: false, detail: [{ term: 'Lumen', pass: false, saidSpokenForm: false, wroteRawTerm: true }] },
      { n: 6, name: 'held_out_questions', pass: false, detail: [{ q: 'What does Iris cost?', numeric: true, routed: false, currencySuffix: true, judge: true }] },
    ],
  });
  assert.match(out, /- \*\*pronunciation_spot_check\*\*: Lumen\n/);
  assert.match(out, /- \*\*held_out_questions\*\*: What does Iris cost\? \(failed: routed\)/);
});
