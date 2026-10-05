import fs from 'fs';
import path from 'path';
import { getMeta, playerWarnings, detectExporter } from '../parse.mjs';
const dir = 'C:/GitRepos/mhq-parser/archive/events';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const rows = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const p of (j.players || [])) {
    let meta;
    try { meta = getMeta(p); } catch (e) { meta = { detachment: null, forceDisposition: null }; }
    let warns;
    try { warns = playerWarnings(p, meta).map(w => w.type); } catch (e) { warns = ['ERR']; }
    const body = (p.bodyText || '').replace(/\r\n?/g, '\n');
    rows.push({
      f,
      exporter: detectExporter(body).id,
      name: p.name,
      faction: p.faction,
      det: meta.detachment,
      disp: meta.forceDisposition,
      noDet: !meta.detachment,
      noDisp: !meta.forceDisposition,
      noFac: !p.faction || /^null$/i.test(String(p.faction)),
      units: (p.units || []).length,
      body,
    });
  }
}
const tally = (a, k) => { const m = new Map(); for (const x of a) m.set(k(x), (m.get(k(x)) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1]); };
const N = rows.length;
console.log('players', N);
console.log('no detachment:', rows.filter(r => r.noDet).length);
console.log('no force disposition:', rows.filter(r => r.noDisp).length);
console.log('no faction:', rows.filter(r => r.noFac).length);
console.log('\n=== missing detachment by exporter ===');
for (const [k, v] of tally(rows.filter(r => r.noDet), r => r.exporter)) console.log(String(v).padStart(6), k, '(' + (100 * v / rows.filter(r => r.exporter === k).length).toFixed(0) + '% of ' + rows.filter(r => r.exporter === k).length + ')');
console.log('\n=== missing disposition by exporter ===');
for (const [k, v] of tally(rows.filter(r => r.noDisp), r => r.exporter)) console.log(String(v).padStart(6), k, '(' + (100 * v / rows.filter(r => r.exporter === k).length).toFixed(0) + '% of ' + rows.filter(r => r.exporter === k).length + ')');
console.log('\n=== missing faction by exporter ===');
for (const [k, v] of tally(rows.filter(r => r.noFac), r => r.exporter)) console.log(String(v).padStart(6), k, '(' + (100 * v / rows.filter(r => r.exporter === k).length).toFixed(0) + '%)');
fs.writeFileSync('C:/GitRepos/mhq-parser/.scratch/meta-rows.json', JSON.stringify(rows));
console.log('\nrows written');
