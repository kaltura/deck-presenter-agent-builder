#!/usr/bin/env node
/**
 * Creates the knowledge base (category, data/kb/*.md uploads, knowledge
 * record) if not already recorded, then attaches it to the project's
 * already-existing intellect and turns retrieval on.
 *
 * Fills a gap in engine/provision.mjs: that command only creates and
 * attaches a knowledge base on a project's first run, while
 * features.knowledgeBase is already on. Turning the feature on after the
 * intellect already exists has no command that attaches a fresh
 * knowledge_ids to it. This is that command, read-compare-write-verify like
 * the other update commands.
 *
 * Idempotent by local state: once a prior successful run has recorded every
 * local data/kb/*.md file and the attach step, a re-run exits 0 with no
 * network call at all. Adding a new local file re-runs the attach step for
 * that file. Editing an existing file's content is engine/update-kb.mjs's
 * job, not this command's.
 *
 * Usage: node engine/attach-knowledge-base.mjs --project <path> [--dry-run] [--yes] [--kb-wait-ms=60000] [--json]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, recordStep, assertPartnerMatch } from './lib/state.mjs';
import { loadContent } from './lib/load-content.mjs';
import { categoryOwnedElsewhere } from './lib/tool-guard.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (text) => createHash('sha256').update(text).digest('hex');

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

  if (!project.features?.knowledgeBase) {
    progress(flags, 'features.knowledgeBase is off in project.json. Nothing to do.');
    result(flags, { skipped: true, reason: 'knowledgeBase feature is off' });
    return;
  }

  const kbDir = resolve(projectRoot, 'data/kb');
  const kbFiles = existsSync(kbDir) ? readdirSync(kbDir).filter((f) => f.endsWith('.md')).sort() : [];
  if (!kbFiles.length) fail(flags, EXIT.VALIDATION, `features.knowledgeBase is on but ${kbDir} has no markdown files.`);

  // Building this Management client and reading project files makes no
  // network call by itself (see engine/lib/kaltura.mjs). That first happens
  // after confirmPlan below, so a non-interactive refusal never reaches Kaltura.
  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);
  if (content.CAPABILITIES.use_knowledge_base !== 'on') {
    fail(flags, EXIT.VALIDATION, 'features.knowledgeBase is on but content.mjs CAPABILITIES.use_knowledge_base is not "on".');
  }

  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const configId = state.steps.configId?.value;
  if (!configId) fail(flags, EXIT.UNEXPECTED, 'No configId in .provisioning-state.json. Run engine/provision.mjs first.');

  const kbEntries = state.steps.kbEntries?.value ?? [];
  const newFiles = kbFiles.filter((f) => !kbEntries.some((e) => e.file === f));
  const knowledgeId = state.steps.knowledgeId?.value ?? null;

  if (knowledgeId && newFiles.length === 0 && state.steps.kbAttached?.value) {
    progress(flags, 'Already up to date.');
    result(flags, { upToDate: true, configId, knowledgeId });
    return;
  }

  const planLines = [`Attach knowledge base for project "${state.slug}" (configId ${configId}):`];
  planLines.push(`  category "${content.KB_NAME}"${state.steps.kbCategoryId ? ' (already recorded, reused)' : ' (create, refused if the name is taken)'}`);
  planLines.push(newFiles.length ? `  upload ${newFiles.length} new file(s): ${newFiles.join(', ')}` : '  upload: nothing new');
  planLines.push(`  knowledge record${knowledgeId ? ' (already recorded, reused)' : ' (create)'}`);
  planLines.push('  knowledge_ids and capabilities.use_knowledge_base: attach/enable on the intellect (re-checked live, skipped if already correct)');
  await confirmPlan(flags, planLines);

  const ks = await adminKs(mgmt);
  const before = await mgmt.intellects.get(configId, ks);

  const k = mgmt.knowledge;

  let categoryId = state.steps.kbCategoryId?.value;
  if (!categoryId) {
    progress(flags, `[kbCategoryId] creating category "${content.KB_NAME}"...`);
    const existing = await k.findCategory(content.KB_NAME, ks);
    if (existing) fail(flags, EXIT.PROVISIONING, categoryOwnedElsewhere(content.KB_NAME, existing.id));
    const cat = await k.createCategory({ name: content.KB_NAME }, ks);
    categoryId = cat?.id;
    if (!categoryId) fail(flags, EXIT.PROVISIONING, `knowledge.createCategory returned no id: ${JSON.stringify(cat).slice(0, 300)}`);
    recordStep(projectRoot, state, 'kbCategoryId', { value: categoryId, origin: 'created' });
  }
  progress(flags, `[kbCategoryId] ${categoryId}`);

  for (const f of newFiles) {
    progress(flags, `[kbEntries] uploading ${f}...`);
    const markdown = readFileSync(resolve(kbDir, f), 'utf8');
    const up = await k.uploadMarkdown({ markdown, name: f, categoryId }, ks);
    kbEntries.push({ file: f, entryId: up.entryId, markdownAssetId: up.markdownAssetId, contentHash: hash(markdown) });
    recordStep(projectRoot, state, 'kbEntries', { value: kbEntries, origin: 'created' });
  }

  let finalKnowledgeId = knowledgeId;
  if (!finalKnowledgeId) {
    progress(flags, '[knowledgeId] creating knowledge record...');
    const indexers = [
      { index_position: 0, type: 1, strategy: 'EmbedCaptionV1' },
      { index_position: 0, type: 2, strategy: 'EmbedOcrV1' },
      { index_position: 0, type: 3, strategy: 'EmbedDocumentV1' },
    ];
    const rec = await k.addRecord({
      name: content.KB_NAME,
      description: `${project.slug}: per-topic markdown notes`,
      config: { sources: [{ type: 'internal', language: 'English', categoryIds: [String(categoryId)], indexers }] },
    }, ks);
    finalKnowledgeId = Number(rec?.id);
    if (!Number.isInteger(finalKnowledgeId)) fail(flags, EXIT.PROVISIONING, `knowledge.addRecord returned no integer id: ${JSON.stringify(rec).slice(0, 300)}`);
    recordStep(projectRoot, state, 'knowledgeId', { value: finalKnowledgeId, origin: 'created' });

    const waitMs = flags['kb-wait-ms'] ? Number(flags['kb-wait-ms']) : 60000;
    if (waitMs > 0) {
      progress(flags, `[knowledgeId] waiting ${waitMs}ms for indexing before linking...`);
      await sleep(waitMs);
    }
  }
  progress(flags, `[knowledgeId] ${finalKnowledgeId}`);

  const deadline = Date.now() + 5 * 60 * 1000;
  let corpus = null;
  for (;;) {
    try { corpus = await k.corpusStatus({ categoryId }, ks); } catch { /* retry */ }
    if ((corpus?.entryCount || 0) >= kbEntries.length) break;
    if (Date.now() > deadline) break;
    await sleep(10000);
  }
  progress(flags, `[corpus] entries visible: ${corpus?.entryCount ?? 'unknown'}/${kbEntries.length}`);

  const alreadyAttached = (before.knowledge_ids || []).includes(finalKnowledgeId) && before.capabilities?.use_knowledge_base === 'on';
  if (!alreadyAttached) {
    progress(flags, `[knowledge_ids] attaching [${finalKnowledgeId}] to configId ${configId}...`);
    await mgmt.intellectConfig.setKnowledgeIds(configId, [finalKnowledgeId], ks);
    await mgmt.knowledge.setEnabled(configId, true, ks);
  } else {
    progress(flags, '[knowledge_ids] already attached and enabled; no write needed.');
  }

  const after = await mgmt.intellects.get(configId, ks);
  const errors = [];
  if (!eq(after.knowledge_ids || [], [finalKnowledgeId])) errors.push('knowledge_ids did not apply');
  if (after.capabilities?.use_knowledge_base !== 'on') errors.push('capabilities.use_knowledge_base did not apply');
  if (after.base_directive !== before.base_directive) errors.push('base_directive changed unexpectedly');
  if (!eq(after.prompts || [], before.prompts || [])) errors.push('prompts changed unexpectedly');
  if (!eq((after.tool_ids || []).map(String), (before.tool_ids || []).map(String))) errors.push('tool_ids changed unexpectedly');

  if (errors.length) {
    progress(flags, `Verification FAILED: ${errors.join('; ')}`);
    result(flags, { ok: false, configId, errors });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  recordStep(projectRoot, state, 'kbAttached', { value: true, origin: 'created' });
  progress(flags, 'Verified: knowledge base attached, everything else untouched.');
  result(flags, { ok: true, configId, knowledgeId: finalKnowledgeId, categoryId });
}

runMain(main);
