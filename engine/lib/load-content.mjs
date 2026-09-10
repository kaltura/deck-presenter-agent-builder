import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Every deck-specific value comes from the project's own content.mjs, never
 * from engine code. Loaded dynamically because the project root is a CLI
 * argument, not known until runtime.
 */
export async function loadContent(projectRoot) {
  const p = resolve(projectRoot, 'content.mjs');
  if (!existsSync(p)) {
    throw new Error(
      `content.mjs not found at ${p}. A project directory needs its own content.mjs, prompts/, and data/ before the engine can run against it.`,
    );
  }
  return import(pathToFileURL(p).href);
}
