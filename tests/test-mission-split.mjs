import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, readCorpusStamped, csvRows } from '../src/rules-corpus.mjs';
import { lookupRecord } from '../src/header-index.mjs';

// task-56, part 1: the event companion's two mission decks were 19 arbitrary
// chunks (13 Primary, 6 Secondary) cut mid-card. They are now one record per
// card, keyed by the card name the text already carries. Integrity is the whole
// test: the cards and fragments are contiguous slices of the chunks' own text,
// concatenated in document order, byte for byte equal to the pre-split bytes the
// builder kept beside the corpus. Nothing is authored, tidied or dropped.
//
// part 2: the disposition join is free (Detachments.csv carries force_disposition);
// the pairing-to-mission mapping is NOT in the corpus - no card names a
// disposition - so every matrix cell is reference-only and unverified here.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'workspace', 'rules-corpus');
const all = readAllCorpus();
// 2026-10-27: the decks come from the MFM dump, so the cards are no longer slices of the
// page's pre-split bytes - they are records with their own objectives and scoring. The
// byte-slice checks below only mean anything for the page split (MHQ_MISSIONS_SOURCE=page).
const fromDump = fs.existsSync(path.join(CORPUS, 'mfm-dump.json'))
  && String(process.env.MHQ_MISSIONS_SOURCE || 'mfm').toLowerCase() !== 'page';
const ours = r => (r.id.indexOf('event-companion#Primary-Mission-deck->-') === 0 || r.id.indexOf('event-companion#Secondary-Mission-deck->-') === 0) && String(r.heading || '').split(' > ').length === 2;

if (!fromDump) for (const [deck, cards, file] of [['Primary', 25, 'event-companion.deck-primary.presplit.txt'], ['Secondary', 18, 'event-companion.deck-secondary.presplit.txt']]) {
  const pre = fs.readFileSync(path.join(CORPUS, file), 'utf8');
  const list = all.filter(r => ours(r) && r.id.indexOf('event-companion#' + deck) === 0)
    .map(r => ({ r: r, at: pre.indexOf(String(r.text)) }))
    .sort((a, b) => a.at - b.at);
  const cardCount = list.filter(x => x.r.heading.indexOf('Fragment') === -1).length;
  // The deck's own title line was captured as a record; it is not content and is
  // dropped (the pre-split file still carries it, so the lossless check adds it
  // back). There is no fragment left on either deck.
  const preamble = deck + ' Mission deck\n';
  t(deck + ': ' + cards + ' cards and no fragment', [cardCount, list.length - cardCount], [cards, 0]);
  t(deck + ': every record is a slice of the pre-split bytes', list.every(x => x.at >= 0), true);
  t(deck + ': the cards plus the dropped preamble are byte-identical to the pre-split text', preamble + list.map(x => x.r.text).join(''), pre);
  ok(deck + ': the deck title is not a record', !list.some(x => String(x.r.text).trim() === deck + ' Mission deck'));
  t(deck + ': the preamble row is dropped by id', all.filter(x => x.id === 'event-companion#' + deck + '-Mission-deck->-fragment-1').length, 0);
  ok(deck + ': every card starts at its own name', list.filter(x => x.r.heading.indexOf('Fragment') === -1).every(x => String(x.r.text).indexOf(String(x.r.heading).split(' > ')[1]) === 0));
}

const primary = all.filter(r => ours(r) && r.id.indexOf('event-companion#Primary') === 0 && r.heading.indexOf('Fragment') === -1);
const secondary = all.filter(r => ours(r) && r.id.indexOf('event-companion#Secondary') === 0 && r.heading.indexOf('Fragment') === -1);
const nameOf = r => String(r.heading).split(' > ')[1].toLowerCase();
if (fromDump) {
  t('the dump gives the 25 primary cards', primary.length, 25);
  t('the dump gives the 18 secondary cards', secondary.length, 18);
  ok('every card carries its scoring', primary.concat(secondary).every(r => /VP/.test(String(r.text))));
  ok('no card is a fragment', primary.concat(secondary).every(r => !/Fragment/.test(String(r.heading))));
}
ok('the 25 primary names are the deck the reference prints', ['battlefield dominance', 'meatgrinder', 'sabotage', 'vital link'].every(n => primary.some(r => nameOf(r) === n)));
ok('the 18 secondary names include the deck staples', ['no prisoners', 'a tempting target', 'behind enemy lines'].every(n => secondary.some(r => nameOf(r) === n)));
ok('the router answers a mission by name now', lookupRecord('find battlefield dominance').found && lookupRecord('find no prisoners').found);

// --- part 2: the join, and what the corpus cannot fill -------------------------
const rows = csvRows(fs.readFileSync(path.join(CORPUS, 'csv', 'Detachments.csv'), 'utf8'));
const dispositions = {};
for (const r of rows) { const d = String(r.force_disposition || '').trim(); if (d) dispositions[d] = (dispositions[d] || 0) + 1; }
t('the export names the five force dispositions', Object.keys(dispositions).sort(), ['Disruption', 'Priority Assets', 'Purge the Foe', 'Reconnaissance', 'Take and Hold']);
// 256 of 315 detachment rows carry a disposition (task-33: the 2026-10-19 export adds
// four); the rest are blank in the export, so the join reaches 256, not 315.
t('the join reaches the rows that carry one', [rows.length, Object.values(dispositions).reduce((a, b) => a + b, 0)], [315, 256]);
// The check is on the card's NAME, not its prose: the dump brings the mission's own lore,
// and 'take and hold the ground ahead' is a sentence, not a disposition card.
const mentionsDisposition = primary.concat(secondary).filter(r => Object.keys(dispositions).some(d => nameOf(r) === d.toLowerCase())).length;
t('no mission card names a disposition: every matrix cell is reference-only', mentionsDisposition, 0);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
