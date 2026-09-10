#!/usr/bin/env node
/**
 * Syncs the agent's displayName, adminTags, and maxConversationLength to
 * match this project's own content.mjs. agents.update rejects `intellect`
 * outright, so this command never includes it.
 *
 * Usage: node engine/update-agent.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedTags = (t) => [...(t || [])].sort();

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
  const agentId = state.steps.agentId?.value;
  if (!agentId) fail(flags, EXIT.UNEXPECTED, 'No agentId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);
  const before = await mgmt.agents.get(agentId, ks);

  const desired = {
    displayName: content.AGENT_DISPLAY_NAME,
    adminTags: ['deck-presenter-agent-builder', project.slug],
    maxConversationLength: content.MAX_CONVERSATION_LENGTH,
  };

  const diffs = {};
  if (before.displayName !== desired.displayName) diffs.displayName = desired.displayName;
  if (!eq(sortedTags(before.adminTags), sortedTags(desired.adminTags))) diffs.adminTags = desired.adminTags;
  if (before.maxConversationLength !== desired.maxConversationLength) diffs.maxConversationLength = desired.maxConversationLength;

  if (!Object.keys(diffs).length) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, agentId });
    return;
  }

  const planLines = [`Update agent for project "${state.slug}" (agentId ${agentId}):`];
  for (const [k, v] of Object.entries(diffs)) planLines.push(`  ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(v)}`);
  await confirmPlan(flags, planLines);

  await mgmt.agents.update({ agentId, ...diffs }, ks);

  const after = await mgmt.agents.get(agentId, ks);
  const errors = [];
  for (const [k, v] of Object.entries(diffs)) {
    const actual = k === 'adminTags' ? sortedTags(after.adminTags) : after[k];
    const expected = k === 'adminTags' ? sortedTags(v) : v;
    if (!eq(actual, expected)) errors.push(`${k} did not apply`);
  }
  if (!eq(after.avatarIds || [], before.avatarIds || [])) errors.push('avatarIds changed unexpectedly');
  if (!eq(after.intellect || {}, before.intellect || {})) errors.push('intellect binding changed unexpectedly');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, agentId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified: agent fields updated, avatar/intellect binding untouched.');
  result(flags, { ok: true, agentId });
}

runMain(main);
