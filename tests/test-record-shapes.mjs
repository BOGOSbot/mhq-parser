import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyLines, cardFor, recordBody, recordShape, proseHtml, splitBlocks, CARD_KINDS } from '../src/wiki-cards.mjs';
import { exclusionReason } from '../src/rules-corpus.mjs';
import { stripBuiltBlock, stripSeeAlso, seeAlsoEntries } from '../src/wiki-plan.mjs';
import { markWargearText } from '../src/wargear-marks.mjs';
import { readAllCorpus } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want));

const all = readAllCorpus();
const fam = { stratagem: 0, ability: 0, other: 0 };
const byKind = {};
const abilities = [], stratagems = [];
let identical = 0, changed = 0, skipped = 0, seeAlsoChanged = 0, csvChanged = 0, wallChanged = 0, excludedChanged = 0, unexplained = 0; const mismatches = [];
// task-41: the wall split is a third intended class of change - a record whose body is
// one unbroken paragraph now renders as its own pieces, with an outline when the pieces
// have names. Same two conditions bodyHtml uses.
const wallSplit = r => {
  const lines = bodyLines(stripSeeAlso({ text: markWargearText(stripBuiltBlock(r)), links: r.links }), { selfId: r.id, selfHeading: r.heading });
  const src = lines.join('\n');
  const blocks = splitBlocks(src);
  const named = blocks.filter(b => b.title).length;
  return named >= 2 || (!/\n\s*\n/.test(src) && blocks.length >= 2);
};
// task-97: the CSV's own columns ('Type:', 'CP:', 'Turn: Phase: ...') are metadata, not the
// book's words, and they leave the reader's prose now - a second intended class of change.
const hasCsvCols = r => /^\s*(?:Type|CP)\s*:/m.test(String(r.text)) || /^\s*Turn:\s+Phase:/m.test(String(r.text)) ||
  // task-99: the builder's own label line ('NAME - Aeldari stratagem') is an echo the card
  // already carries, and the export's legend/Detachment lines move or leave. A CSV record
  // with none of the Type/CP/Turn columns still renders differently.
  /^[^\n]*\s-\s[^\n]*(?:stratagem|ability|army rule|enhancement|detachment)\s*$/i.test(String(r.text).split('\n')[0] || '');
for (const r of all) {
  const text = stripBuiltBlock(r);
  const shape = recordShape(text);
  const kind = r.kind || '(none)';
  byKind[kind] = byKind[kind] || { stratagem: 0, ability: 0, other: 0, changed: 0, identical: 0 };
  const family = shape && shape.family === 'ability-plain' ? 'ability' : (shape && shape.family);
  if (shape) {
    fam[family]++; byKind[kind][family]++; changed++;
    if (shape.family === 'ability' || shape.family === 'ability-plain') abilities.push(r);
    if (shape.family === 'stratagem') stratagems.push(r);
    continue;
  }
  fam.other++; byKind[kind].other++;
  // The old rendering, verbatim: the prose call recordBody made before the layouts. The
  // task-87 display strip is in both sides, so a SEE ALSO block leaving the reader's text
  // is not read as a layout change.
  const opts = { selfId: r.id, href: undefined, cap: kind === 'index' ? 0 : 40, selfHeading: r.heading };
  // task-34: the wargear marks (Range 12", BS 2+) are a render convention, so the
  // baseline takes them too - otherwise every record with a wargear line reads as a
  // layout change when it is only the notation.
  const old = proseHtml(stripSeeAlso({ text: markWargearText(text), links: r.links }), opts);
  const now = recordBody(r);
  let isCard = kind === 'ruling' || (CARD_KINDS && CARD_KINDS.has && CARD_KINDS.has(kind));
  if (!isCard) { try { isCard = !!cardFor(r, {}); } catch (e) { isCard = false; } }
  const cardOrRuling = isCard;
  if (cardOrRuling) { skipped++; continue; }
  // 2026-10-26: the four reasons are counted only for a record that actually changed,
  // and they are exclusive. The old shape counted the SEE ALSO and CSV classes for every
  // record including the byte-identical ones, so the census could sum past the number of
  // changes; with the MFM corpus 48 unchanged records carry a Type:/CP: line, which is how
  // the arithmetic first went wrong. Every change must now land in exactly one class, and
  // anything left is counted as unexplained rather than absorbed by the equation.
  const seeAlso = seeAlsoEntries(r).some(e => e.child), csv = hasCsvCols(r), excl = exclusionReason(r) !== '';
  const wall = !seeAlso && !csv && wallSplit(r);
  if (now === old) { identical++; byKind[kind].identical++; } else {
    changed++; byKind[kind].changed++;
    if (seeAlso) seeAlsoChanged++;
    else if (csv) csvChanged++;
    else if (wall) wallChanged++;
    else if (excl) excludedChanged++;
    else { unexplained++; if (mismatches.length < 5) mismatches.push(r.id); }
  }
}
console.log('records ' + all.length + ' | stratagem ' + fam.stratagem + ' | ability ' + fam.ability + ' | other ' + fam.other);
console.log('changed ' + changed + ' | byte-identical ' + identical + ' | card/ruling skipped ' + skipped);
if (mismatches.length) console.log('mismatches: ' + mismatches.join(', '));
for (const k of Object.keys(byKind).sort()) { const v = byKind[k]; if (v.stratagem || v.ability || v.changed) console.log('  ' + k.padEnd(18) + ' strat ' + v.stratagem + ' ability ' + v.ability + ' changed ' + v.changed + ' identical ' + v.identical); }

// 2026-10-26: the core stratagems are real stratagems now - Command Re-roll, Go to Ground,
// Fire Overwatch and the rest of the shared set - instead of the CSV's Movement/Shooting
// Ability reference rows with an empty CP. So they classify as stratagems, and the
// invariants below are stated against that family rather than a census of one export.
const coreStrats = all.filter(r => /^core-stratagem#/.test(String(r.id)));
ok('the core stratagems are in the corpus', coreStrats.length > 0);
t('every core stratagem classifies as a stratagem', coreStrats.filter(r => recordShape(stripBuiltBlock(r), r.heading).family === 'stratagem').length, coreStrats.length);
t('and every one carries its CP', coreStrats.filter(r => String((recordShape(stripBuiltBlock(r), r.heading) || {}).cp || '') !== '').length, coreStrats.length);
// The census invariant: three families, no record counted twice and none missed.
t('every record lands in exactly one family', fam.stratagem + fam.ability + fam.other, all.length);
t('every stratagem keeps its CP badge', stratagems.filter(r => { const s = recordShape(stripBuiltBlock(r), r.heading); return !s.cp || recordBody(r).indexOf('svl-cp') === -1 || recordBody(r).indexOf(esc(s.cp)) === -1; }).length, 0);
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// task-91: a record with a SEE ALSO CHILD entry now renders it as a container under the
// body, so those records change by design. Everything else stays byte-identical.
// task-41 added the third class: the wall split (an outline, or a one-paragraph body
// rendered as its own pieces).
// task-44 added the fourth: a filtered record (Legends, the pack line, the named
// tenth-edition rule) now carries a banner naming why it is not in the search.
t('every change outside the two families is explained by one of the four classes', unexplained, 0);
// The rule that files a record with no Type: it must carry the rows at line starts.
// An empty Type with nothing to show is never an ability (the 6 Aeldari today).
t('an ability either carries a Type line or carries the rows',
  abilities.filter(r => { const txt = stripBuiltBlock(r); return !/(^|\n)\s*Type\s*:/i.test(txt) && !/(^|\n)\s*(MAXIMUM DISTANCE|WHEN|TARGET|EFFECT)\s*:/i.test(txt); }).length, 0);
// --- task-78 B pass 2: the label rule and the table decision -------------------------
const abilityLabels = abilities.map(r => recordShape(stripBuiltBlock(r), r.heading).type);
ok('every ability label is one the record carries (its own Type, or its phase)',
  abilityLabels.every(x => x === '' || /^(Movement|Shooting|Charge|Fight)( Ability)?$/.test(x)));
const invented = abilities.filter(r => recordShape(stripBuiltBlock(r), r.heading).type === '' && recordBody(r).indexOf('svl-type') !== -1);
t('a record with no Type gets no invented label', invented.length, 0);
// The delimiter measurement (workspace/t78/tables-measure*.mjs) is the decision: of the
// corpus's tabular blocks 8 split on 2+ spaces, none with a stable column count and none
// with a header row, and only 2 records hold a run of row-like lines (3 runs, 0 header).
// A table renderer would fabricate structure, so nothing renders as a table.
const tableHtml = all.filter(r => { try { return recordBody(r).indexOf('wgrid') !== -1; } catch (e) { return false; } }).length;
t('no record renders as a table on this evidence', tableHtml, 0);
const pseudo = all.find(r => / {2,}/.test(String(r.text)) && !recordShape(stripBuiltBlock(r), r.heading));
ok('a pseudo-table is not rendered as a layout table', pseudo ? recordBody(pseudo).indexOf('svl-rows') === -1 : true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
