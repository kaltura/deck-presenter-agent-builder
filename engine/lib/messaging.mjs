/**
 * Client for the classic Kaltura Messaging API — separate infrastructure
 * from the agentic Management API the rest of the engine talks to. Used
 * only by update-followup.mjs, for the branded email template that backs
 * `sendInsightEmail` (docs/implementation-appendix.md, "The email template").
 */

/**
 * No generic default exists: the Messaging API's host is a per-account
 * cluster assignment, not a shared endpoint. Must be set via
 * KALTURA_MESSAGING_URL whenever features.followUpEmail is on.
 */
export function messagingBaseUrl(creds) {
  if (!creds.messagingUrl) {
    throw new Error('KALTURA_MESSAGING_URL is not set. Ask your Kaltura account contact for this account\'s Messaging API base URL and set it in .env.');
  }
  return creds.messagingUrl;
}

/**
 * The classic Messaging API needs a classic type-2 KS, not the agentic
 * Management SDK's admin token — the two are different token formats on
 * different hosts. Minted directly against api_v3, same as any legacy
 * Kaltura client. `serviceUrl` is the same api_v3 base engine/lib/kaltura.mjs
 * passes as ovpUrl (it already ends in /api_v3), not just a bare host.
 */
export async function mintClassicKs(partnerId, adminSecret, serviceUrl) {
  const base = serviceUrl || 'https://cdnapisec.kaltura.com/api_v3';
  const form = new URLSearchParams({
    partnerId: String(partnerId),
    secret: adminSecret,
    type: '2',
    privileges: 'disableentitlement',
    format: '1',
  });
  const resp = await fetch(`${base}/service/session/action/start`, { method: 'POST', body: form });
  const text = (await resp.text()).trim().replace(/^"|"$/g, '');
  if (!text || text.length < 50 || text.startsWith('<') || text.startsWith('{')) {
    throw new Error(`Failed to mint a classic session key: ${text.slice(0, 200)}`);
  }
  return text;
}

export async function messagingApi(baseUrl, action, body, ks) {
  const resp = await fetch(`${baseUrl}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ks}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (resp.status !== 200) {
    throw new Error(`${action} failed (${resp.status}): ${String(text).slice(0, 500)}`);
  }
  return json;
}
