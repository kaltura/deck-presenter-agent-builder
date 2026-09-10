#!/usr/bin/env node
/**
 * Syncs the avatar's openingPhrase to match this project's own content.mjs.
 * voice/visual/motionControl are not yet driven by any project.json field
 * (PLAN.md 5 defines none), so this command never touches them.
 *
 * Usage: node engine/update-avatar.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintPersonaIdentity } from '@kaltura/intelligent-agents/management';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const avatarId = state.steps.avatarId?.value;
  if (!avatarId) fail(flags, EXIT.UNEXPECTED, 'No avatarId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);
  const before = await mgmt.avatars.get(avatarId, ks);

  const desiredOpening = content.OPENING_PHRASE;
  if (before.openingPhrase === desiredOpening) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, avatarId });
    return;
  }

  const personaLint = lintPersonaIdentity({
    name: project.personaName,
    openingPhrase: desiredOpening,
    baseDirective: content.BASE_DIRECTIVE,
    prompts: content.PROMPTS,
  });
  for (const f of personaLint.findings) progress(flags, `[persona lint] ${f.severity}: ${f.message}`);

  const planLines = [
    `Update avatar for project "${state.slug}" (avatarId ${avatarId}):`,
    `  openingPhrase: ${JSON.stringify(before.openingPhrase)} -> ${JSON.stringify(desiredOpening)}`,
  ];
  await confirmPlan(flags, planLines);

  await mgmt.avatars.update({ id: avatarId, openingPhrase: desiredOpening }, ks);

  const after = await mgmt.avatars.get(avatarId, ks);
  const errors = [];
  if (after.openingPhrase !== desiredOpening) errors.push('openingPhrase did not apply');
  if (!eq(after.voice || {}, before.voice || {})) errors.push('voice changed unexpectedly');
  if (!eq(after.visual || {}, before.visual || {})) errors.push('visual changed unexpectedly');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, avatarId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified: openingPhrase updated, voice/visual untouched.');
  result(flags, { ok: true, avatarId });
}

runMain(main);
