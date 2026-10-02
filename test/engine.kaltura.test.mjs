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

// connect() is what every engine command calls first. A bad URL in .env is a
// config failure (exit 3), not an unexpected one (exit 1).
test('connect() exits 3 on a service or messaging URL the SDK rejects', async () => {
  const { connect } = await import('../engine/lib/kaltura.mjs');
  const { EXIT } = await import('../engine/lib/cli.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cases = {
    'public http': 'KALTURA_SERVICE_URL=http://api.example.com/api_v3',
    'malformed': 'KALTURA_SERVICE_URL=not a url',
    'credentials in url': `KALTURA_SERVICE_URL=https://user:${'secret'}@${'api.example.com'}/api_v3`,
    'messaging public http': 'KALTURA_MESSAGING_URL=http://msg.example.com',
  };
  const saved = process.exitCode;
  const errs = console.error;
  try {
    for (const [label, line] of Object.entries(cases)) {
      const dir = mkdtempSync(join(tmpdir(), 'kaltura-conn-'));
      writeFileSync(join(dir, '.env'), `KALTURA_PARTNER_ID=1\nKALTURA_ADMIN_SECRET=x\n${line}\n`);
      let msg = '';
      console.error = (m) => { msg += m; };
      try {
        assert.throws(() => connect(dir, {}), (err) => err.constructor.name === 'CliExit', label);
        assert.equal(process.exitCode, EXIT.CREDENTIAL, label);
        assert.match(msg, /Invalid Kaltura setting/, label);
        assert.ok(!msg.includes('secret'), `${label}: message must not echo credentials`);
      } finally {
        console.error = errs;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    process.exitCode = saved;
  }
});
