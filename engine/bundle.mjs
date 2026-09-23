#!/usr/bin/env node
/**
 * Bundle the toolkit's client/ app (index.html + styles.css + app.js, plus the
 * vendored SDK) with one project's own data/slides/*.json and
 * prompts/client/*.md inlined, into <project>/dist.html.
 *
 * client/ itself is toolkit code shared by every project; only the data it
 * inlines is project-specific. loadData() in app.js fetches slide JSON and
 * client prompt templates at runtime for local dev; this bundler replaces its
 * body with pre-loaded literals so dist.html needs no fetches for either.
 *
 * Usage: node engine/bundle.mjs --project <path> [--pdf-url=<url>]
 *        [--widget-id=<id>] [--partner-id=<id>] [--json]
 * Without --pdf-url, the bundled PDF_URL stays the local-dev relative path.
 * Fine for a preview bundle, wrong for deployment (deploy.mjs always passes it).
 * Without --widget-id/--partner-id, falls back to the project's own
 * .provisioning-state.json / .env so a plain `bundle` after `provision`
 * needs no flags at all.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { parseFlags, projectRootFrom, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { parseSections } from '../client/prompt-format.js';
import { loadState } from './lib/state.mjs';
import { loadCredentials, parseEnvFile } from './lib/env.mjs';
import { loadContent } from './lib/load-content.mjs';
import { buildCaptionMap } from './lib/caption-map.mjs';
import { scanForEnvLeaks } from './lib/env-leak-scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = resolve(__dirname, '..');
const WIDGET_PLACEHOLDER = 'WIDGET_ID_UNSET';

// Same text as client/index.html's hardcoded disclosure line: the fallback
// used when project.json disclosure.text is blank.
const DEFAULT_DISCLOSURE_TEXT = "This experience is presented by an AI avatar. It is not a human, and it cannot make commitments on anyone's behalf.";

// Env keys the bundler intentionally bakes into the client: widget id, and the
// service URL, which is just the SDK's own public default endpoint, not a leak.
const ENV_LEAK_SCAN_EXCLUDE_KEYS = ['KALTURA_WIDGET_ID', 'KALTURA_PARTNER_ID', 'KALTURA_SERVICE_URL'];

// Valid values for project.json avatar.syntheticLabelPlacement. "openingPhrase"
// is a real future option but touches prompt generation (content.mjs,
// update-avatar.mjs), so it's deferred rather than implemented here.
const SYNTHETIC_LABEL_PLACEMENT_VALUES = ['welcome'];

/** Inlines every `./assets/<file>.svg` tag that `html` actually contains, as a base64 data
 * URI, for every svg file `assetsDir` holds. `client/` may ship an svg asset that the current
 * markup doesn't reference yet (a future toggle's icon, for example); skip those rather than
 * inlining bytes nothing links to. Exported so a unit test can prove this generically, without
 * depending on which svg tags the shipped index.html happens to have today. */
export function inlineSvgAssets(html, assetsDir) {
  if (!existsSync(assetsDir)) return html;
  for (const file of readdirSync(assetsDir).filter((f) => f.endsWith('.svg'))) {
    const tag = `./assets/${file}`;
    if (!html.includes(tag)) continue;
    const svg = readFileSync(resolve(assetsDir, file), 'utf8').trim();
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    html = html.replaceAll(tag, dataUri);
  }
  return html;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e.message}`);
  }
}

/**
 * Warn-and-proceed checks over project.json. Per the project owner's direction,
 * the builder recommends but never blocks on these. A project silences a
 * specific warning by adding its id to project.json overrides.acknowledgeWarnings.
 */
export function checkBundleWarnings(project) {
  const acknowledged = new Set(project.overrides?.acknowledgeWarnings || []);
  const warn = (id, message) => {
    if (acknowledged.has(id)) {
      console.error(`[bundle] "${id}" warning acknowledged in project.json overrides.acknowledgeWarnings. Proceeding.`);
    } else {
      console.error(`[bundle] warning (${id}): ${message}`);
    }
  };

  if (!project.disclosure?.text?.trim()) {
    warn('disclosure', 'project.json disclosure.text is empty. The bundle falls back to the toolkit default disclosure line. Set disclosure.text, or add "disclosure" to overrides.acknowledgeWarnings if this is intentional.');
  }

  if (!project.privacy?.controllerName?.trim() || !project.privacy?.controllerContact?.trim()) {
    warn('privacyContact', 'project.json privacy.controllerName or privacy.controllerContact is empty. The privacy panel will show a placeholder. Set both fields, or add "privacyContact" to overrides.acknowledgeWarnings if this is intentional.');
  }

  const sessionMaxSeconds = project.sessionMaxSeconds;
  const statedCopy = [project.branding?.welcomeSubtitle, project.disclosure?.text].filter(Boolean).join(' ');
  const durationMatch = statedCopy.match(/(\d+)\s*(hour|minute)s?\b/i);
  if (durationMatch && typeof sessionMaxSeconds === 'number') {
    const statedSeconds = Number(durationMatch[1]) * (/hour/i.test(durationMatch[2]) ? 3600 : 60);
    if (statedSeconds > sessionMaxSeconds) {
      warn('sessionDuration', `Welcome copy states a duration ("${durationMatch[0]}") longer than sessionMaxSeconds (${sessionMaxSeconds}s). Update the copy or sessionMaxSeconds, or add "sessionDuration" to overrides.acknowledgeWarnings if this is intentional.`);
    }
  }

  if (project.avatar?.source === 'cloned') {
    warn('syntheticLabel', 'avatar.source is "cloned". The synthetic-content label shows by default, disclosing that the avatar\'s voice/likeness is a recreation. Add "syntheticLabel" to overrides.acknowledgeWarnings to suppress it.');
  }

  const unknownPlacements = (project.avatar?.syntheticLabelPlacement || []).filter((p) => !SYNTHETIC_LABEL_PLACEMENT_VALUES.includes(p));
  if (unknownPlacements.length) {
    console.error(`[bundle] warning: project.json avatar.syntheticLabelPlacement has unrecognized value(s): ${unknownPlacements.join(', ')}. Valid values: ${SYNTHETIC_LABEL_PLACEMENT_VALUES.join(', ')}. Ignoring them and continuing.`);
  }
}

export async function bundle(projectRoot, { pdfUrl, widgetId, partnerId } = {}) {
  const clientDir = resolve(TOOLKIT_ROOT, 'client');
  const css = readFileSync(resolve(clientDir, 'styles.css'), 'utf8');
  const jsSource = readFileSync(resolve(clientDir, 'app.js'), 'utf8');
  let html = readFileSync(resolve(clientDir, 'index.html'), 'utf8');

  const project = readJson(resolve(projectRoot, 'project.json'));
  checkBundleWarnings(project);

  // ── Resolve widget/partner ids: explicit arg > this project's own state/.env ──
  if (!widgetId) widgetId = loadState(projectRoot)?.steps?.widgetId?.value ? String(loadState(projectRoot).steps.widgetId.value) : '';
  if (!partnerId) {
    const creds = loadCredentials(projectRoot);
    if (creds.ok) partnerId = creds.partnerId;
  }
  if (partnerId && !/^\d+$/.test(String(partnerId))) throw new Error(`partnerId must be numeric, got: ${partnerId}`);
  if (pdfUrl && !widgetId) throw new Error('No widget id available. Run engine/provision.mjs first, or pass --widget-id=.');

  // ── Extract + validate version ──
  const versionMatch = jsSource.match(/const VERSION = '([^']+)'/);
  if (!versionMatch) throw new Error("Could not find 'const VERSION' in client/app.js");
  const version = versionMatch[1];

  // ── Load + validate this project's slide data ──
  const slidesDir = resolve(projectRoot, 'data', 'slides');
  if (!existsSync(slidesDir)) throw new Error(`Slides directory not found: ${slidesDir}`);
  const slideFiles = readdirSync(slidesDir).filter((f) => f.endsWith('.json')).sort();
  if (!slideFiles.length) throw new Error(`No JSON files found in ${slidesDir}`);

  const slides = slideFiles.map((fname) => {
    const data = readJson(resolve(slidesDir, fname));
    if (typeof data !== 'object' || data === null) throw new Error(`${fname} must contain a single JSON object`);
    if (typeof data.slide !== 'number') throw new Error(`${fname} is missing the required "slide" number field`);
    return data;
  });
  slides.sort((a, b) => a.slide - b.slide);

  const total = slides.length;
  const slideNums = slides.map((s) => s.slide);
  const expected = Array.from({ length: total }, (_, i) => i + 1);
  if (JSON.stringify(slideNums) !== JSON.stringify(expected)) {
    const missing = expected.filter((n) => !slideNums.includes(n));
    const dupes = slideNums.filter((n, i) => slideNums.indexOf(n) !== i);
    let msg = `Slide numbering is not contiguous 1-${total}.`;
    if (missing.length) msg += ` Missing: ${missing}`;
    if (dupes.length) msg += ` Duplicates: ${[...new Set(dupes)]}`;
    throw new Error(msg);
  }

  // ── Rewrite app.js source before bundling: inline PDF_URL + loadData() body ──
  let js = jsSource;
  // SDK version shown on the welcome screen next to the app version: read from the
  // installed package.json so it cannot drift from what actually shipped.
  const sdkPkgPath = resolve(TOOLKIT_ROOT, 'node_modules/@kaltura/intelligent-agents/package.json');
  if (!existsSync(sdkPkgPath)) throw new Error(`SDK not installed: ${sdkPkgPath} not found. Run npm install.`);
  const sdkVersion = readJson(sdkPkgPath).version;
  if (!/^\d+\.\d+\.\d+/.test(sdkVersion || '')) throw new Error('Could not read version from the installed SDK package.json');
  js = js.replace(/const SDK_VERSION = '[^']*';.*/, `const SDK_VERSION = '${sdkVersion}';`);
  if (!js.includes(`const SDK_VERSION = '${sdkVersion}';`)) throw new Error("Could not rewrite 'const SDK_VERSION' in app.js");
  if (pdfUrl) {
    js = js.replace(/const PDF_URL = '[^']*';.*/, `const PDF_URL = '${pdfUrl}';`);
  }
  if (widgetId) {
    js = js.replace(/const WIDGET_ID = '[^']*';.*/, `const WIDGET_ID = '${widgetId}';`);
    if (!js.includes(`const WIDGET_ID = '${widgetId}';`)) throw new Error("Could not rewrite 'const WIDGET_ID' in app.js");
  }
  if (partnerId) {
    js = js.replace(/const PARTNER_ID = \d+;.*/, `const PARTNER_ID = ${Number(partnerId)};`);
    if (!js.includes(`const PARTNER_ID = ${Number(partnerId)};`)) throw new Error("Could not rewrite 'const PARTNER_ID' in app.js");
  }
  if (pdfUrl && js.includes(`const WIDGET_ID = '${WIDGET_PLACEHOLDER}'`)) throw new Error('Deploy bundle still has the WIDGET_ID placeholder');

  // ── Load + parse this project's client-side prompt templates ──
  const promptsClientDir = resolve(projectRoot, 'prompts', 'client');
  const navPrompts = {
    navNudges: parseSections(readFileSync(resolve(promptsClientDir, 'nav-nudges.md'), 'utf8')),
    navHint: readFileSync(resolve(promptsClientDir, 'nav-hint.md'), 'utf8').trim(),
    routeAnswers: parseSections(readFileSync(resolve(promptsClientDir, 'route-answers.md'), 'utf8')),
  };

  // ── Tool names: derived from this project's own content.mjs, never hardcoded in app.js ──
  const content = await loadContent(projectRoot);
  const toolNames = {
    nav: content.NAV_TOOL.name,
    contact: content.CONTACT_TOOL?.name || '',
    endSession: content.END_SESSION_TOOL?.name || '',
  };

  // ── Caption replacement map: derived from this project's own pronunciation guide ──
  const guidePath = resolve(projectRoot, 'prompts', 'pronunciation-guide.md');
  const captionMap = existsSync(guidePath) ? buildCaptionMap(readFileSync(guidePath, 'utf8')) : {};

  // ── Branding: optional per-project override on top of the neutral defaults in app.js ──
  const branding = project.branding || {};

  // ── Chapters: project.json chapters ({title,range}[]) remapped to the client's {label,start,end}[] ──
  const chapters = (project.chapters || []).map((c) => ({ label: c.title, start: c.range[0], end: c.range[1] }));
  if (chapters.length) {
    const uncovered = expected.filter((n) => !chapters.some((c) => n >= c.start && n <= c.end));
    if (uncovered.length) throw new Error(`project.json chapters do not cover every slide. Uncovered: ${uncovered.join(', ')}`);
  }

  // ── Topic routing: data/routes.json, a deterministic render of data/nav-rules.json
  // (bin/render-routes.mjs). Absence means this project has no topic routing configured. ──
  const routesPath = resolve(projectRoot, 'data', 'routes.json');
  const routes = existsSync(routesPath) ? readJson(routesPath) : [];
  const topicRoutes = routes.map((r) => {
    if (typeof r.entrySlide !== 'number' || r.entrySlide < 1 || r.entrySlide > total) {
      throw new Error(`data/routes.json topic "${r.topic}" has entrySlide ${JSON.stringify(r.entrySlide)}, which is not a real slide. Fix data/nav-rules.json and re-render data/routes.json from it.`);
    }
    return { keywords: [r.topic, ...(r.aliases || [])].map((k) => String(k).toLowerCase()), slide: r.entrySlide };
  });

  // ── Disclosure, privacy, and avatar-source label placement: all warn-and-proceed
  // (checkBundleWarnings above), never blocked. ──
  const disclosureText = project.disclosure?.text?.trim() || DEFAULT_DISCLOSURE_TEXT;
  const privacy = {
    controllerName: project.privacy?.controllerName || '',
    controllerContact: project.privacy?.controllerContact || '',
  };
  const avatarSource = project.avatar?.source || 'fresh';
  const syntheticLabelPlacement = (project.avatar?.syntheticLabelPlacement || []).filter((p) => SYNTHETIC_LABEL_PLACEMENT_VALUES.includes(p));
  const acknowledgedWarnings = new Set(project.overrides?.acknowledgeWarnings || []);
  const suppressSyntheticLabel = avatarSource === 'cloned' && acknowledgedWarnings.has('syntheticLabel');

  const inlineData = (
    '\n  // ── Inlined slide data (bundled from data/slides/*.json. DO NOT EDIT dist.html) ──\n' +
    `  SLIDE_DATA = ${JSON.stringify(slides)};\n` +
    '\n  // ── Inlined client prompt templates (bundled from prompts/client/*.md. DO NOT EDIT dist.html) ──\n' +
    `  NAV_PROMPTS = ${JSON.stringify(navPrompts)};\n` +
    '\n  // ── Inlined tool names (bundled from content.mjs. DO NOT EDIT dist.html) ──\n' +
    `  TOOL_NAMES = ${JSON.stringify(toolNames)};\n` +
    '\n  // ── Inlined caption map (bundled from prompts/pronunciation-guide.md. DO NOT EDIT dist.html) ──\n' +
    `  CAPTION_MAP = ${JSON.stringify(captionMap)};\n` +
    '\n  // ── Inlined branding override (bundled from project.json branding. DO NOT EDIT dist.html) ──\n' +
    `  BRANDING = Object.assign({}, BRANDING, ${JSON.stringify(branding)});\n` +
    '\n  // ── Inlined chapters (bundled from project.json chapters. DO NOT EDIT dist.html) ──\n' +
    `  CHAPTERS = ${JSON.stringify(chapters)};\n` +
    '\n  // ── Inlined topic routes (bundled from data/routes.json. DO NOT EDIT dist.html) ──\n' +
    `  TOPIC_ROUTES = ${JSON.stringify(topicRoutes)};\n` +
    '\n  // ── Inlined disclosure, privacy, and avatar-source label data (bundled from project.json. DO NOT EDIT dist.html) ──\n' +
    `  DISCLOSURE_TEXT = ${JSON.stringify(disclosureText)};\n` +
    `  PRIVACY = ${JSON.stringify(privacy)};\n` +
    `  AVATAR_SOURCE = ${JSON.stringify(avatarSource)};\n` +
    `  SYNTHETIC_LABEL_PLACEMENT = ${JSON.stringify(syntheticLabelPlacement)};\n` +
    `  SUPPRESS_SYNTHETIC_LABEL = ${JSON.stringify(suppressSyntheticLabel)};\n`
  );
  const loadStart = js.indexOf('async function loadData()');
  if (loadStart === -1) throw new Error("Could not find 'async function loadData()' in app.js");
  const braceStart = js.indexOf('{', loadStart);
  let depth = 0;
  let pos = braceStart;
  for (; pos < js.length; pos += 1) {
    if (js[pos] === '{') depth += 1;
    else if (js[pos] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error('Could not find matching closing brace for loadData()');
  js = js.slice(0, braceStart) + '{' + inlineData + '}' + js.slice(pos + 1);

  // ── Bundle the rewritten app.js + vendored SDK into one IIFE ──
  // Written inside client/ (not os.tmpdir()) so its relative imports resolve.
  const tmpEntry = resolve(clientDir, '.bundle-entry.tmp.js');
  writeFileSync(tmpEntry, js);
  let bundledJs;
  try {
    const built = await esbuild.build({
      entryPoints: [tmpEntry],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      write: false,
      absWorkingDir: clientDir,
      // Not minifyIdentifiers: SLIDE_DATA and friends are plain top-level
      // `let` bindings inside this IIFE, and test/bundle.test.mjs (plus this
      // bundle's own validation just below) checks for their literal names
      // in the output. Whitespace/syntax minification still cuts real bytes
      // with no such risk.
      minifyWhitespace: true,
      minifySyntax: true,
    });
    bundledJs = built.outputFiles[0].text;
  } finally {
    unlinkSync(tmpEntry);
  }

  // ── Inline every client/assets/*.svg the shipped markup references ──
  html = inlineSvgAssets(html, resolve(clientDir, 'assets'));

  // ── Inline CSS and JS into HTML ──
  const CSS_TAG = '<link rel="stylesheet" href="styles.css">';
  const JS_TAG = '<script type="module" src="app.js"></script>';
  if (!html.includes(CSS_TAG)) throw new Error(`Could not find CSS link tag in index.html: ${CSS_TAG}`);
  if (!html.includes(JS_TAG)) throw new Error(`Could not find app.js script tag in index.html: ${JS_TAG}`);
  // Function replacers: a string replacer would interpret "$&" etc. in css/bundledJs
  // (e.g. the vendored SDK's own regex-escaping helpers) as special replacement patterns.
  html = html.replace(CSS_TAG, () => `<style>\n${css}\n  </style>`);
  html = html.replace(JS_TAG, () => `<script>\n${bundledJs}\n  </script>`);

  // ── Post-bundle validation ──
  const errors = [];
  if (html.includes(CSS_TAG)) errors.push('CSS link tag still present after replacement');
  if (html.includes(JS_TAG)) errors.push('app.js script tag still present after replacement');
  if (html.includes('fetch(./data/slides') || html.includes("fetch('./data/slides")) errors.push('fetch() calls remain: slide data was not properly inlined');
  if (html.includes('fetch(./prompts/client') || html.includes("fetch('./prompts/client")) errors.push('fetch() calls remain: client prompt templates were not properly inlined');
  if (!html.includes('SLIDE_DATA')) errors.push('SLIDE_DATA not found in output: slide inlining failed');
  if (!html.includes('NAV_PROMPTS')) errors.push('NAV_PROMPTS not found in output: prompt template inlining failed');
  if (!html.includes('TOOL_NAMES')) errors.push('TOOL_NAMES not found in output: tool name inlining failed');
  if (!html.includes(toolNames.nav)) errors.push('the navigation tool name was not baked into the bundled output');
  for (const cdn of ['pdf.js', 'socket.io']) {
    if (!html.includes(cdn)) errors.push(`CDN dependency "${cdn}" missing from output`);
  }
  if (pdfUrl && !html.includes(pdfUrl)) errors.push('pdfUrl was not baked into the bundled output');
  if (widgetId && !html.includes(widgetId)) errors.push('widgetId was not baked into the bundled output');
  if (errors.length) throw new Error(`Bundle validation failed, dist.html not written:\n  ${errors.join('\n  ')}`);

  // ── .env leak scan: unconditional, no override. Scans the in-memory string
  // so a caught leak never touches disk. ──
  const envPath = resolve(projectRoot, '.env');
  if (existsSync(envPath)) {
    const envValues = parseEnvFile(readFileSync(envPath, 'utf8'));
    const leakedKeys = scanForEnvLeaks(html, envValues, { excludeKeys: ENV_LEAK_SCAN_EXCLUDE_KEYS });
    if (leakedKeys.length) {
      throw new Error(`Bundle would leak .env value(s) into dist.html, dist.html not written. Leaked keys: ${leakedKeys.join(', ')}. Remove the value from client-facing data, or rename the key if it should never reach the bundle.`);
    }
  }

  // ── Write output atomically ──
  const distPath = resolve(projectRoot, 'dist.html');
  const tmpOut = `${distPath}.tmp-${process.pid}`;
  writeFileSync(tmpOut, html);
  renameSync(tmpOut, distPath);

  return { version, distPath, html, slideCount: total };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  if (!existsSync(resolve(projectRoot, 'project.json'))) fail(flags, EXIT.USAGE, `No project.json at ${resolve(projectRoot, 'project.json')}`);

  try {
    const { version, distPath, html, slideCount } = await bundle(projectRoot, {
      pdfUrl: flags['pdf-url'],
      widgetId: flags['widget-id'],
      partnerId: flags['partner-id'],
    });
    progress(flags, `Bundled ${distPath}, v${version} (${html.length.toLocaleString()} bytes, ${slideCount} slides inlined)`);
    result(flags, { version, distPath, bytes: html.length, slideCount });
  } catch (err) {
    fail(flags, EXIT.VALIDATION, `Bundle failed: ${err.message}`);
  }
}

// Guarded: deploy.mjs imports bundle() from this file. Without this guard,
// importing this module for that export also ran this CLI's own main() with
// the importer's argv, as an unintended side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main);
