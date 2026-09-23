#!/usr/bin/env node
/**
 * Provisions one project's Kaltura resources: navigation tool, optional
 * contact/end-session tools, optional knowledge base, intellect, avatar,
 * agent, widget id. Fixed order, resumable, namespaced by project.json.slug.
 *
 * Usage: node engine/provision.mjs --project <path> [--dry-run] [--yes] [--json]
 *        [--kb-wait-ms=60000] [--force]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { client as buildClientTool } from '@kaltura/intelligent-agents/management';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadContent } from './lib/load-content.mjs';
import { loadState, newState, recordStep, assertPartnerMatch } from './lib/state.mjs';
import { assertNamedResourceFree } from './lib/tool-guard.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  if (!project.slug) fail(flags, EXIT.VALIDATION, 'project.json is missing "slug".');

  const { mgmt, partnerId } = connect(projectRoot, flags);
  const content = await loadContent(projectRoot);

  let state = loadState(projectRoot);
  if (state) assertPartnerMatch(state, partnerId);
  else state = newState(partnerId, project.slug);

  if (state.steps.widgetId && !flags.force) {
    progress(flags, `Already fully provisioned (widgetId=${state.steps.widgetId.value}). Pass --force to re-provision.`);
    result(flags, { alreadyProvisioned: true, ...Object.fromEntries(Object.entries(state.steps).map(([k, v]) => [k, v.value])) });
    return;
  }

  // Checked before the plan, so a missing consent record stops the run before
  // anything is created, not at the avatar step with half the resources live.
  if (project.avatar?.source === 'cloned' && !state.steps.avatarId) {
    const cloneFromId = project.avatar?.cloneFromAvatarId;
    if (!cloneFromId) fail(flags, EXIT.VALIDATION, 'avatar.source is "cloned" but project.json avatar.cloneFromAvatarId is not set.');
    const consentFiles = [`consent/voice-${cloneFromId}.md`, `consent/visual-${cloneFromId}.md`];
    const missing = consentFiles.filter((f) => !existsSync(resolve(projectRoot, f)));
    if (missing.length) fail(flags, EXIT.VALIDATION, `Cloning avatar ${cloneFromId} needs consent records at ${consentFiles.join(' and ')}. Missing: ${missing.join(', ')}. Refusing to clone without them.`);
  }

  const features = project.features || {};
  const planLines = [
    `Provision plan for project "${project.slug}" (partner ${partnerId}):`,
    `  1. navigation tool "${content.NAV_TOOL.name}"${state.steps.navToolId ? ' (already recorded, reused)' : ' (create)'}`,
  ];
  let stepNo = 2;
  if (features.contactForm) planLines.push(`  ${stepNo++}. contact tool "${content.CONTACT_TOOL?.name}"${state.steps.contactToolId ? ' (reused)' : ' (create)'}`);
  if (features.endSessionTool) planLines.push(`  ${stepNo++}. end-session tool "${content.END_SESSION_TOOL?.name}"${state.steps.endSessionToolId ? ' (reused)' : ' (create)'}`);
  if (features.knowledgeBase) {
    planLines.push(`  ${stepNo++}. knowledge base category "${content.KB_NAME}", upload data/kb/*.md, knowledge record`);
  }
  planLines.push(`  ${stepNo++}. intellect (prompts, glossary, capabilities, tool ids, knowledge ids)`);
  planLines.push(`  ${stepNo++}. avatar (source: ${project.avatar?.source || 'template'})`);
  planLines.push(`  ${stepNo++}. agent "${content.AGENT_DISPLAY_NAME}"`);
  planLines.push(`  ${stepNo++}. widget id`);

  await confirmPlan(flags, planLines);

  const ks = await adminKs(mgmt);

  try {
    // Preflight (read-only). Everything here must pass before anything is created.
    if (features.knowledgeBase) {
      const kbDir = resolve(projectRoot, 'data/kb');
      const kbFiles = existsSync(kbDir) ? readdirSync(kbDir).filter((f) => f.endsWith('.md')).sort() : [];
      if (!kbFiles.length) throw new Error(`features.knowledgeBase is on but ${kbDir} has no markdown files.`);
      if (content.CAPABILITIES.use_knowledge_base !== 'on') {
        throw new Error('features.knowledgeBase is on but content.mjs CAPABILITIES.use_knowledge_base is not "on".');
      }
    }

    // 1) Navigation tool.
    let navToolId = state.steps.navToolId?.value;
    if (!navToolId) {
      progress(flags, `[navToolId] creating "${content.NAV_TOOL.name}"...`);
      await assertNamedResourceFree(mgmt.tools.list(ks), content.NAV_TOOL.name, null);
      const rec = await mgmt.tools.add(buildClientTool(content.NAV_TOOL), ks);
      navToolId = rec.id;
      recordStep(projectRoot, state, 'navToolId', { value: navToolId, origin: 'created' });
    }
    progress(flags, `[navToolId] ${navToolId}`);

    const toolIds = [navToolId];

    // 2) Optional contact tool.
    if (features.contactForm && content.CONTACT_TOOL) {
      let contactToolId = state.steps.contactToolId?.value;
      if (!contactToolId) {
        progress(flags, `[contactToolId] creating "${content.CONTACT_TOOL.name}"...`);
        await assertNamedResourceFree(mgmt.tools.list(ks), content.CONTACT_TOOL.name, null);
        const rec = await mgmt.tools.add(buildClientTool(content.CONTACT_TOOL), ks);
        contactToolId = rec.id;
        recordStep(projectRoot, state, 'contactToolId', { value: contactToolId, origin: 'created' });
      }
      progress(flags, `[contactToolId] ${contactToolId}`);
      toolIds.push(contactToolId);
    }

    // 3) Optional end-session tool.
    if (features.endSessionTool && content.END_SESSION_TOOL) {
      let endSessionToolId = state.steps.endSessionToolId?.value;
      if (!endSessionToolId) {
        progress(flags, `[endSessionToolId] creating "${content.END_SESSION_TOOL.name}"...`);
        await assertNamedResourceFree(mgmt.tools.list(ks), content.END_SESSION_TOOL.name, null);
        const rec = await mgmt.tools.add(buildClientTool(content.END_SESSION_TOOL), ks);
        endSessionToolId = rec.id;
        recordStep(projectRoot, state, 'endSessionToolId', { value: endSessionToolId, origin: 'created' });
      }
      progress(flags, `[endSessionToolId] ${endSessionToolId}`);
      toolIds.push(endSessionToolId);
    }

    // 4) Knowledge base (category, uploads, record) - optional.
    let knowledgeId = state.steps.knowledgeId?.value ?? null;
    if (features.knowledgeBase) {
      const k = mgmt.knowledge;
      const kbDir = resolve(projectRoot, 'data/kb');
      const kbFiles = readdirSync(kbDir).filter((f) => f.endsWith('.md')).sort();

      let categoryId = state.steps.kbCategoryId?.value;
      if (!categoryId) {
        progress(flags, `[kbCategoryId] creating category "${content.KB_NAME}"...`);
        const cat = await k.findOrCreateCategory({ name: content.KB_NAME }, ks);
        categoryId = cat?.id;
        if (!categoryId) throw new Error(`knowledge.findOrCreateCategory returned no id: ${JSON.stringify(cat).slice(0, 300)}`);
        recordStep(projectRoot, state, 'kbCategoryId', { value: categoryId, origin: 'created' });
      }
      progress(flags, `[kbCategoryId] ${categoryId}`);

      const kbEntries = state.steps.kbEntries?.value ?? [];
      for (const f of kbFiles) {
        if (kbEntries.some((e) => e.file === f && e.entryId)) continue;
        progress(flags, `[kbEntries] uploading ${f}...`);
        const markdown = readFileSync(resolve(kbDir, f), 'utf8');
        const up = await k.uploadMarkdown({ markdown, name: f, categoryId }, ks);
        // contentHash lets update-kb.mjs skip a file that has not changed since this upload.
        kbEntries.push({ file: f, entryId: up.entryId, markdownAssetId: up.markdownAssetId, contentHash: createHash('sha256').update(markdown).digest('hex') });
        recordStep(projectRoot, state, 'kbEntries', { value: kbEntries, origin: 'created' });
      }

      knowledgeId = state.steps.knowledgeId?.value;
      if (!knowledgeId) {
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
        knowledgeId = Number(rec?.id);
        if (!Number.isInteger(knowledgeId)) throw new Error(`knowledge.addRecord returned no integer id: ${JSON.stringify(rec).slice(0, 300)}`);
        recordStep(projectRoot, state, 'knowledgeId', { value: knowledgeId, origin: 'created' });

        const waitMs = flags['kb-wait-ms'] ? Number(flags['kb-wait-ms']) : 60000;
        if (waitMs > 0) {
          progress(flags, `[knowledgeId] waiting ${waitMs}ms for indexing before creating the intellect...`);
          await sleep(waitMs);
        }
      }
      progress(flags, `[knowledgeId] ${knowledgeId}`);

      const deadline = Date.now() + 5 * 60 * 1000;
      let corpus = null;
      for (;;) {
        try { corpus = await k.corpusStatus({ categoryId }, ks); } catch { /* retry */ }
        if ((corpus?.entryCount || 0) >= kbEntries.length) break;
        if (Date.now() > deadline) break;
        await sleep(10000);
      }
      progress(flags, `[corpus] entries visible: ${corpus?.entryCount ?? 'unknown'}/${kbEntries.length}`);
    }

    // 5) Intellect.
    let configId = state.steps.configId?.value;
    if (!configId) {
      progress(flags, '[configId] creating intellect...');
      const intel = await mgmt.intellects.create({
        type: 'internal',
        status: 2,
        allow_client_variables: true,
        prompts: content.PROMPTS,
        base_directive: content.BASE_DIRECTIVE,
        glossary: content.GLOSSARY,
        capabilities: content.CAPABILITIES,
        tool_ids: toolIds,
        knowledge_ids: knowledgeId ? [knowledgeId] : [],
        opening_phrase: content.OPENING_PHRASE,
      }, ks);
      configId = intel.configId;
      if (intel.warnings?.length) progress(flags, `[configId] lint warnings: ${JSON.stringify(intel.warnings)}`);
      recordStep(projectRoot, state, 'configId', { value: configId, origin: 'created' });
    }
    progress(flags, `[configId] ${configId}`);

    // 6) Avatar.
    let avatarId = state.steps.avatarId?.value;
    const avatarSource = project.avatar?.source || 'template';
    if (!avatarId) {
      progress(flags, `[avatarId] creating avatar (source: ${avatarSource})...`);
      let voice, visual;
      if (avatarSource === 'cloned') {
        // The consent records were checked before the plan.
        const cloneFromId = project.avatar.cloneFromAvatarId;
        const source = await mgmt.avatars.get(cloneFromId, ks);
        if (!source?.voice?.id || !source?.visual?.id) throw new Error(`avatars.get(${cloneFromId}) returned no voice/visual id.`);
        voice = { id: source.voice.id, ...(source.voice.speed != null ? { speed: source.voice.speed } : {}) };
        visual = { ...source.visual };
      } else {
        // listTemplates() returns {voice, face} bundles (a template's visual
        // is under `face`, not `visual`, distinct from avatars.get()'s
        // `visual` shape used on the cloned path above). avatars.create()
        // itself wants `visual: {id}`, so map face.id into it here.
        const templates = [];
        for await (const t of mgmt.avatars.listTemplates(ks)) templates.push(t);
        const usable = templates.filter((t) => t?.voice?.id && t?.face?.id);
        if (!usable.length) throw new Error('avatars.listTemplates() returned no usable template with both voice and face ids.');
        const templateName = project.avatar?.templateName;
        const template = templateName ? usable.find((t) => t.name === templateName) : usable[0];
        if (!template) throw new Error(`avatar.templateName is "${templateName}" but no such avatar template exists. Available: ${usable.map((t) => t.name).join(', ')}`);
        voice = { id: template.voice.id };
        visual = { id: template.face.id };
      }
      const av = await mgmt.avatars.create({ voice, visual }, ks);
      avatarId = av?.id;
      if (!avatarId) throw new Error('avatars.create returned no id.');
      recordStep(projectRoot, state, 'avatarId', { value: avatarId, origin: 'created' });
      recordStep(projectRoot, state, 'avatarSourceUsed', { value: avatarSource, origin: 'created' });
    }
    progress(flags, `[avatarId] ${avatarId}`);

    // 7) Agent.
    let agentId = state.steps.agentId?.value;
    if (!agentId) {
      progress(flags, `[agentId] creating agent "${content.AGENT_DISPLAY_NAME}"...`);
      const ag = await mgmt.agents.create({
        displayName: content.AGENT_DISPLAY_NAME,
        intellect: { intellectType: 'genie', id: configId },
        avatarIds: [avatarId],
        adminTags: [...(project.adminTags || []), 'deck-presenter-agent-builder', project.slug],
        maxConversationLength: content.MAX_CONVERSATION_LENGTH,
      }, ks);
      agentId = ag?.agentId;
      if (!agentId) throw new Error('agents.create returned no agentId.');
      recordStep(projectRoot, state, 'agentId', { value: agentId, origin: 'created' });
    }
    progress(flags, `[agentId] ${agentId}`);

    // 8) Widget id.
    let widgetId = state.steps.widgetId?.value;
    if (!widgetId) {
      progress(flags, '[widgetId] resolving...');
      const wr = await mgmt.application.resolveWidgetId(agentId, ks);
      widgetId = wr?.widgetId;
      if (!widgetId) throw new Error('application.resolveWidgetId returned no widgetId.');
      recordStep(projectRoot, state, 'widgetId', { value: widgetId, origin: 'created' });
    }
    progress(flags, `[widgetId] ${widgetId}`);

    result(flags, { partnerId, ...Object.fromEntries(Object.entries(state.steps).map(([k, v]) => [k, v.value])) });
  } catch (err) {
    progress(flags, `\nProvision failed: ${err.detail || err.message || err}`);
    progress(flags, `Partial state written to .provisioning-state.json. Re-run to resume.`);
    process.exitCode = EXIT.PROVISIONING;
    return;
  }
}

runMain(main);
