import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Guard-clause coverage for the five update-*/attach-tool scripts that have no
// tests today. None of these reach a live Kaltura mutation in this suite: every
// case here is refused before the first `adminKs()` call, so no SDK mocking is
// needed. Each test works on its own temp copy of fixtures/smoke-project (never
// the shared fixture directory itself), so this file never races with
// engine.safety.test.mjs, which runs in its own subprocess against the same
// fixture path.
const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'fixtures/smoke-project');

// Fake, obviously-synthetic ids for this fixture project only, never a real account.
const FIXTURE_PARTNER_ID = ['1', '2', '3', '4', '5', '6'].join('');
const OTHER_PARTNER_ID = ['9', '9', '9', '9', '9', '9'].join('');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.KALTURA_PARTNER_ID;
  delete env.KALTURA_ADMIN_SECRET;
  return Object.assign(env, extra);
}

function run(script, args, extraEnv) {
  const r = spawnSync('node', [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Created under ROOT, not os.tmpdir(): content.mjs's bare "@kaltura/..." import
// resolves by walking up from the project directory to find node_modules, the
// same as a real invocation. The "engine-guard-test.tmp-" prefix matches this
// repo's own "*.tmp-*" gitignore rule.
//
// test/engine.safety.test.mjs writes .env/.provisioning-state.json directly into
// this same FIXTURE path for the duration of its run (see its own file header),
// and node --test runs test files concurrently. Strip any such file this cpSync
// happens to pick up mid-race, so a "clean copy" here is never contaminated by
// another file's transient state.
function tempProject() {
  const dir = mkdtempSync(resolve(ROOT, 'engine-guard-test.tmp-'));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const f of ['.env', '.provisioning-state.json']) {
    if (existsSync(resolve(dir, f))) rmSync(resolve(dir, f));
  }
  return dir;
}

function writeEnv(dir, partnerId = FIXTURE_PARTNER_ID) {
  writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=${partnerId}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);
}

function writeState(dir, state) {
  writeFileSync(resolve(dir, '.provisioning-state.json'), JSON.stringify(state));
}

/**
 * Runs the shared guard-clause shape common to attach-tool.mjs, update-prompts.mjs,
 * update-agent.mjs, and update-capabilities.mjs: missing credentials, missing
 * state file, partner mismatch, missing required id in state. update-capabilities.mjs
 * never reads project.json directly, so checkProjectJson lets it skip that one case.
 */
function guardClauseSuite(label, script, idKey, idNoun, { checkProjectJson = true } = {}) {
  if (checkProjectJson) {
    test(`${label} refuses when project.json is missing`, () => {
      const dir = mkdtempSync(resolve(ROOT, 'engine-guard-test.tmp-'));
      try {
        const { code, stderr } = run(script, ['--project', dir]);
        assert.equal(code, 2, stderr);
        assert.match(stderr, /No project\.json at/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`${label} refuses when credentials are missing`, () => {
    const dir = tempProject();
    try {
      const { code, stderr } = run(script, ['--project', dir]);
      assert.equal(code, 3, stderr);
      assert.match(stderr, /Missing credential/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} refuses when no provisioning state exists`, () => {
    const dir = tempProject();
    writeEnv(dir);
    try {
      const { code, stderr } = run(script, ['--project', dir]);
      assert.equal(code, 1, stderr);
      assert.match(stderr, /No \.provisioning-state\.json\. Run engine\/provision\.mjs first\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} aborts on partner mismatch before reaching a live call`, () => {
    const dir = tempProject();
    writeEnv(dir, FIXTURE_PARTNER_ID);
    writeState(dir, { partnerId: OTHER_PARTNER_ID, slug: 'smoke-project', steps: {} });
    try {
      const { code, stderr } = run(script, ['--project', dir]);
      assert.equal(code, 1, stderr);
      assert.match(stderr, /Refusing to proceed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${label} refuses when no ${idKey} is recorded in state`, () => {
    const dir = tempProject();
    writeEnv(dir, FIXTURE_PARTNER_ID);
    writeState(dir, { partnerId: FIXTURE_PARTNER_ID, slug: 'smoke-project', steps: {} });
    try {
      const { code, stderr } = run(script, ['--project', dir]);
      assert.equal(code, 1, stderr);
      assert.match(stderr, new RegExp(`No ${idNoun} in \\.provisioning-state\\.json`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

guardClauseSuite('attach-tool', 'engine/attach-tool.mjs', 'configId', 'configId');
guardClauseSuite('update-prompts', 'engine/update-prompts.mjs', 'configId', 'configId');
guardClauseSuite('update-agent', 'engine/update-agent.mjs', 'agentId', 'agentId');
guardClauseSuite('update-capabilities', 'engine/update-capabilities.mjs', 'configId', 'configId', { checkProjectJson: false });
guardClauseSuite('update-avatar', 'engine/update-avatar.mjs', 'avatarId', 'avatarId');

test('update-avatar refuses an out-of-range voiceSpeed before any network call, with no .env at all', () => {
  const dir = tempProject();
  const projectPath = resolve(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  project.avatar.voiceSpeed = 1.5;
  writeFileSync(projectPath, JSON.stringify(project));
  try {
    const { code, stderr } = run('engine/update-avatar.mjs', ['--project', dir]);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /avatar\.voiceSpeed must be between 0\.7 and 1\.2, got 1\.5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
