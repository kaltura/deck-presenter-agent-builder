import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Parse a dotenv-style file. No interpolation, no export keyword, no quoting rules beyond strip. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * A bare host ("https://cdnapisec.kaltura.com") gets the /api_v3 path the SDK
 * needs. Without it, every call returns an HTML 404. A URL with a path is kept.
 */
export function normalizeServiceUrl(url) {
  const trimmed = url.replace(/\/+$/, '');
  return /^https?:\/\/[^/]+$/i.test(trimmed) ? `${trimmed}/api_v3` : trimmed;
}

/**
 * Credentials always resolve relative to the project root passed on the CLI,
 * never to this file's own install location.
 */
export function loadCredentials(projectRoot) {
  const envPath = resolve(projectRoot, '.env');
  const fromFile = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  // The project's own .env wins over the ambient shell environment. A project
  // directory must be self-contained: an unrelated KALTURA_* var exported in
  // the caller's shell must never silently redirect which account a command
  // talks to.
  const get = (key) => fromFile[key] ?? process.env[key];

  const partnerId = get('KALTURA_PARTNER_ID');
  const adminSecret = get('KALTURA_ADMIN_SECRET');
  const serviceUrl = normalizeServiceUrl(get('KALTURA_SERVICE_URL') || 'https://cdnapisec.kaltura.com/api_v3');
  const messagingUrl = get('KALTURA_MESSAGING_URL') || '';

  const missing = [];
  if (!partnerId) missing.push('KALTURA_PARTNER_ID');
  if (!adminSecret) missing.push('KALTURA_ADMIN_SECRET');
  if (missing.length) return { ok: false, missing, envPath };

  return { ok: true, partnerId: String(partnerId), adminSecret, serviceUrl, messagingUrl, envPath };
}
