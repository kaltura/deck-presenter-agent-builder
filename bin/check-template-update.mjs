#!/usr/bin/env node
/**
 * Read-only staleness check (PLAN.md 12): does this project's engine/ (as
 * scripts/) and client/ still match the toolkit commit it was scaffolded
 * from? Lists what changed upstream since; never writes to the project.
 *
 * Usage: node bin/check-template-update.mjs --project <path> [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseFlags, projectRootFrom, progress, result, fail, EXIT, runMain } from '../engine/lib/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = resolve(__dirname, '..');

function git(args) {
  return execFileSync('git', ['-C', TOOLKIT_ROOT, ...args], { encoding: 'utf8' }).trim();
}

function refExists(ref) {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function toProjectPath(toolkitRelativePath) {
  if (toolkitRelativePath.startsWith('engine/')) return 'scripts/' + toolkitRelativePath.slice('engine/'.length);
  return toolkitRelativePath;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectRoot = projectRootFrom(flags);
  const versionFile = resolve(projectRoot, '.template-version');
  if (!existsSync(versionFile)) {
    fail(flags, EXIT.USAGE, `No .template-version at ${versionFile}. This does not look like a project scaffolded by create-project.mjs.`);
  }
  const projectVersion = readFileSync(versionFile, 'utf8').trim();

  let currentVersion;
  try {
    currentVersion = git(['rev-parse', 'HEAD']);
  } catch {
    fail(flags, EXIT.UNEXPECTED, `${TOOLKIT_ROOT} is not a git checkout of the toolkit; cannot resolve its current version.`);
  }

  if (projectVersion === 'unknown') {
    progress(flags, 'This project was scaffolded from a toolkit checkout with no git history, so its template version is unknown.');
    result(flags, { upToDate: null, projectVersion, currentVersion, changedFiles: [] });
    return;
  }

  if (projectVersion === currentVersion) {
    progress(flags, 'Up to date: this project was scaffolded from the toolkit\'s current commit.');
    result(flags, { upToDate: true, projectVersion, currentVersion, changedFiles: [] });
    return;
  }

  if (!refExists(projectVersion)) {
    progress(
      flags,
      `Cannot diff: commit ${projectVersion} (this project's scaffold version) is not present in this toolkit checkout's history. ` +
        'A shallow clone or a tarball install loses this. Fetch full history to compare.',
    );
    result(flags, { upToDate: null, projectVersion, currentVersion, changedFiles: [] });
    return;
  }

  const diffOutput = git(['diff', '--name-status', projectVersion, currentVersion, '--', 'engine/', 'client/']);
  const changedFiles = diffOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split('\t');
      const toolkitPath = pathParts[pathParts.length - 1];
      return { status, toolkitPath, projectPath: toProjectPath(toolkitPath) };
    });

  if (!changedFiles.length) {
    progress(flags, 'Up to date: no engine/ or client/ changes upstream since this project was scaffolded.');
    result(flags, { upToDate: true, projectVersion, currentVersion, changedFiles: [] });
    return;
  }

  progress(flags, `${changedFiles.length} file(s) changed upstream in engine/ or client/ since this project was scaffolded (${projectVersion} -> ${currentVersion}):`);
  for (const f of changedFiles) progress(flags, `  ${f.status}\t${f.projectPath}`);
  progress(flags, '\nThis is informational only. Review each file and port the change into this project\'s own copy by hand.');
  result(flags, { upToDate: false, projectVersion, currentVersion, changedFiles });
}

runMain(main);
