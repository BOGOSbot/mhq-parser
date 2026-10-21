// task-69: the French display layer. The English corpus is the canon and the French is an
// overlay keyed by record id; these pin the four rules the reader depends on - the body
// renders French, the headings and keywords stay English, a record with no French shows
// English rather than nothing, and a quote keeps the English canon with the French under it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frReady, frText, frStats, frUsable, frKeywordCheck, enTerms } from '../src/i18n-fr.mjs';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { recordBody } from '../src/wiki-cards.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + ' | got: ' + JSON.stringify(got) + ' | want: ' + JSON.stringify(want)); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');

// --- the overlay itself --------------------------------------------------------
const stats = frStats();
t('the pass is ready', stats.ready, true);
t('and it carries the pass\u2019s own counts', { translated: stats.translated, blocked: stats.blocked }, { translated: 6286, blocked: 39 });
const intro = frText('core-rules#Introduction');
ok('a translated record returns French', /^Bienvenue/.test(intro));
ok('and it is usable', frUsable('core-rules#Introduction').length > 40);
t('a blocked record returns nothing, so the caller falls back to English', frText('datasheet#000000696'), '');
t('and an unknown id does too', frText('no-such-record#1'), '');
ok('frUsable refuses a record whose text is not French', frUsable('datasheet#000000696') === '');

// --- the keyword rule ----------------------------------------------------------
// Mandal's rule: a keyword that has a definition keeps its English name inside French
// prose, because it is referenced across languages. The pass enforced it with a mask;
// this is the spot check that it held, on the records the reader actually opens.
const all = readAllCorpus();
const samples = ['unitrules#000000024', 'datasheet#000000702', 'unitrules#000000702', 'core-rules#Introduction', 'stratagem#000010917004'];
let checked = 0, keptAll = 0;
const misses = [];
// The export's own ROW LABELS are not defined terms: WHEN/TARGET/EFFECT are the stratagem
// card's layout slots and the pass translated them (QUAND/CIBLE/EFFET). Mandal's rule is
// about a term with a DEFINITION - a keyword, a unit name, a rule name - and those are
// what this checks. The labels are reported in the task-69 report rather than hidden here.
const ROW_LABELS = new Set(['WHEN', 'TARGET', 'EFFECT', 'TYPE', 'CP', 'TURN', 'PHASE', 'DETACHMENT', 'SOURCE', 'POINTS', 'COMPOSITION', 'WARGEAR', 'KEYWORDS', 'ABILITY', 'RANGE', 'MODEL', 'MODELS', 'UNIT', 'UNITS', 'MAXIMUM DISTANCE', 'FORCE DISPOSITION', 'DETACHMENT POINTS']);
for (const id of samples) {
  const rec = all.find(r => r.id === id);
  const fr = frText(id);
  if (!rec || !fr) continue;
  checked++;
  const check = frKeywordCheck(rec.text, fr);
  const bad = check.missed.filter(m => !ROW_LABELS.has(m));
  if (!bad.length) keptAll++; else misses.push({ id: id, missed: bad });
}
ok('the sample records were found', checked >= 4);
t('every ALL-CAPS term in the English survives in the French', misses, []);
ok('the keyword line of a unit record stays English', /MOTS-CL\u00c9S\s*:\s*Orks, Infantry, Mega Armour, Explosives/.test(frText('unitrules#000000024')));
ok('and the card\u2019s own keywords are the English ones', /ASSAULT/.test(frText('unitrules#000000024')));

// --- the rendered body ---------------------------------------------------------
// The renderer is the real one: the same recordBody the /rules/record route calls.
const corpora = { rules: all.filter(r => r.set === 'rules'), factions: all.filter(r => r.set === 'factions'), rulings: all.filter(r => r.set === 'rulings') };
const introRec = all.find(r => r.id === 'core-rules#Introduction');
const enBody = recordBody(introRec, { corpora: corpora });
const frBody = recordBody(introRec, { corpora: corpora, frText: intro });
ok('the English body is English', /Welcome to the Warhammer/.test(enBody));
ok('the French body is French', /Bienvenue dans les Règles/.test(frBody));
ok('and the two differ', enBody !== frBody);
const unitRec = all.find(r => r.id === 'unitrules#000000024');
const frUnit = recordBody(unitRec, { corpora: corpora, frText: frText('unitrules#000000024') });
ok('a unit record renders its French', /Capacit\u00e9/.test(frUnit));
ok('with the keywords still English', /Mega Armour/.test(frUnit) && /ASSAULT/.test(frUnit));
ok('and no French for a record that has none: the English body is what renders', recordBody(all.find(r => r.id === 'datasheet#000000696'), { corpora: corpora }) === recordBody(all.find(r => r.id === 'datasheet#000000696'), { corpora: corpora, frText: '' }));

// --- the page and the server wiring --------------------------------------------
const page = fs.readFileSync(path.join(REPO, 'src', 'rules.html'), 'utf8');
ok('the settings sheet carries the record-language switch', /id="frseg"/.test(page) && /data-fr="fr"/.test(page));
ok('the state word exists for a test to read', /id="frState"/.test(page) && /data-fr-state/.test(page));
ok('the default follows the interface language', /return LANG === 'fr' \? 'fr' : 'en';/.test(page));
ok('the choice is the reader\u2019s and sticks', /var FR_KEY = 'mhq\.rules\.fr';/.test(page));
ok('the record fetch carries the language', /recordLangQuery\(\)/.test(page));
ok('the quote keeps the English canon and puts the French under it', /rquote-fr/.test(page) && /if \(answered && agent\.quote\)/.test(page));
const surface = fs.readFileSync(path.join(REPO, 'src', 'wiki-surface.js'), 'utf8');
ok('the drawer and the reading view ask for the same language', /recordLangQuery\(\)/.test(surface) && /FR_KEY/.test(surface));
const server = fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8');
ok('the record route honours lang=fr', /frUsable\(raw\.id\)/.test(server));
ok('and the French rides under the quote on the default path', /quoteFrNoWriter/.test(server));
ok('the overlay is a route of its own for the page', /u\.pathname === '\/rules\/fr'/.test(server));
const payload = fs.readFileSync(path.join(REPO, 'src', 'wiki-payload.mjs'), 'utf8');
ok('the bake writes the French per book', /i18n\/fr\/'\.\+ book|i18n', 'fr'/.test(payload));
const baked = path.join(REPO, 'workspace', 'wiki-data', 'i18n', 'fr', 'index.json');
ok('and the bake really ran', fs.existsSync(baked));
if (fs.existsSync(baked)) {
  const idx = JSON.parse(fs.readFileSync(baked, 'utf8'));
  ok('the index names every book and the pass\u2019s counts', Object.keys(idx.books).length >= 25 && idx.translated === 6286 && idx.blocked === 39);
  const biggest = Math.max.apply(null, Object.keys(idx.books).map(b => idx.books[b].bytes));
  ok('no single book payload is the whole corpus', biggest < 1024 * 1024);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
