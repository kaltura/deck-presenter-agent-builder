import { resolve } from 'node:path';

/** Exit codes shared by every engine command. See CLAUDE.md's CLI contract. */
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  CREDENTIAL: 3,
  VALIDATION: 4,
  PROVISIONING: 5,
};

/**
 * Thrown instead of calling process.exit() directly. When stdout/stderr are
 * pipes (any non-TTY caller: CI, execFileSync, `| cat`), Node writes to them
 * asynchronously — process.exit() can turn off the process before those
 * writes flush, silently dropping the very plan/error text a script or CI
 * step needs to see. Setting process.exitCode and letting the call stack
 * unwind naturally lets pending writes drain before the process exits.
 */
export class CliExit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function exitNow(code) {
  process.exitCode = code;
  throw new CliExit(code);
}

/** Wrap a script's main() call: swallows CliExit (exit code already set), reports anything else as EXIT.UNEXPECTED. */
export function runMain(main) {
  main().catch((err) => {
    if (err instanceof CliExit) return;
    console.error(err?.stack || err);
    process.exitCode = EXIT.UNEXPECTED;
  });
}

export function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

export function projectRootFrom(flags) {
  if (!flags.project) {
    console.error('Usage: --project <path> is required.');
    exitNow(EXIT.USAGE);
  }
  return resolve(String(flags.project));
}

/** Progress goes to stderr always, so --json keeps stdout as pure result data. */
export function progress(flags, ...args) {
  console.error(...args);
}

export function result(flags, data) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }
}

/**
 * The single confirmation gate for every mutating call in the engine.
 * `--dry-run` prints the plan and exits 0 before any mutation.
 * `--yes` / `--no-input` skip the interactive prompt.
 * A non-interactive stream with neither flag refuses rather than hanging.
 */
export async function confirmPlan(flags, planLines) {
  for (const line of planLines) progress(flags, line);

  if (flags['dry-run']) {
    progress(flags, '\nDry run: no network mutation performed.');
    exitNow(EXIT.OK);
  }

  if (flags.yes || flags['no-input']) return;

  if (!process.stdin.isTTY) {
    progress(flags, '\nRefusing to prompt on a non-interactive stream. Pass --yes to proceed.');
    exitNow(EXIT.USAGE);
  }

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let answer;
  try {
    answer = await rl.question('\nProceed? [y/N] ');
  } finally {
    rl.close();
  }
  if (!/^y(es)?$/i.test(answer.trim())) {
    progress(flags, 'Aborted. No mutation performed.');
    exitNow(EXIT.OK);
  }
}

export function fail(flags, code, message) {
  console.error(message);
  exitNow(code);
}
