// Tiny static server for the fourth hold-out corpus. One port on 127.0.0.1.
//   node server.mjs                       listens on 127.0.0.1:9140
//   PW_SITES_PORT=9141 node server.mjs    another port
// Exports start(port?), resolving to { close, port }. With no argument it uses PW_SITES_PORT, then 9140.
// Pages reach it as localhost:<port> and also as 127.0.0.1:<port>; the two names are different
// origins to a browser, which the cross-origin frame fixtures rely on.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

async function handler(req, res) {
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') {
      const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
      const rows = manifest.map((m) => `<li><a href="${m.path}">${m.id}</a></li>`).join('');
      return send(200, TYPES['.html'], `<!doctype html><meta charset="utf-8"><title>Hold-out 4</title><link rel="icon" href="data:,"><ul>${rows}</ul>`);
    }
    const rel = normalize(pathname).replace(/^[/\\]+/, '');
    if (rel.split(sep)[0] !== 'fixtures' || rel.split(sep).includes('..')) return send(404, 'text/plain', 'not found');
    const file = join(ROOT, rel);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return send(404, 'text/plain', 'not found');
    return send(200, TYPES[extname(file).toLowerCase()] || 'application/octet-stream', await readFile(file));
  } catch (err) {
    return send(500, 'text/plain', String(err && err.message));
  }
}

export function start(port = Number(process.env.PW_SITES_PORT || 9140)) {
  return new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            s.close(done);
            s.closeAllConnections?.();
          }),
      }),
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await start();
  console.log(`fourth hold-out corpus on http://localhost:${port}/`);
}
