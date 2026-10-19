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

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  // Short paths for the phone: /j is the chooser, /j1../j3 the arms. / stays the
  // door mockup it has always been.
  const short = { '/j': 'judge.html', '/j1': 'j1.html', '/j2': 'j2.html', '/j3': 'j3.html' };
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
