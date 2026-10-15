import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// The one-shot download: the whole wiki, delivered pages only, as one ZIP a phone
// can save once and open at a table with no network.
//
// The manifest is the render's own map.json - the delivered set, the same file
// the server's /wiki routing and the prune sweep treat as the truth - plus the
// handful of navigation assets a page needs to work offline. isDelivered is the
// single predicate upstream; this module never re-derives it and never invents a
// page list. A record the tree filtered has no page in the render dir and no
// entry here.
//
// Deflate ZIP (method 8) via node's zlib: the pages compress about 4:1, which is
// the difference between a 48 MB download and a 12 MB one on a phone at 1.5 Mbps.
// A stored entry is used when deflating would grow it. The archive is built once
// and cached by the caller.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The assets that make the archive navigable offline. The record pages carry
// RELATIVE refs (shell.css, shell.js, tree/index.js), so these names must sit at
// the archive root beside them.
// home.html is the wiki's own front page (the server prefers it to index.html);
// index.html is the developer index, kept so offline links to it do not 404. The
// search and anomaly dev surfaces are deliberately not shipped.
export const ARCHIVE_ASSETS = ['home.html', 'index.html', 'shell.js', 'shell.css', 'wiki.css', 'card.css', 'shell-data.js', 'map.json', 'legacy.json'];
export const ARCHIVE_DIRS = ['tree'];

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
}

// Exactly what goes in: the pages map.json names, plus the assets and the tree
// data, sorted and deduped. Anything the render does not hold is a no-op.
export function archiveFileList(renderDir) {
  const dir = renderDir || path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), 'workspace', 'wiki-render');
  const mapPath = path.join(dir, 'map.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const files = new Set(Object.values(map));
  for (const a of ARCHIVE_ASSETS) if (fs.existsSync(path.join(dir, a))) files.add(a);
  for (const d of ARCHIVE_DIRS) if (fs.existsSync(path.join(dir, d))) walk(path.join(dir, d), dir, files instanceof Set ? { push: x => files.add(x) } : []);
  // toc-*.js: the legacy two-pane data the wiki page can still read.
  for (const n of fs.readdirSync(dir)) if (/^toc-.*\.js$/.test(n)) files.add(n);
  return { dir, map, files: [...files].sort() };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function dosTime(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
  const day = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { t, day };
}

// Store-only ZIP, names forward-slashed, UTF-8 flag set.
export function zipStore(entries, now) {
  const when = now || new Date();
  const { t, day } = dosTime(when);
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    let method = 8, body = zlib.deflateRawSync(data, { level: 6 });
    if (body.length >= data.length) { method = 0; body = data; }
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(t), u16(day),
      u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    locals.push(local, body);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(t), u16(day),
      u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), name,
    ]));
    offset += local.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([Buffer.concat(locals), central, eocd]);
}

// The reader the tests use to prove what went in, without trusting the writer.
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const rawSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
    const dataStart = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.slice(dataStart, dataStart + size);
    out.push({ name, size: rawSize, method, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function buildWikiArchive(renderDir) {
  const list = archiveFileList(renderDir);
  const entries = [];
  let bytes = 0;
  for (const name of list.files) {
    const p = path.join(list.dir, name);
    const data = fs.readFileSync(p);
    entries.push({ name, data });
    bytes += data.length;
  }
  const zip = zipStore(entries);
  return { zip, files: list.files, pages: Object.values(list.map), bytes, pagesCount: Object.keys(list.map).length };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'wiki-archive.mjs') {
  const a = buildWikiArchive();
  console.log('archive: ' + a.files.length + ' files (' + a.pagesCount + ' pages), ' + (a.bytes / 1048576).toFixed(1) + ' MB raw -> ' + (a.zip.length / 1048576).toFixed(1) + ' MB zip');
}
