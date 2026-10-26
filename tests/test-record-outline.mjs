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
// 2026-10-26: the army rules come from the MFM dump one component per book block, so
// this record is no longer a wall - the splitter gets its paragraphs for free. The id is
// a dump UUID, so the record is looked up by heading, and the structure is asserted as
// blocks rather than as caps headings the dump does not print.
const cabalId = (all.find(r => r.kind === 'faction-rule' && /^Cabal of Sorcerers/.test(String(r.heading))) || {}).id;
const cabal = blocksOf(cabalId);
ok('the army rule arrives as the book blocks, not as one wall', cabal.length >= 4);
ok('and the psychic test sequence is one of them', cabal.some(b => /psychic test sequence/i.test(String(b.title || '') + ' ' + String(b.text || b.body || ''))));
const cabalHtml = htmlOf(cabalId);
ok('so the record renders more than one block', (cabalHtml.match(/<p>/g) || []).length >= 3);

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

// --- the unit card's jump list is GONE (task-62) ------------------------------
// Mandal: 'the jump list itself is cluttering. We don't need it, swipe is fine.'
// Every card has the same sections in the same order, so an index of them named
// nothing the reader could not see by scrolling, and it cost a screen at the top.
// What stays is the structure itself: the headings, in order, with no anchors -
// the wc-N ids existed only for the index's own hrefs, so they are dead too.
const cardRec = all.find(r => r.kind === 'unitrules' && isDelivered(r));
const cardHtml = recordBody(cardRec, { href: id => '#' + id });
ok('a unit card carries no jump list', cardHtml.indexOf('wcard-index') === -1);
ok('and no wc- anchors survive it', cardHtml.indexOf('wc-') === -1);
ok('every card section still carries its heading', (cardHtml.match(/class="wcard-h"/g) || []).length >= 5);
ok('and the headings keep their order', /Models<\/h2>[\s\S]*Ranged weapons<\/h2>[\s\S]*Abilities<\/h2>[\s\S]*Keywords<\/h2>/.test(cardHtml));
ok('the card still opens on its content, not on an index', cardHtml.indexOf('<section class="wcard" data-card="unit">') === 0 && cardHtml.indexOf('wcard-index') === -1);
// The record OUTLINE is a different thing and is untouched: it names sections that
// are unique to a wall of text, which is the problem it was built for.
const wallRec = all.find(r => r.kind === 'faction-rule' && isDelivered(r) && recordBody(r).indexOf('woutline') !== -1);
ok('the record outline on a wall of text is unchanged', !!wallRec && recordBody(wallRec).indexOf('woutline') !== -1);
ok('and it still points at real sections', [...recordBody(wallRec).matchAll(/href="#(wb-\d+)"/g)].every(m => recordBody(wallRec).indexOf('id="' + m[1] + '"') !== -1));

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
// 2026-10-24: 44 of 6,171, down from 123 because the 174 kind 'index' card lists left the
// delivered set and 79 of them were outlines. The floor stays a floor: it fails if the
// outline stops firing, not if the corpus moves by a record or two.
ok('the outline still fires on the records it was built for', outlined >= 40);
ok('and every outline entry resolves inside its own fragment', dangling === 0);
ok('the block path stays the exception, not the new default', taken > 400 && taken < pool.length / 2);
console.log('corpus ' + pool.length + ': outlines ' + outlined + ', records whose body renders as pieces ' + taken + ', still one prose box ' + flat);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
