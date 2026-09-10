#!/usr/bin/env node
/**
 * Syncs the intellect's capabilities dict and allow_client_variables to
 * match this project's own content.mjs. setCapabilities has a
 * disabled-to-on veto guard: pass --force to override it.
 *
 * Usage: node engine/update-capabilities.mjs --project <path> [--dry-run] [--yes] [--force] [--json]
 */
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);
  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const configId = state.steps.configId?.value;
  if (!configId) fail(flags, EXIT.UNEXPECTED, 'No configId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);
  const before = await mgmt.intellects.get(configId, ks);

  const desired = content.CAPABILITIES;
  const diffs = Object.entries(desired).filter(([k, v]) => (before.capabilities || {})[k] !== v);
  const clientVarsSame = before.allow_client_variables === true;

  if (!diffs.length && clientVarsSame) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, configId });
    return;
  }

  const planLines = [`Update capabilities for project "${state.slug}" (configId ${configId}):`];
  for (const [k, v] of diffs) planLines.push(`  ${k}: ${JSON.stringify((before.capabilities || {})[k] ?? null)} -> ${JSON.stringify(v)}`);
  if (!clientVarsSame) planLines.push(`  allow_client_variables: ${before.allow_client_variables} -> true`);
  await confirmPlan(flags, planLines);

  if (diffs.length) {
    try {
      await mgmt.intellects.setCapabilities(configId, desired, ks, { force: !!flags.force });
    } catch (err) {
      if (err?.code === 'capability_vetoed' && !flags.force) {
        fail(flags, EXIT.VALIDATION, `${err.detail || err.message}. Pass --force to re-enable a disabled capability.`);
      }
      throw err;
    }
  }
  if (!clientVarsSame) await mgmt.intellects.setClientVariablesEnabled(configId, true, ks);

  const after = await mgmt.intellects.get(configId, ks);
  const errors = [];
  for (const [k, v] of Object.entries(desired)) {
    if ((after.capabilities || {})[k] !== v) errors.push(`capabilities.${k} did not apply`);
  }
  if (after.allow_client_variables !== true) errors.push('allow_client_variables did not apply');
  if (after.base_directive !== before.base_directive) errors.push('base_directive changed unexpectedly');
  if (!eq(after.prompts || [], before.prompts || [])) errors.push('prompts changed unexpectedly');
  if (!eq((after.tool_ids || []).map(String), (before.tool_ids || []).map(String))) errors.push('tool_ids changed unexpectedly');
  if (!eq(after.knowledge_ids || [], before.knowledge_ids || [])) errors.push('knowledge_ids changed unexpectedly');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, configId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified: capabilities updated, everything else untouched.');
  result(flags, { ok: true, configId });
}

runMain(main);
