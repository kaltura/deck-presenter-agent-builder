#!/usr/bin/env node
/**
 * Read-only. Drives the project's own dist.html with a real browser through
 * welcome -> disclaimer acknowledge -> greeting -> a typed "continue" ->
 * first reply, and checks two startup-latency budgets against the median of
 * several runs: time from clicking start to the greeting appearing, and
 * time from sending a message to the reply appearing.
 *
 * This needs a real deployed widget: the avatar session it drives is live
 * Kaltura infrastructure, not a local mock. Only the http server for
 * dist.html itself is local. Nothing here writes to the Kaltura account.
 *
 * Usage: node engine/verify-startup-timing.mjs --project <path>
 *        [--url <http-url-to-dist.html>] [--runs=3] [--timeout-ms=30000]
 *        [--budget-slack-ms=2000] [--json]
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { parseFlags, projectRootFrom, progress, result, fail, EXIT, runMain } from './lib/cli.mjs';

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const DEFAULT_BUDGETS = {
  // Click "start" to the first avatar chat bubble appearing (session
  // negotiation, opening_phrase spoken and shown).
  greetingMs: 8000,
  // Typed message sent to a second avatar chat bubble appearing (a real
  // model round trip, not just an echo).
  firstReplyMs: 6000,
};

export function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Turns one run's ordered {name, tMs} milestones into the named intervals budgets are checked against. */
export function computeIntervals(milestones) {
  const at = (name) => milestones.find((m) => m.name === name)?.tMs;
  const sessionStart = at('sessionStart');
  const greeting = at('greeting');
  const typedContinue = at('typedContinue');
  const firstReply = at('firstReply');
  if ([sessionStart, greeting, typedContinue, firstReply].some((v) => v == null)) {
    throw new Error('Missing milestone(s); every run must record sessionStart, greeting, typedContinue, and firstReply.');
  }
  return { greetingMs: greeting - sessionStart, firstReplyMs: firstReply - typedContinue };
}

/** Pure budget check: median of each named interval across runs, against budgets + slack. */
export function checkBudgets(intervalsPerRun, budgets = DEFAULT_BUDGETS, slackMs = 0) {
  const names = Object.keys(budgets);
  const medians = {};
  const failures = [];
  for (const name of names) {
    const m = median(intervalsPerRun.map((r) => r[name]));
    medians[name] = m;
    if (m > budgets[name] + slackMs) failures.push({ name, medianMs: m, budgetMs: budgets[name] });
  }
  return { ok: failures.length === 0, medians, failures };
}

function serveDistHtml(distDir) {
  const root = resolve(distDir);
  const server = createServer(async (req, res) => {
    const url = req.url === '/' ? '/dist.html' : req.url;
    const path = url.split('?')[0];
    const resolved = resolve(root, `.${path}`);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const body = await readFile(resolved);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((res) => server.listen(0, () => res(server)));
}

async function runOnce(url, timeoutMs) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const t0 = Date.now();
    const milestones = [{ name: 'pageLoad', tMs: 0 }];
    await page.goto(url, { timeout: timeoutMs });
    await page.click('#btn-continue', { timeout: timeoutMs });
    milestones.push({ name: 'disclaimerAck', tMs: Date.now() - t0 });
    await page.click('#btn-start', { timeout: timeoutMs });
    milestones.push({ name: 'sessionStart', tMs: Date.now() - t0 });
    await page.waitForSelector('#chat-log .chat-msg-avatar', { timeout: timeoutMs });
    milestones.push({ name: 'greeting', tMs: Date.now() - t0 });
    await page.fill('#chat-input', 'continue');
    await page.press('#chat-input', 'Enter');
    milestones.push({ name: 'typedContinue', tMs: Date.now() - t0 });
    await page.waitForFunction(
      () => document.querySelectorAll('#chat-log .chat-msg-avatar').length > 1,
      null,
      { timeout: timeoutMs },
    );
    milestones.push({ name: 'firstReply', tMs: Date.now() - t0 });
    return milestones;
  } finally {
    await browser.close();
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const runs = flags.runs ? Number(flags.runs) : 3;
  const timeoutMs = flags['timeout-ms'] ? Number(flags['timeout-ms']) : 30000;
  const slackMs = flags['budget-slack-ms'] ? Number(flags['budget-slack-ms']) : 2000;

  let server = null;
  let url = flags.url;
  if (!url) {
    const distPath = resolve(projectRoot, 'dist.html');
    if (!existsSync(distPath)) fail(flags, EXIT.USAGE, `No dist.html at ${distPath}. Run engine/bundle.mjs first, or pass --url.`);
    server = await serveDistHtml(projectRoot);
    url = `http://localhost:${server.address().port}/dist.html`;
  }

  progress(flags, `Running ${runs} pass(es) against ${url}...`);
  const intervalsPerRun = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      progress(flags, `[run ${i + 1}/${runs}] starting...`);
      const milestones = await runOnce(url, timeoutMs);
      const intervals = computeIntervals(milestones);
      intervalsPerRun.push(intervals);
      progress(flags, `[run ${i + 1}/${runs}] greeting ${intervals.greetingMs}ms, first reply ${intervals.firstReplyMs}ms`);
    }
  } finally {
    if (server) server.close();
  }

  const { ok, medians, failures } = checkBudgets(intervalsPerRun, DEFAULT_BUDGETS, slackMs);

  const outDir = resolve(projectRoot, 'docs/timing-runs');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify({ url, runs, budgets: DEFAULT_BUDGETS, slackMs, intervalsPerRun, medians, ok, failures }, null, 2) + '\n');
  progress(flags, `Wrote ${outPath}`);

  if (!ok) {
    progress(flags, `Budget check FAILED: ${failures.map((f) => `${f.name} median ${f.medianMs}ms > budget ${f.budgetMs}ms (+${slackMs}ms slack)`).join('; ')}`);
    result(flags, { ok: false, medians, failures, outPath });
    process.exitCode = EXIT.VALIDATION;
    return;
  }

  progress(flags, 'Budget check passed.');
  result(flags, { ok: true, medians, outPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main);
