import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardFor, recordBody, recordShape, proseHtml, CARD_KINDS } from '../src/wiki-cards.mjs';
import { stripBuiltBlock, stripSeeAlso, seeAlsoEntries } from '../src/wiki-plan.mjs';
import { readAllCorpus } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want));

const all = readAllCorpus();
const fam = { stratagem: 0, ability: 0, other: 0 };
const byKind = {};
const abilities = [], stratagems = [];
let identical = 0, changed = 0, skipped = 0, seeAlsoChanged = 0, csvChanged = 0; const mismatches = [];
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
  const old = proseHtml(stripSeeAlso({ text: text, links: r.links }), opts);
  const now = recordBody(r);
  let isCard = kind === 'ruling' || (CARD_KINDS && CARD_KINDS.has && CARD_KINDS.has(kind));
  if (!isCard) { try { isCard = !!cardFor(r, {}); } catch (e) { isCard = false; } }
  const cardOrRuling = isCard;
  if (cardOrRuling) { skipped++; continue; }
  if (seeAlsoEntries(r).some(e => e.child)) seeAlsoChanged++;
  if (hasCsvCols(r)) csvChanged++;
  if (now === old) { identical++; byKind[kind].identical++; } else { changed++; byKind[kind].changed++; if (mismatches.length < 5) mismatches.push(r.id); }
}
console.log('records ' + all.length + ' | stratagem ' + fam.stratagem + ' | ability ' + fam.ability + ' | other ' + fam.other);
console.log('changed ' + changed + ' | byte-identical ' + identical + ' | card/ruling skipped ' + skipped);
if (mismatches.length) console.log('mismatches: ' + mismatches.join(', '));
for (const k of Object.keys(byKind).sort()) { const v = byKind[k]; if (v.stratagem || v.ability || v.changed) console.log('  ' + k.padEnd(18) + ' strat ' + v.stratagem + ' ability ' + v.ability + ' changed ' + v.changed + ' identical ' + v.identical); }

// The 22: Type says Movement/Shooting Ability with an empty CP.
// The core stratagem file's own 54 records; 22 of them are typed Movement/Shooting Ability.
const core22 = abilities.filter(r => /^core-stratagems?#/.test(String(r.id)));
// task-13: 21 - PULSE JET MOVE left the core stratagems for the Wazdakka datasheet.
t('the 21 core ability records classify as abilities', core22.length, 21);
// task-89: 12 of them have their rows only mid-line (a collapsed CSV table) and take
// the plain fallback; the other 10 keep the table.
t('the mid-line rows take the plain fallback', core22.filter(r => recordShape(stripBuiltBlock(r), r.heading).family === 'ability-plain').length, 12);
// 21 = 12 mid-line + 9 with a table, since task-13.

ok('none of them is a stratagem', core22.every(r => { const f = recordShape(stripBuiltBlock(r), r.heading).family; return f === 'ability' || f === 'ability-plain'; }));
// task-89: 12 of the 22 have their rows only mid-line and take the plain fallback.
const table22 = core22.filter(r => recordShape(stripBuiltBlock(r), r.heading).family === 'ability');
const plain22 = core22.filter(r => recordShape(stripBuiltBlock(r), r.heading).family === 'ability-plain');
t('the table ones render rows and no CP badge', table22.filter(r => { const h = recordBody(r); return h.indexOf('svl-ability') === -1 || h.indexOf('svl-cp') !== -1; }).length, 0);
ok('the plain ones render prose with the ALL-CAPS styling, no CP badge and no Turn/Phase', plain22.every(r => { const h = recordBody(r); return h.indexOf('wprose') !== -1 && h.indexOf('wcaps') !== -1 && h.indexOf('svl-cp') === -1 && h.indexOf('Turn:') === -1; }));
const proseAbilities = abilities.filter(r => { try { return !cardFor(r, {}); } catch (e) { return true; } });
t('every ability renders either the table or the plain fallback', proseAbilities.filter(r => { const h = recordBody(r); return !(h.indexOf('svl-ability') !== -1 || (h.indexOf('wprose') !== -1 && h.indexOf('wcaps') !== -1)); }).length, 0);
t('the rest are cards and keep their card rendering', abilities.length - proseAbilities.length, 2);
t('every stratagem keeps its CP badge', stratagems.filter(r => { const s = recordShape(stripBuiltBlock(r), r.heading); return !s.cp || recordBody(r).indexOf('svl-cp') === -1 || recordBody(r).indexOf(esc(s.cp)) === -1; }).length, 0);
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// task-91: a record with a SEE ALSO CHILD entry now renders it as a container under the
// body, so those records change by design. Everything else stays byte-identical.
t('only the SEE ALSO containers and the CSV-column strips changed outside the two families', changed - fam.stratagem - fam.ability, seeAlsoChanged + csvChanged);
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
