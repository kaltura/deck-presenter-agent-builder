import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// Runs directly against fixtures/smoke-project (not a copy elsewhere): content.mjs
// resolves the @kaltura/intelligent-agents bare specifier by walking up from the
// project directory to this repo's own node_modules, same as a real `npm run scan`
// / doctor invocation does. .env and .provisioning-state.json are gitignored, so
// writing them here for the run and removing them after leaves no tracked diff.
const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'fixtures/smoke-project');
const ENV_PATH = resolve(FIXTURE, '.env');
const STATE_PATH = resolve(FIXTURE, '.provisioning-state.json');

// Fake, obviously-synthetic ids for this fixture project only — never a real account.
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
  writeFileSync(ENV_PATH, `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);
});

after(() => {
  rmSync(ENV_PATH, { force: true });
  rmSync(STATE_PATH, { force: true });
});

test('provision --dry-run prints the full plan and makes no mutating call', () => {
  const { code, stderr } = run('engine/provision.mjs', ['--project', FIXTURE, '--dry-run']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /navigation tool "smoke_project_navigate_to_slide"/);
  assert.match(stderr, /Dry run: no network mutation performed\./);
  assert.equal(existsSync(STATE_PATH), false);
});

test('provision refuses to prompt on a non-interactive stream without --yes', () => {
  const { code, stderr } = run('engine/provision.mjs', ['--project', FIXTURE]);
  assert.equal(code, 2, stderr);
  assert.match(stderr, /Refusing to prompt on a non-interactive stream/);
});

test('teardown is a hard error when no state file exists', () => {
  rmSync(STATE_PATH, { force: true });
  const { code, stderr } = run('engine/teardown.mjs', ['--project', FIXTURE, '--dry-run']);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /a missing state file is a hard error, not an empty success/);
});

test('teardown aborts before any delete call when partnerId does not match .env', () => {
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ partnerId: OTHER_PARTNER_ID, slug: 'smoke-project', steps: { navToolId: { value: 111, origin: 'created' } } }),
  );
  const { code, stderr } = run('engine/teardown.mjs', ['--project', FIXTURE, '--dry-run']);
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
  const { code, stderr } = run('engine/teardown.mjs', ['--project', FIXTURE, '--dry-run']);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /delete navToolId = 111/);
  assert.match(stderr, /skip avatarId = 222 \(origin: adopted, not this project's to delete\)/);
  rmSync(STATE_PATH, { force: true });
});

test('update-followup skips with no network call when features.followUpEmail is off', () => {
  const { code, stderr, stdout } = run('engine/update-followup.mjs', ['--project', FIXTURE, '--json']);
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

test('update-followup refuses when KALTURA_MESSAGING_URL is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'followup-test-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const project = JSON.parse(readFileSync(resolve(dir, 'project.json'), 'utf8'));
  project.features.followUpEmail = true;
  project.followUpEmail = { recipients: ['test@example.com'], emailProviderId: 'fake-provider-id' };
  writeFileSync(resolve(dir, 'project.json'), JSON.stringify(project));
  writeFileSync(resolve(dir, '.env'), `KALTURA_PARTNER_ID=${FIXTURE_PARTNER_ID}\nKALTURA_ADMIN_SECRET=fake-secret-for-dry-run-only\n`);

  const { code, stderr } = run('engine/update-followup.mjs', ['--project', dir]);
  assert.equal(code, 3, stderr);
  assert.match(stderr, /KALTURA_MESSAGING_URL is not set/);
  rmSync(dir, { recursive: true, force: true });
});

test("a project's own .env wins over an ambient KALTURA_PARTNER_ID in the shell", () => {
  const { code, stderr } = run('engine/provision.mjs', ['--project', FIXTURE, '--dry-run'], {
    KALTURA_PARTNER_ID: AMBIENT_PARTNER_ID,
    KALTURA_ADMIN_SECRET: 'ambient-fake-secret',
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`partner ${FIXTURE_PARTNER_ID}`));
  assert.doesNotMatch(stderr, new RegExp(`partner ${AMBIENT_PARTNER_ID}`));
});
