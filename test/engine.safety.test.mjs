import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// Runs against a copy of fixtures/smoke-project inside this repo (the "*.tmp-*"
// gitignore rule): content.mjs resolves the @kaltura/intelligent-agents bare
// specifier by walking up to this repo's own node_modules. A copy, not the shared
// fixture, because other suites cpSync that fixture concurrently, and a .env or
// state file removed mid-copy makes their copy throw ENOENT.
const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'fixtures/smoke-project');
const PROJECT = mkdtempSync(resolve(ROOT, 'safety-test.tmp-'));
const ENV_PATH = resolve(PROJECT, '.env');
const STATE_PATH = resolve(PROJECT, '.provisioning-state.json');

// Fake, obviously-synthetic ids for this fixture project only. Never a real account.
const FIXTURE_PARTNER_ID = ['1', '2', '3', '4', '5', '6'].join('');
const OTHER_PARTNER_ID = ['9', '9', '9', '9', '9', '9'].join('');
const AMBIENT_PARTNER_ID = ['5', '5', '5', '5', '5', '5'].join('');

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

before(() => {
  cpSync(FIXTURE, PROJECT, { recursive: true });
  rmSync(STATE_PATH, { force: true });
  writeFileSync(ENV_PATH, `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);
});

after(() => {
  rmSync(PROJECT, { recursive: true, force: true });
});

test('provision --dry-run prints the full plan and makes no mutating call', () => {
  const { code, stderr } = run('engine/provision.mjs', ['--project', PROJECT, '--dry-run']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /navigation tool "smoke_project_navigate_to_slide"/);
  assert.match(stderr, /Dry run: no network mutation performed\./);
  assert.equal(existsSync(STATE_PATH), false);
});

test('provision refuses to prompt on a non-interactive stream without --yes', () => {
  const { code, stderr } = run('engine/provision.mjs', ['--project', PROJECT]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /Refusing to prompt on a non-interactive stream/);
});

test('provision refuses a cloned avatar before the plan when a consent record is missing', () => {
  const dir = mkdtempSync(resolve(ROOT, 'consent-test.tmp-'));
  cpSync(FIXTURE, dir, { recursive: true });
  rmSync(resolve(dir, '.provisioning-state.json'), { force: true });
  const project = JSON.parse(readFileSync(resolve(dir, 'project.json'), 'utf8'));
  project.avatar = { source: 'cloned', cloneFromAvatarId: 'fixture-avatar' };
  writeFileSync(resolve(dir, 'project.json'), JSON.stringify(project));
  writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);
  mkdirSync(resolve(dir, 'consent'), { recursive: true });
  writeFileSync(resolve(dir, 'consent/voice-fixture-avatar.md'), 'fictional consent record\n');

  const refused = run('engine/provision.mjs', ['--project', dir, '--dry-run']);
  assert.equal(refused.code, 4, refused.stderr);
  assert.match(refused.stderr, /Missing: consent\/visual-fixture-avatar\.md\. Refusing to clone without them\./);
  assert.doesNotMatch(refused.stderr, /Provision plan/);

  writeFileSync(resolve(dir, 'consent/visual-fixture-avatar.md'), 'fictional consent record\n');
  const allowed = run('engine/provision.mjs', ['--project', dir, '--dry-run']);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stderr, /avatar \(source: cloned\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('teardown is a hard error when no state file exists', () => {
  rmSync(STATE_PATH, { force: true });
  const { code, stderr } = run('engine/teardown.mjs', ['--project', PROJECT, '--dry-run']);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /a missing state file is a hard error, not an empty success/);
});

test('teardown aborts before any delete call when partnerId does not match .env', () => {
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ partnerId: OTHER_PARTNER_ID, slug: 'smoke-project', steps: { navToolId: { value: 111, origin: 'created' } } }),
  );
  const { code, stderr } = run('engine/teardown.mjs', ['--project', PROJECT, '--dry-run']);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /Refusing to delete anything/);
  rmSync(STATE_PATH, { force: true });
});

test('teardown skips an adopted-origin id and only plans to delete created ones', () => {
  writeFileSync(
    STATE_PATH,
    JSON.stringify({
      partnerId: FIXTURE_PARTNER_ID,
      slug: 'smoke-project',
      steps: {
        navToolId: { value: 111, origin: 'created' },
        avatarId: { value: 222, origin: 'adopted' },
      },
    }),
  );
  const { code, stderr } = run('engine/teardown.mjs', ['--project', PROJECT, '--dry-run']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /delete navToolId = 111/);
  assert.match(stderr, /skip avatarId = 222 \(origin: adopted, not this project's to delete\)/);
  rmSync(STATE_PATH, { force: true });
});

test('update-followup skips with no network call when features.followUpEmail is off', () => {
  const { code, stderr, stdout } = run('engine/update-followup.mjs', ['--project', PROJECT, '--json']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /followUpEmail is off/);
  assert.match(stdout, /"skipped": true/);
});

test('update-followup refuses when followUpEmail is on but recipients is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'followup-test-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const project = JSON.parse(readFileSync(resolve(dir, 'project.json'), 'utf8'));
  project.features.followUpEmail = true;
  writeFileSync(resolve(dir, 'project.json'), JSON.stringify(project));
  writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);

  const { code, stderr } = run('engine/update-followup.mjs', ['--project', dir]);
  assert.equal(code, 4, stderr);
  assert.match(stderr, /followUpEmail\.recipients is empty/);
  rmSync(dir, { recursive: true, force: true });
});

test('update-feedback skips with no network call when features.feedback is off', () => {
  const { code, stderr, stdout } = run('engine/update-feedback.mjs', ['--project', PROJECT, '--json']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /feedback is off/);
  assert.match(stdout, /"skipped": true/);
});

test('update-feedback refuses when feedback is on but recipients is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-test-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const project = JSON.parse(readFileSync(resolve(dir, 'project.json'), 'utf8'));
  project.features.feedback = true;
  writeFileSync(resolve(dir, 'project.json'), JSON.stringify(project));
  writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);

  const { code, stderr } = run('engine/update-feedback.mjs', ['--project', dir]);
  assert.equal(code, 4, stderr);
  assert.match(stderr, /feedback\.recipients is empty/);
  rmSync(dir, { recursive: true, force: true });
});

test("a project's own .env wins over an ambient KALTURA_PARTNER_ID in the shell", () => {
  const { code, stderr } = run('engine/provision.mjs', ['--project', PROJECT, '--dry-run'], {
    KALTURA_PARTNER_ID: AMBIENT_PARTNER_ID,
    KALTURA_ADMIN_SECRET: 'ambient-fake-secret',
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`partner ${FIXTURE_PARTNER_ID}`));
  assert.doesNotMatch(stderr, new RegExp(`partner ${AMBIENT_PARTNER_ID}`));
});
