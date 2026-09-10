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
 * Without --pdf-url, the bundled PDF_URL stays the local-dev relative path —
 * fine for a preview bundle, wrong for deployment (deploy.mjs always passes it).
 * Without --widget-id/--partner-id, falls back to the project's own
 * .provisioning-state.json / .env so a plain `bundle` after `provision`
 * needs no flags at all.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { parseFlags, projectRootFrom, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';
import { parseSections } from '../client/prompt-format.js';
import { loadState } from './lib/state.mjs';
import { loadCredentials } from './lib/env.mjs';
import { loadContent } from './lib/load-content.mjs';
import { buildCaptionMap } from './lib/caption-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = resolve(__dirname, '..');
const WIDGET_PLACEHOLDER = 'WIDGET_ID_UNSET';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e.message}`);
  }
}

export async function bundle(projectRoot, { pdfUrl, widgetId, partnerId } = {}) {
  const clientDir = resolve(TOOLKIT_ROOT, 'client');
  const css = readFileSync(resolve(clientDir, 'styles.css'), 'utf8');
  const jsSource = readFileSync(resolve(clientDir, 'app.js'), 'utf8');
  let html = readFileSync(resolve(clientDir, 'index.html'), 'utf8');

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
  const project = readJson(resolve(projectRoot, 'project.json'));
  const branding = project.branding || {};

  const inlineData = (
    '\n  // ── Inlined slide data (bundled from data/slides/*.json — DO NOT EDIT dist.html) ──\n' +
    `  SLIDE_DATA = ${JSON.stringify(slides)};\n` +
    '\n  // ── Inlined client prompt templates (bundled from prompts/client/*.md — DO NOT EDIT dist.html) ──\n' +
    `  NAV_PROMPTS = ${JSON.stringify(navPrompts)};\n` +
    '\n  // ── Inlined tool names (bundled from content.mjs — DO NOT EDIT dist.html) ──\n' +
    `  TOOL_NAMES = ${JSON.stringify(toolNames)};\n` +
    '\n  // ── Inlined caption map (bundled from prompts/pronunciation-guide.md — DO NOT EDIT dist.html) ──\n' +
    `  CAPTION_MAP = ${JSON.stringify(captionMap)};\n` +
    '\n  // ── Inlined branding override (bundled from project.json branding — DO NOT EDIT dist.html) ──\n' +
    `  BRANDING = Object.assign({}, BRANDING, ${JSON.stringify(branding)});\n`
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
    });
    bundledJs = built.outputFiles[0].text;
  } finally {
    unlinkSync(tmpEntry);
  }

  // ── Inline logo.svg as a data URI ──
  const logoPath = resolve(clientDir, 'assets', 'logo.svg');
  if (existsSync(logoPath)) {
    const logoSvg = readFileSync(logoPath, 'utf8').trim();
    const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(logoSvg, 'utf8').toString('base64')}`;
    html = html.replaceAll('./assets/logo.svg', logoDataUri);
  }

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
  if (html.includes('fetch(./data/slides') || html.includes("fetch('./data/slides")) errors.push('fetch() calls remain — slide data was not properly inlined');
  if (html.includes('fetch(./prompts/client') || html.includes("fetch('./prompts/client")) errors.push('fetch() calls remain — client prompt templates were not properly inlined');
  if (!html.includes('SLIDE_DATA')) errors.push('SLIDE_DATA not found in output — slide inlining failed');
  if (!html.includes('NAV_PROMPTS')) errors.push('NAV_PROMPTS not found in output — prompt template inlining failed');
  if (!html.includes('TOOL_NAMES')) errors.push('TOOL_NAMES not found in output — tool name inlining failed');
  if (!html.includes(toolNames.nav)) errors.push('the navigation tool name was not baked into the bundled output');
  for (const cdn of ['pdf.js', 'socket.io']) {
    if (!html.includes(cdn)) errors.push(`CDN dependency "${cdn}" missing from output`);
  }
  if (pdfUrl && !html.includes(pdfUrl)) errors.push('pdfUrl was not baked into the bundled output');
  if (widgetId && !html.includes(widgetId)) errors.push('widgetId was not baked into the bundled output');
  if (errors.length) throw new Error(`Bundle validation failed, dist.html not written:\n  ${errors.join('\n  ')}`);

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
    progress(flags, `Bundled ${distPath} — v${version} (${html.length.toLocaleString()} bytes, ${slideCount} slides inlined)`);
    result(flags, { version, distPath, bytes: html.length, slideCount });
  } catch (err) {
    fail(flags, EXIT.VALIDATION, `Bundle failed: ${err.message}`);
  }
}

runMain(main);
