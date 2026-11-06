// Zero-dependency static server for the autofill test corpus.
//   node server.mjs                     listens on 127.0.0.1:8101 and :8102
//   PW_SITES_PORTS=9101,9102 node server.mjs
// a.localhost, b.localhost, other.localhost and localhost all reach it, because
// browsers resolve *.localhost to loopback. The Host header is never checked.
//
// HTML responses get two tokens replaced so iframe fixtures survive a port override:
//   __PORT__        the port this request came in on
//   __OTHER_PORT__  the other configured port

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SERVED = ['fixtures', 'lib'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function configuredPorts() {
  const raw = process.env.PW_SITES_PORTS || '8101,8102';
  const ports = raw.split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0);
  if (ports.length < 2) throw new Error(`PW_SITES_PORTS needs two ports, got "${raw}"`);
  return ports;
}

async function indexPage() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const rows = manifest
    .map((f) => `<li><a href="${f.path}">${f.id}</a> ${f.description.replace(/</g, '&lt;')}</li>`)
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Autofill test sites</title><link rel="icon" href="data:,"><h1>Autofill test sites (${manifest.length})</h1><ul>${rows}</ul>`;
}

function handlerFor(ports) {
  return async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'method not allowed');

      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/') return send(200, TYPES['.html'], await indexPage());

      const rel = normalize(pathname).replace(/^[/\\]+/, '');
      const top = rel.split(sep)[0];
      if (!SERVED.includes(top) || rel.split(sep).includes('..')) return send(404, 'text/plain; charset=utf-8', 'not found');

      const file = join(ROOT, rel);
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) return send(404, 'text/plain; charset=utf-8', 'not found');

      const ext = extname(file).toLowerCase();
      const type = TYPES[ext] || 'application/octet-stream';
      if (ext === '.html') {
        const port = req.socket.localPort;
        const other = ports.find((p) => p !== port) ?? port;
        const html = (await readFile(file, 'utf8')).replaceAll('__OTHER_PORT__', String(other)).replaceAll('__PORT__', String(port));
        return send(200, type, html);
      }
      return send(200, type, await readFile(file));
    } catch (err) {
      return send(500, 'text/plain; charset=utf-8', String(err && err.message));
    }
  };
}

/** Starts listening on every configured port. Resolves to `{ close, ports }`. */
export async function start(ports = configuredPorts()) {
  const handler = handlerFor(ports);
  const servers = await Promise.all(
    ports.map(
      (port) =>
        new Promise((resolve, reject) => {
          const s = createServer(handler);
          s.once('error', reject);
          s.listen(port, '127.0.0.1', () => resolve(s));
        }),
    ),
  );
  return {
    ports,
    close: () =>
      Promise.all(
        servers.map(
          (s) =>
            new Promise((resolve) => {
              s.close(resolve);
              s.closeAllConnections?.();
            }),
        ),
      ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ports } = await start();
  console.log(`test sites on http://localhost:${ports.join(', http://localhost:')}`);
}
