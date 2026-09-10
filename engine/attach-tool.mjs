#!/usr/bin/env node
/**
 * Syncs every client tool this project's content.mjs declares (navigation,
 * plus contact/end-session when their feature flag is on) and reconciles
 * the intellect's tool_ids to match. One generic command for every tool,
 * not one per tool: a tool with no recorded id is created, a tool that
 * already has one is a config-only update via tools.update. Never calls
 * tools.add for a tool this project has already recorded.
 *
 * Usage: node engine/attach-tool.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { client as buildClientTool } from '@kaltura/intelligent-agents/management';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, recordStep, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';
import { assertNamedResourceFree } from './lib/tool-guard.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TOOL_SLOTS = [
  { stateKey: 'navToolId', contentKey: 'NAV_TOOL', enabled: () => true },
  { stateKey: 'contactToolId', contentKey: 'CONTACT_TOOL', enabled: (f) => !!f.contactForm },
  { stateKey: 'endSessionToolId', contentKey: 'END_SESSION_TOOL', enabled: (f) => !!f.endSessionTool },
];

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  const features = project.features || {};

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const configId = state.steps.configId?.value;
  if (!configId) fail(flags, EXIT.UNEXPECTED, 'No configId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);
  const beforeIntellect = await mgmt.intellects.get(configId, ks);

  // ── Plan: which tool bodies need creating/updating ──
  const slots = [];
  for (const slot of TOOL_SLOTS) {
    if (!slot.enabled(features)) continue;
    const toolSpec = content[slot.contentKey];
    if (!toolSpec) continue;
    const desired = buildClientTool(toolSpec);
    const existingId = state.steps[slot.stateKey]?.value || null;

    if (!existingId) {
      await assertNamedResourceFree(mgmt.tools.list(ks), desired.name, null);
      slots.push({ ...slot, desired, existingId: null, action: 'create' });
    } else {
      const current = await mgmt.tools.get(existingId, ks);
      const unchanged = current.name === desired.name && eq(current.config, desired);
      slots.push({ ...slot, desired, existingId, current, action: unchanged ? 'unchanged' : 'update' });
    }
  }

  const desiredToolIds = slots.map((s) => s.existingId).filter(Boolean).map(String);
  // Slots still awaiting creation contribute their id only after the write below;
  // for the up-front diff we compare against what's knowable now.
  const pendingCreates = slots.filter((s) => s.action === 'create').length;
  const toolIdsAlreadyOk = pendingCreates === 0
    && eq((beforeIntellect.tool_ids || []).map(String), desiredToolIds);

  if (slots.every((s) => s.action === 'unchanged') && toolIdsAlreadyOk) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, configId });
    return;
  }

  const planLines = [`Sync tools for project "${state.slug}" (configId ${configId}):`];
  for (const s of slots) {
    if (s.action === 'create') planLines.push(`  ${s.stateKey}: create "${s.desired.name}"`);
    else if (s.action === 'update') planLines.push(`  ${s.stateKey}: update "${s.desired.name}" (config changed)`);
    else planLines.push(`  ${s.stateKey}: "${s.desired.name}" unchanged`);
  }
  planLines.push(toolIdsAlreadyOk ? '  tool_ids: unchanged' : '  tool_ids: will be reconciled after tool sync');
  await confirmPlan(flags, planLines);

  // ── Execute: create/update each tool body, recording state as each lands ──
  for (const s of slots) {
    if (s.action === 'create') {
      progress(flags, `[${s.stateKey}] creating "${s.desired.name}"...`);
      const rec = await mgmt.tools.add(s.desired, ks);
      s.finalId = rec.id;
      recordStep(projectRoot, state, s.stateKey, { value: rec.id, origin: 'created' });
    } else if (s.action === 'update') {
      progress(flags, `[${s.stateKey}] updating "${s.desired.name}"...`);
      await mgmt.tools.update(s.existingId, { name: s.desired.name, config: s.desired }, ks);
      s.finalId = s.existingId;
    } else {
      s.finalId = s.existingId;
    }
  }

  // ── Reconcile tool_ids on the intellect ──
  const finalToolIds = slots.map((s) => String(s.finalId));
  const toolIdsChanged = !eq((beforeIntellect.tool_ids || []).map(String), finalToolIds);
  if (toolIdsChanged) {
    progress(flags, `[tool_ids] setting ${JSON.stringify(finalToolIds)}...`);
    await mgmt.intellectConfig.setToolIds(configId, finalToolIds, ks);
  }

  // ── Verify ──
  const errors = [];
  for (const s of slots) {
    const after = await mgmt.tools.get(s.finalId, ks);
    if (after.name !== s.desired.name || !eq(after.config, s.desired)) errors.push(`${s.stateKey} body did not apply`);
  }
  const afterIntellect = await mgmt.intellects.get(configId, ks);
  if (!eq((afterIntellect.tool_ids || []).map(String), finalToolIds)) errors.push('tool_ids did not apply');
  if (afterIntellect.base_directive !== beforeIntellect.base_directive) errors.push('base_directive changed unexpectedly');
  if (!eq(afterIntellect.prompts || [], beforeIntellect.prompts || [])) errors.push('prompts changed unexpectedly');
  if (!eq(afterIntellect.glossary || null, beforeIntellect.glossary || null)) errors.push('glossary changed unexpectedly');
  if (!eq(afterIntellect.capabilities || {}, beforeIntellect.capabilities || {})) errors.push('capabilities changed unexpectedly');
  if (!eq(afterIntellect.knowledge_ids || [], beforeIntellect.knowledge_ids || [])) errors.push('knowledge_ids changed unexpectedly');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, configId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified: tool bodies and tool_ids updated, everything else untouched.');
  result(flags, { ok: true, configId, toolIds: finalToolIds });
}

runMain(main);
