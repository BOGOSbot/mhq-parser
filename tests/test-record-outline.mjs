import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { bodyHtml, bodyLines, recordBody, splitBlocks } from '../src/wiki-cards.mjs';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const href = id => '#' + String(id).replace(/[^a-z0-9]+/gi, '-');

// task-41: the record's own structure. The worst records are one unbroken wall - 60 of
// 69 faction rules and 119 of 154 rulings render as a single <p> - and the structure is
// still in the stored text: sub-headings survived as runs of capitals, an ability as
// 'Ability: NAME -', a paragraph break as a run of two or more spaces. The splitter
// reads them back, and the record gets an outline when two pieces carry a name.
const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const blocksOf = id => splitBlocks(String((byId.get(id) || {}).text || ''));
const htmlOf = id => { const r = byId.get(id); return bodyHtml(String(r.text || ''), { selfId: r.id, href, selfHeading: r.heading, cap: 12 }); };
const titles = bs => bs.filter(b => b.title).map(b => b.title);

// --- the wall the audit named: Cabal of Sorcerers, 2,040 characters, one <p>
const cabal = blocksOf('faction-rule#000008424');
ok('the faction rule splits on the sub-headings the text already carries', titles(cabal).length >= 4);
ok('and the first one is the book\'s own', titles(cabal)[0] === 'PSYCHIC TEST SEQUENCE');
ok('the ritual names come out as headings too', titles(cabal).some(t => t.indexOf('DESTINY\u2019S RUIN') === 0));
const cabalHtml = htmlOf('faction-rule#000008424');
ok('so the record carries an outline', cabalHtml.indexOf('woutline') !== -1 && cabalHtml.indexOf('wblock-h') !== -1);
const cabalHrefs = [...cabalHtml.matchAll(/href="#(wb-\d+)"/g)].map(m => m[1]);
ok('every outline entry points at a section in the same fragment', cabalHrefs.length >= 4 && cabalHrefs.every(h => cabalHtml.indexOf('id="' + h + '"') !== -1));

// --- the ruling: 4,093 characters, ZERO line breaks. It has no names, and the split
// is still the win: the source's paragraph breaks survived as runs of 2+ spaces.
const ruling = blocksOf('wtc11-sequencing-100');
ok('a one-line ruling splits into its source paragraphs', ruling.length >= 8);
ok('and it is not given names it does not have', titles(ruling).length === 0);
const rulingHtml = htmlOf('wtc11-sequencing-100');
ok('the ruling renders as several paragraphs', (rulingHtml.match(/<p>/g) || []).length >= 8);
ok('and no outline is invented for it', rulingHtml.indexOf('woutline') === -1);

// --- genuinely flat: one definition, one paragraph, nothing to split
ok('an ability definition is one block and stays one', blocksOf('ability-def#devastating-wounds').length === 1);

// --- what is never a heading -------------------------------------------------
const n1 = splitBlocks('ELIGIBLE IF: Your unit is embarked within a TRANSPORT model that was just destroyed.');
ok('a field label is not a heading', titles(n1).length === 0);
const n2 = splitBlocks('MAXIMUM DISTANCE: 12\"  ELIGIBLE IF: Your unit is not within Engagement Range of any enemy models.');
ok('neither is a run of them', titles(n2).length === 0);
const n3 = splitBlocks('Until the end of the phase, each time a THOUSAND SONS model is selected to shoot, it may re-roll one hit roll.');
ok('a keyword inside a sentence stays prose', titles(n3).length === 0);
const n4 = splitBlocks('Bolt pistol 12\" 1 3+ 4 0 1   Boltgun 24\" 2 3+ 4 0 1\nClose combat weapon Melee 3 3+ 4 0 1   Power fist Melee 2 3+ 8 -2 2');
ok('a table block is not split at all', n4.length === 1 && titles(n4).length === 0);
const n5 = splitBlocks('- first bullet\n- second bullet');
ok('a bullet run stays one block', n5.length === 1 && titles(n5).length === 0);

// --- the unit card's own index (task-41, the second half) ---------------------
// A datasheet is 2.7 screens and the reader who came for one ability landed at the
// top of it. The sections keep their headings and take anchors, and the index above
// them is one tap to the part they came for.
const cardRec = all.find(r => r.kind === 'unitrules');
const cardHtml = recordBody(cardRec, { href: id => '#' + id });
const cardHrefs = [...cardHtml.matchAll(/href="#(wc-\d+)"/g)].map(m => m[1]);
ok('a unit card carries a section index', cardHtml.indexOf('wcard-index') !== -1 && cardHrefs.length >= 5);
ok('every index entry points at a section in the same fragment', cardHrefs.every(h => cardHtml.indexOf('id="' + h + '"') !== -1));
ok('and every section keeps its own heading', (cardHtml.match(/class="wcard-h" id="wc-\d+"/g) || []).length === cardHrefs.length);

// --- the counts, recomputed over the shipped corpus ---------------------------
const pool = [];
for (const h of ['rules', 'factions', 'rulings']) for (const r of readAllCorpus(h)) if (isDelivered(r)) pool.push(r);
let outlined = 0, taken = 0, flat = 0, dangling = 0;
for (const r of pool) {
  const text = String(r.text || '');
  const html = recordBody(r);
  if (html.indexOf('woutline') !== -1) {
    outlined += 1;
    for (const m of html.matchAll(/href="#(wb-\d+)"/g)) if (html.indexOf('id="' + m[1] + '"') === -1) dangling += 1;
  }
  // The two conditions bodyHtml uses: two named pieces, or a body with no paragraph
  // break of its own that still holds several pieces.
  // What the reader actually sees: a body rendered as its own pieces carries more than
  // one .wprose box; the untouched majority still carries exactly one.
  const boxes = (recordBody(r).match(/class="wprose"/g) || []).length;
  if (boxes > 1) taken += 1; else flat += 1;
}
ok('the outline reaches a real share of the corpus, not a handful', outlined > 100);
ok('and every outline entry resolves inside its own fragment', dangling === 0);
ok('the block path stays the exception, not the new default', taken > 400 && taken < pool.length / 2);
console.log('corpus ' + pool.length + ': outlines ' + outlined + ', records whose body renders as pieces ' + taken + ', still one prose box ' + flat);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
