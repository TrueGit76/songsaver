// Minimaler statischer Server für die lokale Entwicklung: npm start [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Qobuz sendet keine CORS-Header, daher reicht der Server die zwei benötigten Seiten (nur lesend) durch.
const QOBUZ_PATH = /^\/proxy\/qobuz\/((?:[a-z]{2}-[a-z]{2}\/search\/tracks\/[^/]+)|(?:v4\/ajax\/popin-add-cart\/track\/\d+))$/;

async function proxyQobuz(upstreamPath, res) {
  try {
    const up = await fetch(`https://www.qobuz.com/${upstreamPath}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)', 'accept-language': 'de-DE,de;q=0.9', 'x-requested-with': 'XMLHttpRequest' },
    });
    res.writeHead(up.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await up.text());
  } catch {
    res.writeHead(502).end('Qobuz nicht erreichbar');
  }
}

export function serve(port = 8080) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname.startsWith('/proxy/qobuz/')) {
      const m = req.method === 'GET' && pathname.match(QOBUZ_PATH);
      if (m) await proxyQobuz(m[1], res);
      else res.writeHead(404).end('Nicht gefunden');
      return;
    }
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': `${TYPES[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
      res.end(body);
    } catch {
      res.writeHead(404).end('Nicht gefunden');
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8080);
  await serve(port);
  console.log(`Songsaver läuft auf http://localhost:${port}`);
}
