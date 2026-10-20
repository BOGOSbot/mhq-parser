// Static server for the findings mockups. Usage: node serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 3001);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml' };

// /api/* is proxied to the app on the same box, so a prototype page here can call
// the real routes without CORS and without touching the app's own server.
const API = process.env.MOCK_API || 'http://127.0.0.1:3000';
function proxy(req, res) {
  const target = new URL(String(req.url || '/').replace(/^\/api/, ''), API);
  const up = http.request(target, { method: req.method, headers: Object.assign({}, req.headers, { host: target.host }) }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('proxy error: ' + e.message); });
  req.pipe(up);
}

http.createServer((req, res) => {
  if ((req.url || '').indexOf('/api/') === 0) return proxy(req, res);
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  // Short paths for the phone: /j is the chooser, /j1../j3 the arms. / stays the
  // door mockup it has always been.
  const short = { '/j': 'judge.html', '/j1': 'j1.html', '/j2': 'j2.html', '/j3': 'j3.html', '/j4': 'j4.html', '/deep': 'deep.html' };
  const rel = url === '/' ? 'a.html' : (short[url.replace(/\/+$/, '')] || url.replace(/^\/+/, ''));
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '0.0.0.0', () => console.log('mockups on http://0.0.0.0:' + port));
