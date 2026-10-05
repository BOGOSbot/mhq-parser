import fs from 'fs';
const rows = JSON.parse(fs.readFileSync('C:/GitRepos/mhq-parser/.scratch/meta-rows.json', 'utf8'));
const DISP = /(?:Reconnaissance|Take and Hold|Prendre et Tenir|Priority Assets|Atouts Prioritaires|Purge the Foe|Prey in Ambush|Disruption|Perturbation|Encirclement|Emprise|Scorched Earth|Terre Br[ûu]l[ée]e|Search and Destroy|Recherche et Destruction|Assassination|Assassinat|Behind Enemy Lines|Derri[èe]re les Lignes|Bring it Down|Abattez-le|Engage on All Fronts|Domination|Raise the Banners|D[ée]ploiement des Banni[èe]res|Extraction|Sabotage|Fortify|Retenue|Martial|Meatgrinder|Horde|Unstoppable|Vital Ground|Recon)/i;
const withDisp = rows.filter(r => DISP.test(r.body));
console.log('bodies naming a disposition:', withDisp.length, '/', rows.length);
console.log('  of those, captured by getMeta:', withDisp.filter(r => !r.noDisp).length);
console.log('  of those, MISSED by getMeta:', withDisp.filter(r => r.noDisp).length);
const missed = withDisp.filter(r => r.noDisp);
// where does the disposition live? print the matching line(s)
const lines = new Map();
for (const r of missed) {
  const ls = r.body.split('\n').map(s => s.trim()).filter(Boolean);
  for (const l of ls.slice(0, 30)) {
    if (!DISP.test(l)) continue;
    const norm = l.replace(/\d+/g, '#').slice(0, 90);
    if (!lines.has(norm)) lines.set(norm, { n: 0, ex: r });
    lines.get(norm).n++;
    break;
  }
}
console.log('\nmissed disposition lines (top 40):');
for (const [k, v] of [...lines].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) console.log(String(v.n).padStart(5), JSON.stringify(k));
// how many of the "captured" ones, and how does the line look
console.log('\nsanity: captured disposition samples');
const cap = withDisp.filter(r => !r.noDisp);
for (const r of cap.slice(0, 3)) console.log('  ', JSON.stringify(r.disp), '|', JSON.stringify(r.body.split('\n').map(s=>s.trim()).filter(Boolean).slice(0,6)));
// genuine absence check: missing disposition AND no disposition token anywhere
console.log('\nmissing disposition and text has NO disposition token:', rows.filter(r => r.noDisp && !DISP.test(r.body)).length);
console.log('missing disposition but text HAS a disposition token:', missed.length);
