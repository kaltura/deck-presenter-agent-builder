import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminKs, ADMIN_USER_ID } from '../engine/lib/kaltura.mjs';

test('adminKs passes a userId, which SDK 1.25+ requires on admin tokens', async () => {
  let seen;
  const mgmt = { sessions: { createAdminToken: async (opts) => ((seen = opts), { ks: 'ks-value' }) } };
  assert.equal(await adminKs(mgmt), 'ks-value');
  assert.deepEqual(seen, { userId: ADMIN_USER_ID });
  assert.ok(ADMIN_USER_ID.trim().length > 0);
});

test('the installed SDK rejects an admin token without a userId before any request', async () => {
  const { Management } = await import('@kaltura/intelligent-agents/management');
  const mgmt = new Management({ partnerId: 1, adminSecret: 'x' });
  await assert.rejects(() => mgmt.sessions.createAdminToken(), (err) => err.code === 'bad_request');
});
