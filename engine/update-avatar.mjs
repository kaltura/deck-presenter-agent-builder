#!/usr/bin/env node
/**
 * Syncs the avatar's voice/visual to match project.json avatar.templateName
 * if set, and its voice speed to project.json avatar.voiceSpeed if set
 * (0.7-1.2; the runtime clamps to that band regardless). Leave voiceSpeed
 * null to never touch it. Also clears the avatar's legacy openingPhrase
 * field (the opening line now lives on the intellect's own opening_phrase,
 * owned by update-prompts.mjs; the SDK's own guidance is to leave the
 * avatar-level field unset). motionControl is not yet driven by any
 * project.json field, so this command never touches it.
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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

  const desiredSpeed = project.avatar?.voiceSpeed;
  if (desiredSpeed != null && (desiredSpeed < 0.7 || desiredSpeed > 1.2)) {
    fail(flags, EXIT.USAGE, `avatar.voiceSpeed must be between 0.7 and 1.2, got ${desiredSpeed}`);
  }

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const avatarId = state.steps.avatarId?.value;
  if (!avatarId) fail(flags, EXIT.UNEXPECTED, 'No avatarId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);
  const before = await mgmt.avatars.get(avatarId, ks);

  const desiredOpening = null;

  const templateName = project.avatar?.templateName;
  let desiredVoiceId = before.voice?.id;
  let desiredVisualId = before.visual?.id;
  if (templateName) {
    const templates = [];
    for await (const t of mgmt.avatars.listTemplates(ks)) templates.push(t);
    const template = templates.find((t) => t.name === templateName && t?.voice?.id && t?.face?.id);
    if (!template) throw new Error(`avatar.templateName is "${templateName}" but no such avatar template exists.`);
    desiredVoiceId = template.voice.id;
    desiredVisualId = template.face.id;
  }

  const openingUpToDate = before.openingPhrase == null;
  const voiceUpToDate = before.voice?.id === desiredVoiceId;
  const visualUpToDate = before.visual?.id === desiredVisualId;
  const speedUpToDate = desiredSpeed == null || before.voice?.speed === desiredSpeed;
  if (openingUpToDate && voiceUpToDate && visualUpToDate && speedUpToDate) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, avatarId });
    return;
  }

  const personaLint = lintPersonaIdentity({
    name: project.personaName,
    baseDirective: content.BASE_DIRECTIVE,
    prompts: content.PROMPTS,
  });
  for (const f of personaLint.findings) progress(flags, `[persona lint] ${f.severity}: ${f.message}`);

  const planLines = [`Update avatar for project "${state.slug}" (avatarId ${avatarId}):`];
  if (!openingUpToDate) planLines.push(`  openingPhrase (legacy): ${JSON.stringify(before.openingPhrase)} -> null (the opening now lives on the intellect)`);
  if (!voiceUpToDate) planLines.push(`  voice: ${before.voice?.id} -> ${desiredVoiceId} (template "${templateName}")`);
  if (!visualUpToDate) planLines.push(`  visual: ${before.visual?.id} -> ${desiredVisualId} (template "${templateName}")`);
  if (!speedUpToDate) planLines.push(`  voice.speed: ${before.voice?.speed} -> ${desiredSpeed}`);
  await confirmPlan(flags, planLines);

  const body = { id: avatarId, openingPhrase: desiredOpening };
  if (!voiceUpToDate || !speedUpToDate) {
    body.voice = { id: desiredVoiceId };
    const speedToSend = desiredSpeed != null ? desiredSpeed : before.voice?.speed;
    if (speedToSend != null) body.voice.speed = speedToSend;
  }
  if (!visualUpToDate) body.visual = { id: desiredVisualId };
  await mgmt.avatars.update(body, ks);

  const after = await mgmt.avatars.get(avatarId, ks);
  const expectedSpeed = desiredSpeed != null ? desiredSpeed : before.voice?.speed;
  const errors = [];
  if (after.openingPhrase != null) errors.push('legacy openingPhrase did not clear');
  if (after.voice?.id !== desiredVoiceId) errors.push('voice did not apply as expected');
  if (after.visual?.id !== desiredVisualId) errors.push('visual did not apply as expected');
  if (expectedSpeed != null && after.voice?.speed !== expectedSpeed) errors.push('voice.speed did not apply as expected');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, avatarId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified.');
  result(flags, { ok: true, avatarId });
}

runMain(main);
