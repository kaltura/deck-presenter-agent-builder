import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBundleWarnings } from '../engine/bundle.mjs';
import { scanForEnvLeaks } from '../engine/lib/env-leak-scan.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'fixtures/smoke-project');

// ── checkBundleWarnings: pure, exported for direct unit testing ──

function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (msg) => lines.push(msg);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

test('checkBundleWarnings warns on empty disclosure.text and privacy fields, never throws', () => {
  const out = captureStderr(() => checkBundleWarnings({}));
  assert.match(out, /warning \(disclosure\): project\.json disclosure\.text is empty/);
  assert.match(out, /warning \(privacyContact\): project\.json privacy\.controllerName or privacy\.controllerContact is empty/);
});

test('checkBundleWarnings prints an acknowledged note instead of a warning when overrides.acknowledgeWarnings names the check', () => {
  const out = captureStderr(() =>
    checkBundleWarnings({ overrides: { acknowledgeWarnings: ['disclosure'] } }),
  );
  assert.match(out, /"disclosure" warning acknowledged in project\.json overrides\.acknowledgeWarnings\. Proceeding\./);
  assert.doesNotMatch(out, /warning \(disclosure\)/);
  assert.match(out, /warning \(privacyContact\)/);
});

test('checkBundleWarnings warns when avatar.source is cloned', () => {
  const out = captureStderr(() => checkBundleWarnings({ avatar: { source: 'cloned' } }));
  assert.match(out, /warning \(syntheticLabel\): avatar\.source is "cloned"/);
});

test('checkBundleWarnings does not warn on syntheticLabel when avatar.source is not cloned', () => {
  const out = captureStderr(() => checkBundleWarnings({ avatar: { source: 'fresh' } }));
  assert.doesNotMatch(out, /syntheticLabel/);
});

test('checkBundleWarnings warns when welcome copy states a duration longer than sessionMaxSeconds', () => {
  const out = captureStderr(() =>
    checkBundleWarnings({ sessionMaxSeconds: 300, disclosure: { text: 'This session runs about 10 minutes.' } }),
  );
  assert.match(out, /warning \(sessionDuration\): Welcome copy states a duration \("10 minutes"\) longer than sessionMaxSeconds \(300s\)/);
});

test('checkBundleWarnings does not warn on sessionDuration when the stated duration fits', () => {
  const out = captureStderr(() =>
    checkBundleWarnings({ sessionMaxSeconds: 900, disclosure: { text: 'This session runs about 10 minutes.' } }),
  );
  assert.doesNotMatch(out, /sessionDuration/);
});

test('checkBundleWarnings warns and ignores unrecognized syntheticLabelPlacement values', () => {
  const out = captureStderr(() =>
    checkBundleWarnings({ avatar: { source: 'fresh', syntheticLabelPlacement: ['openingPhrase'] } }),
  );
  assert.match(out, /avatar\.syntheticLabelPlacement has unrecognized value\(s\): openingPhrase/);
});

// ── scanForEnvLeaks: pure, already exported ──

test('scanForEnvLeaks returns the key of a value found in the text, never the value itself', () => {
  const leaked = scanForEnvLeaks('<script>const x = "sk-supersecrettoken123";</script>', {
    KALTURA_ADMIN_SECRET: 'sk-supersecrettoken123',
  });
  assert.deepEqual(leaked, ['KALTURA_ADMIN_SECRET']);
});

test('scanForEnvLeaks excludes keys named in excludeKeys', () => {
  const leaked = scanForEnvLeaks('<script>const w = "widget-abc123";</script>', { KALTURA_WIDGET_ID: 'widget-abc123' }, {
    excludeKeys: ['KALTURA_WIDGET_ID'],
  });
  assert.deepEqual(leaked, []);
});

test('scanForEnvLeaks ignores values shorter than minLength', () => {
  const leaked = scanForEnvLeaks('<script>const n = "abc12";</script>', { SHORT_VAL: 'abc12' });
  assert.deepEqual(leaked, []);
});

test('scanForEnvLeaks reports no leak when no value appears in the text', () => {
  const leaked = scanForEnvLeaks('<script>const x = 1;</script>', { KALTURA_ADMIN_SECRET: 'sk-supersecrettoken123' });
  assert.deepEqual(leaked, []);
});

// ── CLI-level: node engine/bundle.mjs against a temp copy of fixtures/smoke-project ──
// Nested under ROOT, not os.tmpdir(): loadContent() dynamically imports the
// project's own content.mjs, whose bare "@kaltura/..." import resolves by
// walking up from the project directory to find node_modules.
//
// test/engine.safety.test.mjs writes .env/.provisioning-state.json directly
// into this same FIXTURE path for the duration of its run, and node --test
// runs test files concurrently. Strip any such file this cpSync happens to
// pick up mid-race, so a "clean copy" here is never contaminated.
function tempProject() {
  const dir = mkdtempSync(resolve(ROOT, 'bundle-test.tmp-'));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const f of ['.env', '.provisioning-state.json']) {
    if (existsSync(resolve(dir, f))) rmSync(resolve(dir, f));
  }
  return dir;
}

function setProjectField(dir, field, value) {
  const path = resolve(dir, 'project.json');
  const project = JSON.parse(readFileSync(path, 'utf8'));
  project[field] = value;
  writeFileSync(path, JSON.stringify(project));
}

function runBundle(dir) {
  const r = spawnSync('node', [resolve(ROOT, 'engine/bundle.mjs'), '--project', dir], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('bundle.mjs on the unmodified fixture warns on disclosure and privacyContact, still writes dist.html', () => {
  const dir = tempProject();
  try {
    const { code, stderr } = runBundle(dir);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /warning \(disclosure\)/);
    assert.match(stderr, /warning \(privacyContact\)/);
    const html = readFileSync(resolve(dir, 'dist.html'), 'utf8');
    assert.match(html, /SLIDE_DATA/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle.mjs prints the acknowledged note instead of the warning when overrides.acknowledgeWarnings is set', () => {
  const dir = tempProject();
  try {
    setProjectField(dir, 'overrides', { acknowledgeWarnings: ['disclosure', 'privacyContact'] });
    const { code, stderr } = runBundle(dir);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /"disclosure" warning acknowledged/);
    assert.match(stderr, /"privacyContact" warning acknowledged/);
    assert.doesNotMatch(stderr, /warning \(disclosure\)/);
    assert.doesNotMatch(stderr, /warning \(privacyContact\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle.mjs refuses with EXIT.VALIDATION when a .env value would leak into dist.html, even with overrides set', () => {
  const dir = tempProject();
  try {
    const leakedSecret = 'leak-canary-9f8e7d6c5b4a';
    writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=123456\nKALTURA_ADMIN_SECRET=${leakedSecret}\n`);
    setProjectField(dir, 'disclosure', { text: `Disclosure copy that accidentally includes ${leakedSecret}.` });
    setProjectField(dir, 'overrides', { acknowledgeWarnings: ['disclosure', 'privacyContact', 'syntheticLabel', 'sessionDuration'] });
    const { code, stderr } = runBundle(dir);
    assert.equal(code, 4, stderr);
    assert.match(stderr, /Bundle would leak \.env value\(s\) into dist\.html/);
    assert.match(stderr, /KALTURA_ADMIN_SECRET/);
    assert.doesNotMatch(stderr, new RegExp(leakedSecret));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
