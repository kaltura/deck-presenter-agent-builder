#!/usr/bin/env node
/**
 * Re-runnable environment + credential preflight (PLAN.md 12, 13 Phase 1).
 * Checks Node version always. With --project, also loads that project's
 * .env and makes one cheap authenticated Kaltura call (mint an admin
 * session token) to confirm the account is reachable before anything else
 * runs. Never mutates anything.
 *
 * Usage: node bin/doctor.mjs [--project <path>] [--json]
 */
import { existsSync } from 'node:fs';
import { parseFlags, progress, result, EXIT, runMain } from '../engine/lib/cli.mjs';
import { loadCredentials } from '../engine/lib/env.mjs';
import { connect, adminKs } from '../engine/lib/kaltura.mjs';

const MIN_NODE_MAJOR = 22;

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { ok: true, name: 'node', detail: `Node ${process.version} (>= ${MIN_NODE_MAJOR} required)` };
  }
  return {
    ok: false,
    name: 'node',
    detail: `Node ${process.version} is too old; ${MIN_NODE_MAJOR}+ required.`,
    fix:
      process.platform === 'darwin'
        ? 'brew install node'
        : process.platform === 'win32'
          ? 'winget install OpenJS.NodeJS.LTS'
          : 'Use a Node version manager (nvm, fnm) to install Node 22+.',
  };
}

async function checkCredentials(projectRoot) {
  if (!existsSync(projectRoot)) {
    return { ok: false, name: 'credentials', detail: `No such project directory: ${projectRoot}` };
  }
  const creds = loadCredentials(projectRoot);
  if (!creds.ok) {
    return {
      ok: false,
      name: 'credentials',
      detail: `Missing credential(s): ${creds.missing.join(', ')}.`,
      fix: `Copy .env.example to .env in ${projectRoot} and fill in the missing value(s).`,
    };
  }
  return { ok: true, name: 'credentials', detail: `KALTURA_PARTNER_ID and KALTURA_ADMIN_SECRET found in ${creds.envPath}.` };
}

async function checkKalturaReachable(projectRoot, flags) {
  try {
    const { mgmt, partnerId } = connect(projectRoot, flags);
    await adminKs(mgmt);
    return { ok: true, name: 'kaltura-account', detail: `Authenticated to partner ${partnerId}.` };
  } catch (err) {
    return {
      ok: false,
      name: 'kaltura-account',
      detail: `Could not authenticate: ${err.message}`,
      fix: 'Check KALTURA_PARTNER_ID, KALTURA_ADMIN_SECRET, and KALTURA_SERVICE_URL in .env.',
    };
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const checks = [checkNode()];

  if (flags.project) {
    const projectRoot = String(flags.project);
    const credCheck = await checkCredentials(projectRoot);
    checks.push(credCheck);
    if (credCheck.ok) checks.push(await checkKalturaReachable(projectRoot, flags));
  } else {
    progress(flags, 'No --project given; skipping credential and account checks.');
  }

  for (const c of checks) {
    progress(flags, `${c.ok ? 'OK' : 'FAIL'}  ${c.name}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ''}`);
  }

  const allOk = checks.every((c) => c.ok);
  result(flags, { ok: allOk, checks });
  if (!allOk) process.exitCode = EXIT.CREDENTIAL;
}

runMain(main);
