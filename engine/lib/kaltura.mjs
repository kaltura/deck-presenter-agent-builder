import { Management } from '@kaltura/intelligent-agents/management';
import { loadCredentials } from './env.mjs';
import { EXIT, fail } from './cli.mjs';

/**
 * The single place every engine command builds its Kaltura client and mints
 * an admin session. Exits 3 (credential failure) if `.env` is incomplete.
 */
export function connect(projectRoot, flags) {
  const creds = loadCredentials(projectRoot);
  if (!creds.ok) {
    fail(
      flags,
      EXIT.CREDENTIAL,
      `Missing credential(s): ${creds.missing.join(', ')}. Set them in ${creds.envPath} (see .env.example).`,
    );
  }
  const mgmt = new Management({
    partnerId: creds.partnerId,
    adminSecret: creds.adminSecret,
    ovpUrl: creds.serviceUrl,
    ...(creds.messagingUrl ? { messagingUrl: creds.messagingUrl } : {}),
  });
  return { mgmt, partnerId: creds.partnerId, serviceUrl: creds.serviceUrl };
}

// SDK 1.25+ requires a userId on admin tokens. The server makes it the owner of
// what the session creates, so it is one fixed service id, not a person.
export const ADMIN_USER_ID = 'deck-presenter-agent-builder';

export async function adminKs(mgmt) {
  const { ks } = await mgmt.sessions.createAdminToken({ userId: ADMIN_USER_ID });
  return ks;
}
