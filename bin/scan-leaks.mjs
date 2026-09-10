#!/usr/bin/env node
/**
 * Scan every file git would publish for credentials, account ids, and local paths.
 *
 * Scans `git ls-files` output only, so anything gitignored is out of scope by
 * construction. Run it before every commit and in CI.
 *
 * Patterns here are structural and safe to publish. To also block an exact list
 * of known strings, put one per line in `.blocked-strings.local.txt`, which is
 * gitignored. CI runs without that file and still catches every shape below.
 *
 * Exit codes: 0 clean, 1 unexpected error, 4 findings.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_LIST = '.blocked-strings.local.txt';

/** Files whose content is never scanned. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.mp4', '.webm', '.mp3', '.wav', '.zip', '.gz',
]);

/** This file names the patterns it looks for, so scanning it self-reports. */
const SKIP_PATH = new Set(['bin/scan-leaks.mjs']);

/**
 * Files that must contain synthetic leak samples to do their job. Structural
 * rules are skipped for these, but the blocked-literal check still runs, so a
 * real account id or product name cannot hide here.
 */
const LITERALS_ONLY = new Set(['test/scan-leaks.test.mjs']);

export const RULES = [
  {
    id: 'kaltura-entry-id',
    why: 'Kaltura entry id. Use a placeholder.',
    re: /\b\d_[a-z0-9]{8}\b/g,
  },
  {
    id: 'kaltura-object-id',
    why: 'Kaltura object id (24-char hex). Use a placeholder.',
    re: /\b[0-9a-f]{24}\b/g,
  },
  {
    id: 'uuid',
    why: 'A UUID. If it identifies an account object, use a placeholder.',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    id: 'partner-id',
    why: 'A partner id looks assigned here. Read it from the environment.',
    re: /\b(?:partner_?id|partnerId|PARTNER_ID)\s*[:=]\s*['"]?\d{5,}/g,
  },
  {
    id: 'admin-secret',
    why: 'A secret looks assigned here. Read it from the environment.',
    re: /\b(?:admin_?secret|adminSecret|ADMIN_SECRET|secret|apiKey|api_key|password|token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{12,}['"]/g,
  },
  {
    id: 'kaltura-session',
    why: 'A Kaltura session string. Never commit one.',
    re: /\bdjJ8[A-Za-z0-9+/=_-]{20,}/g,
  },
  {
    id: 'local-path',
    why: 'An absolute path from a developer machine.',
    re: /\/(?:Users|home|opt\/homebrew)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/g,
  },
  {
    id: 'internal-host',
    why: 'An internal or account-specific hostname.',
    re: /\b[a-z0-9-]+\.(?:nvp\d+|ovp)\.[a-z0-9-]+\.[a-z]{2,}\b/g,
  },
  {
    id: 'email',
    why: 'A real email address. Use example.com.',
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

/** Literal strings that are fine anywhere, keyed by rule id. */
const ALLOW = {
  'kaltura-object-id': [],
  uuid: ['00000000-0000-0000-0000-000000000000'],
  // git@host is an SSH protocol string in a lockfile URL, not a contact.
  email: ['you@example.com', 'security@example.com', 'git@github.com', 'git@gitlab.com'],
  'local-path': ['/opt/homebrew/bin/node'],
};

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/**
 * Read the gitignored literal list. Each literal is matched case-insensitively
 * on word boundaries, so "AWS" does not fire inside "laws" and "CLI" does not
 * fire inside "client".
 */
export function compileLiterals(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((literal) => {
      const body = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lead = /^\w/.test(literal) ? '\\b' : '';
      const tail = /\w$/.test(literal) ? '\\b' : '';
      return { literal, re: new RegExp(`${lead}${body}${tail}`, 'i') };
    });
}

function localLiterals() {
  if (!existsSync(LOCAL_LIST)) return [];
  return compileLiterals(readFileSync(LOCAL_LIST, 'utf8'));
}

/**
 * Scan one file's text. Pure, so it is directly testable.
 * Set `literalsOnly` to skip the structural rules and check literals alone.
 */
export function scanText(path, text, literals = [], literalsOnly = false) {
  if (text.includes('\0')) return []; // binary

  const findings = [];
  const lines = text.split('\n');

  for (const rule of literalsOnly ? [] : RULES) {
    const allow = ALLOW[rule.id] ?? [];
    lines.forEach((line, i) => {
      for (const hit of line.matchAll(rule.re)) {
        if (allow.includes(hit[0])) continue;
        findings.push({ path, line: i + 1, rule: rule.id, why: rule.why, hit: hit[0] });
      }
    });
  }

  for (const { literal, re } of literals) {
    lines.forEach((line, i) => {
      if (re.test(line)) {
        findings.push({
          path,
          line: i + 1,
          rule: 'blocked-literal',
          why: 'On the local blocked-strings list.',
          hit: literal,
        });
      }
      re.lastIndex = 0;
    });
  }

  return findings;
}

function scanFile(path, literals) {
  if (SKIP_PATH.has(path)) return [];
  if (SKIP_EXT.has(extname(path).toLowerCase())) return [];
  try {
    return scanText(path, readFileSync(path, 'utf8'), literals, LITERALS_ONLY.has(path));
  } catch {
    return [];
  }
}

function main() {
  const asJson = process.argv.includes('--json');
  const literals = localLiterals();
  const files = trackedFiles();
  const findings = files.flatMap((f) => scanFile(f, literals));

  if (asJson) {
    console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
  } else if (findings.length === 0) {
    const extra = literals.length ? ` and ${literals.length} local literals` : '';
    console.log(`scan-leaks: clean. ${files.length} tracked files, ${RULES.length} rules${extra}.`);
  } else {
    console.error(`scan-leaks: ${findings.length} finding(s) in ${files.length} tracked files.\n`);
    for (const f of findings) {
      console.error(`  ${f.path}:${f.line}  [${f.rule}]  ${f.hit}`);
      console.error(`    ${f.why}`);
    }
    console.error('\nRemove each one, or add a placeholder. Nothing here may reach a public commit.');
  }

  process.exit(findings.length ? 4 : 0);
}

// Run only when invoked directly, so tests can import the rules.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`scan-leaks: ${err.message}`);
    process.exit(1);
  }
}
