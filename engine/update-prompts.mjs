#!/usr/bin/env node
/**
 * Syncs the intellect's base_directive, glossary, and prompts[] to match
 * this project's own content.mjs. Read-compare-write-verify: no diff means
 * no network write, and the post-write read-back must show the intended
 * fields changed with tool_ids/knowledge_ids/capabilities/status untouched.
 *
 * Usage: node engine/update-prompts.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintPersonaIdentity } from '@kaltura/intelligent-agents/management';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';

// The server adds `mode: null` to prompt blocks that were never sent with one.
// Strip it before comparing, or every run reports a false diff.
const normalizePrompts = (arr) => (arr || []).map(({ mode, ...rest }) => (mode == null ? rest : { ...rest, mode }));
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
  const configId = state.steps.configId?.value;
  if (!configId) fail(flags, EXIT.UNEXPECTED, 'No configId in .provisioning-state.json. Run engine/provision.mjs first.');

  const ks = await adminKs(mgmt);
  const before = await mgmt.intellects.get(configId, ks);

  const directiveSame = before.base_directive === content.BASE_DIRECTIVE;
  const glossarySame = eq(before.glossary || null, content.GLOSSARY || null);
  const promptsSame = eq(normalizePrompts(before.prompts), normalizePrompts(content.PROMPTS));

  if (directiveSame && glossarySame && promptsSame) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, configId });
    return;
  }

  const avatarId = state.steps.avatarId?.value;
  const avatar = avatarId ? await mgmt.avatars.get(avatarId, ks) : null;
  const personaLint = lintPersonaIdentity({
    name: project.personaName,
    openingPhrase: avatar?.openingPhrase ?? content.OPENING_PHRASE,
    baseDirective: content.BASE_DIRECTIVE,
    prompts: content.PROMPTS,
  });
  for (const f of personaLint.findings) progress(flags, `[persona lint] ${f.severity}: ${f.message}`);

  const planLines = [
    `Update prompts for project "${state.slug}" (configId ${configId}):`,
    `  base_directive: ${directiveSame ? 'unchanged' : 'changed'}`,
    `  glossary: ${glossarySame ? 'unchanged' : 'changed'}`,
    `  prompts: ${promptsSame ? 'unchanged' : 'changed'}`,
  ];
  await confirmPlan(flags, planLines);

  const { lint } = await mgmt.intellects.setPrompts(configId, content.PROMPTS, ks, {
    baseDirective: content.BASE_DIRECTIVE,
    glossary: content.GLOSSARY,
  });
  for (const f of lint?.findings || []) {
    if (f.severity === 'warning') progress(flags, `[setPrompts lint] warning: ${f.message}`);
  }

  const after = await mgmt.intellects.get(configId, ks);
  const errors = [];
  if (after.base_directive !== content.BASE_DIRECTIVE) errors.push('base_directive did not apply');
  if (!eq(normalizePrompts(after.prompts), normalizePrompts(content.PROMPTS))) errors.push('prompts did not apply');
  if (!eq(after.glossary || null, content.GLOSSARY || null)) errors.push('glossary did not apply');
  if (!eq((after.tool_ids || []).map(String), (before.tool_ids || []).map(String))) errors.push('tool_ids changed unexpectedly');
  if (!eq(after.knowledge_ids || [], before.knowledge_ids || [])) errors.push('knowledge_ids changed unexpectedly');
  if (!eq(after.capabilities || {}, before.capabilities || {})) errors.push('capabilities changed unexpectedly');
  if (after.status !== before.status) errors.push('status changed unexpectedly');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, configId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Verified: prompts/base_directive/glossary updated, everything else untouched.');
  result(flags, { ok: true, configId });
}

runMain(main);
