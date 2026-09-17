import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { serveDir } from './e2e/static-server.mjs';

// fetch()/the WHATWG URL parser normalize ".." out of a path before the request
// is ever sent, so a real traversal attempt never reaches the server that way.
// http.request()'s `path` is sent verbatim on the request line, which is what
// an actual attacker (or a raw HTTP client) can do.
function rawGet(port, path) {
  return new Promise((resolvePromise, reject) => {
    request({ host: 'localhost', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    })
      .on('error', reject)
      .end();
  });
}

test('serveDir rejects a raw request path that resolves outside the served directory', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'static-server-test-'));
  writeFileSync(resolve(dir, 'dist.html'), '<p>ok</p>');
  const secretDir = mkdtempSync(resolve(tmpdir(), 'static-server-secret-'));
  writeFileSync(resolve(secretDir, 'secret.txt'), 'top secret');

  const port = 4174;
  const server = await serveDir(dir, port);
  try {
    const traversalPath = `/../${secretDir.split('/').pop()}/secret.txt`;
    const traversal = await rawGet(port, traversalPath);
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.body, /top secret/);

    const legit = await rawGet(port, '/dist.html');
    assert.equal(legit.status, 200);
    assert.equal(legit.body, '<p>ok</p>');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
});
