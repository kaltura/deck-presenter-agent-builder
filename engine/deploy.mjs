#!/usr/bin/env node
/**
 * Deploys one project: bundles dist.html with the project's own deck.pdf
 * served from Kaltura, uploads both as document entries, and points a
 * project-namespaced short link at the result. Every id is recorded in
 * .provisioning-state.json (origin: created) so teardown can remove exactly
 * what this command created, and a re-deploy updates the same entries and
 * link instead of minting new ones every time.
 *
 * Needs engine/provision.mjs to have already run (widgetId in state).
 *
 * Usage: node engine/deploy.mjs --project <path> [--dry-run] [--yes] [--json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFlags, projectRootFrom, confirmPlan, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { connect, adminKs } from './lib/kaltura.mjs';
import { loadState, recordStep, assertPartnerMatch } from './lib/state.mjs';
import { bundle } from './bundle.mjs';
import { uploadFile, updateOrCreateDocumentEntry, findShortLinkBySystemName, updateShortLink, createShortLink } from './lib/ovp.mjs';

const CDN_BASE = 'https://cdnapi-ev.kaltura.com';

const cdnUrl = (partnerId, entryId, filename, hash, extra = '') =>
  `${CDN_BASE}/p/${partnerId}/sp/${partnerId}00/raw/entry_id/${entryId}/direct_serve/1/forceproxy/true/${filename}?h=${hash}${extra}`;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const projectJsonPath = resolve(projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) fail(flags, EXIT.USAGE, `No project.json at ${projectJsonPath}`);
  const project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

  const { mgmt, partnerId } = connect(projectRoot, flags);

  const state = loadState(projectRoot);
  if (!state) fail(flags, EXIT.UNEXPECTED, 'No .provisioning-state.json. Run engine/provision.mjs first.');
  assertPartnerMatch(state, partnerId);
  const widgetId = state.steps.widgetId?.value;
  if (!widgetId) fail(flags, EXIT.UNEXPECTED, 'No widgetId recorded yet. Run engine/provision.mjs first.');

  const pdfPath = resolve(projectRoot, 'data', 'deck.pdf');
  if (!existsSync(pdfPath)) fail(flags, EXIT.USAGE, `Deck PDF not found: ${pdfPath}`);

  // The CDN content hash busts caches on every deploy regardless, but the human-readable
  // version label only changes if VERSION in client/app.js was bumped. Deploying twice
  // under the same version is almost always a forgotten bump, not intentional. Fail
  // loudly before any network call rather than shipping silently under a stale label.
  const toolkitClientJs = new URL('../client/app.js', import.meta.url);
  const versionMatch = readFileSync(toolkitClientJs, 'utf8').match(/const VERSION = '([^']+)'/);
  if (!versionMatch) fail(flags, EXIT.UNEXPECTED, "Could not find 'const VERSION' in client/app.js");
  const newVersion = versionMatch[1];
  if (state.steps.deployedVersion?.value === newVersion) {
    fail(flags, EXIT.VALIDATION, `VERSION in client/app.js is still '${newVersion}', same as the last deploy. Bump it before deploying.`);
  }

  const pdfEntryId = state.steps.pdfEntryId?.value || '';
  const htmlEntryId = state.steps.htmlEntryId?.value || '';
  const shortLinkId = state.steps.shortLinkId?.value || '';
  const shortLinkSystemName = `deck-presenter-${project.slug}`;

  const planLines = [
    `Deploy plan for project "${project.slug}" (partner ${partnerId}), version v${newVersion}:`,
    `  1. PDF entry: ${pdfEntryId ? `update ${pdfEntryId}` : 'create new'} from ${pdfPath}`,
    `  2. bundle dist.html with the real PDF url baked in`,
    `  3. HTML entry: ${htmlEntryId ? `update ${htmlEntryId}` : 'create new'} from dist.html`,
    `  4. short link: ${shortLinkId ? `update ${shortLinkId}` : `look up systemName=${shortLinkSystemName}, else create new`}`,
  ];
  await confirmPlan(flags, planLines);

  const ks = await adminKs(mgmt);

  try {
    // ── 1. Upload + deploy deck.pdf ──
    progress(flags, 'Uploading deck.pdf...');
    const { tokenId: pdfTokenId, size: pdfSize } = await uploadFile(ks, pdfPath, 'deck.pdf', 'application/pdf');
    progress(flags, `  uploaded (${pdfSize} bytes)`);
    const pdfResult = await updateOrCreateDocumentEntry(ks, pdfEntryId, pdfTokenId, `${project.slug} - Deck`, 11);
    if (pdfResult.created) recordStep(projectRoot, state, 'pdfEntryId', { value: pdfResult.entryId, origin: 'created' });
    progress(flags, `  PDF entry: ${pdfResult.entryId}${pdfResult.created ? ' (new)' : ' (updated)'}`);

    const pdfHash = createHash('sha256').update(readFileSync(pdfPath)).digest('hex').slice(0, 10);
    const pdfUrl = cdnUrl(partnerId, pdfResult.entryId, 'deck.pdf', pdfHash);

    // ── 2. Bundle dist.html with the real PDF url baked in ──
    progress(flags, 'Bundling dist.html...');
    const { version, distPath, html } = await bundle(projectRoot, { pdfUrl, widgetId, partnerId });
    // The CDN caches by full URL (including query string) for around 100 days. VERSION
    // in app.js is bumped by hand, not on every edit. A content hash always changes
    // when the bundle does, so relying on VERSION alone can serve a stale edge copy.
    const contentHash = createHash('sha256').update(html).digest('hex').slice(0, 10);

    // ── 3. Upload + deploy dist.html ──
    progress(flags, 'Uploading dist.html...');
    const { tokenId: htmlTokenId, size: htmlSize } = await uploadFile(ks, distPath, 'dist.html', 'text/html');
    progress(flags, `  uploaded (${htmlSize} bytes)`);
    const htmlResult = await updateOrCreateDocumentEntry(ks, htmlEntryId, htmlTokenId, `${project.slug} - App v${version}`, 12);
    if (htmlResult.created) recordStep(projectRoot, state, 'htmlEntryId', { value: htmlResult.entryId, origin: 'created' });
    progress(flags, `  HTML entry: ${htmlResult.entryId}${htmlResult.created ? ' (new)' : ' (updated)'}`);

    const htmlUrl = cdnUrl(partnerId, htmlResult.entryId, 'dist.html', contentHash, `&v=${version}`);

    // ── 4. Create/update the short link ──
    let finalShortLinkId = shortLinkId;
    if (finalShortLinkId) {
      progress(flags, `Updating short link ${finalShortLinkId}...`);
      await updateShortLink(ks, finalShortLinkId, htmlUrl);
    } else {
      progress(flags, `Looking up short link by systemName: ${shortLinkSystemName}...`);
      const existing = await findShortLinkBySystemName(ks, shortLinkSystemName);
      if (existing) {
        finalShortLinkId = existing.id;
        progress(flags, `  found existing short link ${finalShortLinkId}, updating`);
        await updateShortLink(ks, finalShortLinkId, htmlUrl);
      } else {
        progress(flags, '  creating new short link...');
        const created = await createShortLink(ks, shortLinkSystemName, htmlUrl);
        finalShortLinkId = created.id;
        progress(flags, `  created short link ${finalShortLinkId}`);
      }
      recordStep(projectRoot, state, 'shortLinkId', { value: finalShortLinkId, origin: 'created' });
    }

    recordStep(projectRoot, state, 'deployedVersion', { value: version, origin: 'created' });

    const shareUrl = `https://www.kaltura.com/tiny/${finalShortLinkId}`;
    const deployResult = {
      partnerId, version, pdfEntryId: pdfResult.entryId, pdfUrl,
      htmlEntryId: htmlResult.entryId, htmlUrl, shortLinkId: finalShortLinkId, shareUrl,
      deployedAt: new Date().toISOString(),
    };
    writeFileSync(resolve(projectRoot, '.deploy-result.json'), JSON.stringify(deployResult, null, 2));

    progress(flags, `\nDeployed v${version}. Share URL: ${shareUrl}`);
    result(flags, deployResult);
  } catch (err) {
    progress(flags, `\nDeploy failed: ${err.detail || err.message || err}`);
    progress(flags, 'Partial state written to .provisioning-state.json. Re-run to resume.');
    process.exitCode = EXIT.PROVISIONING;
  }
}

runMain(main);
