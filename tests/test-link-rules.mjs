import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { recordBody, cardIndex } from '../src/wiki-cards.mjs';
import { linkify, linkMap, BARRED } from '../src/wikilinks.mjs';
import { surfaceSlugMap } from '../src/wiki-surface.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };

// task-42: the link pass renders a rule reference as a link. The name source is the
// heading index (the corpus's own projection of what a record is called), and the
// confidence rule is the book's own spelling: a multi-word name links as written, a
// single word links only in its keyword form and only where the text writes it
// capitalised, a name carried by several records links only when one candidate holds
// the search's top kind rank, and nothing links inside a heading, inside another link
// or to the record itself. The counts are recomputed here over the shipped payload,
// never hard-coded.
const href = id => '#slug-' + String(id).replace(/[^a-z0-9]+/gi, '-');
const anchors = html => (html.match(/<a class="wlink"/g) || []).length;
const map = linkMap();
const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));

// --- the map ---------------------------------------------------------------
ok('the map is the corpus\'s own heading names, and a substantial set', map.names.length > 2000);
ok('every eligible name has exactly one target', map.names.every(n => n.id && typeof n.id === 'string'));
ok('a dropped name never leaks back into the eligible set', map.names.every(n => !map.ambiguous.has(n.name) && !map.generic.has(n.name) && !map.barred.has(n.name)));
ok('a name is read from the heading index, marker and all', !!map.eligible.get('command phase') && map.eligible.get('command phase').id === 'core-rules#Command-Phase');

// --- a multi-word name links as written -------------------------------------
ok('a multi-word name links in the book\'s own case', anchors(linkify('They move in the COMMAND PHASE, always.', { href: href })) === 1);
ok('and in ordinary sentence case', anchors(linkify('They move in the command phase.', { href: href })) === 1);
ok('the label is the mention as the text writes it', /<a class="wlink" href="[^"]+">COMMAND PHASE<\/a>/.test(linkify('in the COMMAND PHASE', { href: href })));

// --- a single word links only in its keyword form ---------------------------
ok('a keyword single word links where the text writes it capitalised', anchors(linkify('this unit has SCOUTS', { href: href })) === 1);
ok('and stays plain where the text writes it lowercase', anchors(linkify('this unit has scouts', { href: href })) === 0);
ok('a single-word section title is not a name at all', map.generic.has('Dice') && anchors(linkify('roll some Dice and check', { href: href })) === 0);
ok('nor is a second-person pronoun the corpus happens to head', map.generic.has('You') && anchors(linkify('You may move, or you may shoot', { href: href })) === 0);

// --- the hand-vetted prose verbs stay barred --------------------------------
ok('a barred phrase keeps its prose meaning', BARRED.has('set up') && anchors(linkify('you must set up your army', { href: href })) === 0);

// --- ambiguity: one top-ranked candidate or nothing -------------------------
const fb = map.eligible.get('fall-back move');
ok('an ambiguous name links when one candidate is the book\'s own rule', !!fb && !!byId.get(fb.id) && byId.get(fb.id).kind === 'rule');
ok('a tie at the top rank stays plain text', map.ambiguous.has('LONE OPERATIVE') && anchors(linkify('this unit has LONE OPERATIVE', { href: href })) === 0);

// --- never self, never a dead link, never carpeted --------------------------
ok('a record never links to itself', anchors(linkify('the COMMAND PHASE', { selfId: 'core-rules#Command-Phase', href: href })) === 0);
ok('an empty href leaves the text plain', anchors(linkify('the COMMAND PHASE', { href: () => '' })) === 0);
const many = 'COMMAND PHASE. SHOOTING PHASE. FIGHT PHASE. MORTAL WOUNDS. DEADLY DEMISE. FEEL NO PAIN. ADVANCE MOVE. FALL-BACK MOVE. INGRESS MOVE. SCOUT MOVE. NORMAL MOVE. CHARGE MOVE. LEADERSHIP TEST. GRENADE.';
const st = { used: new Set(), count: 0 };
const capped = anchors(linkify(many, { href: href, cap: 12, state: st })) + anchors(linkify(many, { href: href, cap: 12, state: st }));
ok('the cap is per record, not per fragment', capped === 12 && anchors(linkify(many, { href: href, cap: 12 })) === 12);
ok('a name links once per record, first mention first', anchors(linkify('COMMAND PHASE ... command phase ... COMMAND PHASE', { href: href })) === 1);

// --- the pass takes text, so a link can never nest in a link ----------------
const nested = linkify('<a class="wlink" href="#x">COMMAND PHASE</a>', { href: href });
ok('markup in the input is escaped', nested.indexOf('&lt;a class=&quot;wlink&quot;') === 0);

// --- the composer: the field table takes the same pass ----------------------
const cards = fs.readFileSync(path.join(ROOT, 'src', 'wiki-cards.mjs'), 'utf8').replace(/\r\n/g, '\n');
ok('the shape table linkifies its values', /'<\/th><td>' \+ cell\(r\[1\]\) \+ '<\/td><\/tr>'/.test(cards) && /const cell = function \(t\)/.test(cards));
const records = fs.readFileSync(path.join(ROOT, 'src', 'wiki-cards.mjs'), 'utf8');
ok('and one budget is made per record', /o\.state = \{ used: new Set\(\)\.\.\./.test(records) || /o\.state = \{ used: new Set\(\), count: 0 \}/.test(records));

// --- the counts, recomputed over the shipped payload ------------------------
const corpora = { rules: readAllCorpus('rules'), factions: readAllCorpus('factions'), rulings: readAllCorpus('rulings') };
const every = new Map();
for (const h of ['rules', 'factions', 'rulings']) for (const r of corpora[h]) every.set(r.id, r);
const index = cardIndex(every);
const slugs = surfaceSlugMap();
const realHref = id => { const s = slugs.get(String(id || '')); return s ? '#' + s : ''; };
const delivered = [];
for (const h of ['rules', 'factions', 'rulings']) for (const r of corpora[h]) if (isDelivered(r)) delivered.push(r);
const sample = delivered.filter((r, i) => i % 20 === 0);
let total = 0, zero = 0, over = 0, dead = 0, bad = '';
const counts = [];
for (const rec of sample) {
  const html = recordBody(rec, { corpora: corpora, index: index, href: realHref, selfId: rec.id });
  const n = anchors(html);
  total += n; counts.push(n);
  if (!n) zero++;
  if (n > 12) { over++; bad = rec.id; }
  if (html.indexOf('<a class="wlink" href=""') !== -1) dead++;
}
counts.sort((a, b) => a - b);
const median = counts[Math.floor(counts.length / 2)];
const p90 = counts[Math.floor(counts.length * 0.9)];
ok('no record in the sample exceeds the cap of twelve' + (bad ? ' (' + bad + ')' : ''), over === 0);
ok('no rendered link is dead', dead === 0);
ok('a typical record carries a link', median >= 1 && total / sample.length > 1);
ok('and fewer than half the sample is unlinked', zero / sample.length < 0.5);
ok('the sample is big enough to mean something', sample.length > 250);
console.log('sample ' + sample.length + ' of ' + delivered.length + ' delivered: links ' + total + ', mean ' + (total / sample.length).toFixed(2) + ', median ' + median + ', p90 ' + p90 + ', max ' + counts[counts.length - 1] + ', unlinked ' + zero);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
