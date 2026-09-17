import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf' };

/**
 * Minimal static file server for one directory, used only to give the E2E
 * suite a real http://localhost origin (getUserMedia/WebRTC need a secure
 * context; file:// does not reliably count as one in Chromium).
 */
export function serveDir(dir, port) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    const url = req.url === '/' ? '/dist.html' : req.url;
    const path = url.split('?')[0];
    const resolved = resolve(root, `.${path}`);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const body = await readFile(resolved);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const port = Number(process.argv[3]);
  await serveDir(dir, port);
  console.log(`serving ${dir} on http://localhost:${port}`);
}
