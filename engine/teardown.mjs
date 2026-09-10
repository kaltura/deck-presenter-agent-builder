#!/usr/bin/env node
/**
 * Deletes everything this project's own .provisioning-state.json says it
 * created. Never touches an id recorded as "adopted". Aborts before any
 * delete if the state file's partnerId does not match .env.
 *
 * Usage: node engine/teardown.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, writeState, statePath } from './lib/state.mjs';
import { deleteEntry, deleteShortLink } from './lib/ovp.mjs';

/** Reverse of creation order: deploy.mjs runs after provision.mjs, so its ids die first. */
const DELETE_ORDER = [
  'shortLinkId',
  'htmlEntryId',
  'pdfEntryId',
  'widgetId', // no delete call exists for a widget id; it is dropped by deleting the agent.
  'agentId',
  'avatarId',
  'configId',
  'knowledgeId',
  'kbEntries',
  'kbCategoryId',
  'endSessionToolId',
  'contactToolId',
  'navToolId',
];

// Every SDK delete call has its own built-in confirmation gate ({confirmPermanent: true}),
// on top of this engine's own confirmPlan(). Both must agree before anything is deleted.
const CONFIRM = { confirmPermanent: true, force: true };
const DELETERS = {
  shortLinkId: (mgmt, id, ks) => deleteShortLink(ks, id),
  htmlEntryId: (mgmt, id, ks) => deleteEntry(ks, id),
  pdfEntryId: (mgmt, id, ks) => deleteEntry(ks, id),
  agentId: (mgmt, id, ks) => mgmt.agents.delete(id, ks, CONFIRM),
  avatarId: (mgmt, id, ks) => mgmt.avatars.delete(id, ks, CONFIRM),
  configId: (mgmt, id, ks) => mgmt.intellects.delete(id, ks, CONFIRM),
  knowledgeId: (mgmt, id, ks) => mgmt.knowledge.deleteRecord(id, ks, CONFIRM),
  kbCategoryId: () => { throw new Error('no delete call for a knowledge category; remove it by hand in the KMC.'); },
  endSessionToolId: (mgmt, id, ks) => mgmt.tools.delete(id, ks, CONFIRM),
  contactToolId: (mgmt, id, ks) => mgmt.tools.delete(id, ks, CONFIRM),
  navToolId: (mgmt, id, ks) => mgmt.tools.delete(id, ks, CONFIRM),
};

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const { mgmt, partnerId } = connect(projectRoot, flags);

  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, `No .provisioning-state.json at ${statePath(projectRoot)}. Teardown needs it; a missing state file is a hard error, not an empty success.`);

  if (String(state.partnerId) !== String(partnerId)) {
    fail(
      flags,
      EXIT.UNEXPECTED,
      `.provisioning-state.json was written for partner ${state.partnerId}, but .env now points at partner ${partnerId}. Refusing to delete anything.`,
    );
  }

  const created = DELETE_ORDER.filter((k) => state.steps[k]?.origin === 'created' && state.steps[k].value != null);
  const adopted = Object.entries(state.steps).filter(([, v]) => v?.origin === 'adopted');

  const planLines = [`Teardown plan for project "${state.slug}" (partner ${partnerId}):`];
  for (const key of created) planLines.push(`  delete ${key} = ${JSON.stringify(state.steps[key].value)}`);
  for (const [key, v] of adopted) planLines.push(`  skip ${key} = ${JSON.stringify(v.value)} (origin: adopted, not this project's to delete)`);
  if (!created.length) planLines.push('  nothing to delete: no id in this state file is recorded as created.');

  await confirmPlan(flags, planLines);

  if (!created.length) {
    result(flags, { deleted: [], skipped: adopted.map(([k]) => k), survivors: [] });
    return;
  }

  const ks = await adminKs(mgmt);
  const deleted = [];
  const survivors = [];

  for (const key of created) {
    const step = state.steps[key];
    if (key === 'kbEntries') {
      // No entry-level delete exists independent of the category; recorded here for visibility only.
      progress(flags, `[${key}] no per-entry delete call; entries are removed with the category.`);
      delete state.steps[key];
      writeState(projectRoot, state);
      continue;
    }
    const del = DELETERS[key];
    try {
      progress(flags, `[${key}] deleting ${step.value}...`);
      await del(mgmt, step.value, ks);
      deleted.push({ key, id: step.value });
      delete state.steps[key];
      writeState(projectRoot, state);
      progress(flags, `[${key}] deleted`);
    } catch (err) {
      const alreadyGone = /not_found|does not exist|no such/i.test(String(err?.detail || err?.message || err));
      if (alreadyGone) {
        progress(flags, `[${key}] already gone, treating as success`);
        deleted.push({ key, id: step.value, alreadyGone: true });
        delete state.steps[key];
        writeState(projectRoot, state);
        continue;
      }
      progress(flags, `[${key}] FAILED: ${err?.detail || err?.message || err}`);
      survivors.push({ key, id: step.value, reason: String(err?.detail || err?.message || err) });
    }
  }

  result(flags, { deleted, skipped: adopted.map(([k]) => k), survivors });

  if (survivors.length) {
    progress(flags, `\n${survivors.length} resource(s) could not be deleted. Remove by hand in the KMC, then re-run teardown to clear the state file.`);
    process.exitCode = EXIT.PROVISIONING;
  }
}

runMain(main);
