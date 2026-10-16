import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardFor, recordBody, recordShape, proseHtml, CARD_KINDS } from '../src/wiki-cards.mjs';
import { stripBuiltBlock } from '../src/wiki-plan.mjs';
import { readAllCorpus } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want));

const all = readAllCorpus();
const fam = { stratagem: 0, ability: 0, other: 0 };
const byKind = {};
const abilities = [], stratagems = [];
let identical = 0, changed = 0, skipped = 0; const mismatches = [];
for (const r of all) {
  const text = stripBuiltBlock(r);
  const shape = recordShape(text);
  const kind = r.kind || '(none)';
  byKind[kind] = byKind[kind] || { stratagem: 0, ability: 0, other: 0, changed: 0, identical: 0 };
  if (shape) {
    fam[shape.family]++; byKind[kind][shape.family]++; changed++;
    if (shape.family === 'ability') abilities.push(r);
    if (shape.family === 'stratagem') stratagems.push(r);
    continue;
  }
  fam.other++; byKind[kind].other++;
  // The old rendering, verbatim: the prose call recordBody made before the layouts.
  const opts = { selfId: r.id, href: undefined, cap: kind === 'index' ? 0 : 40, selfHeading: r.heading };
  const old = proseHtml(text, opts);
  const now = recordBody(r);
  let isCard = kind === 'ruling' || (CARD_KINDS && CARD_KINDS.has && CARD_KINDS.has(kind));
  if (!isCard) { try { isCard = !!cardFor(r, {}); } catch (e) { isCard = false; } }
  const cardOrRuling = isCard;
  if (cardOrRuling) { skipped++; continue; }
  if (now === old) { identical++; byKind[kind].identical++; } else { changed++; byKind[kind].changed++; if (mismatches.length < 5) mismatches.push(r.id); }
}
console.log('records ' + all.length + ' | stratagem ' + fam.stratagem + ' | ability ' + fam.ability + ' | other ' + fam.other);
console.log('changed ' + changed + ' | byte-identical ' + identical + ' | card/ruling skipped ' + skipped);
if (mismatches.length) console.log('mismatches: ' + mismatches.join(', '));
for (const k of Object.keys(byKind).sort()) { const v = byKind[k]; if (v.stratagem || v.ability || v.changed) console.log('  ' + k.padEnd(18) + ' strat ' + v.stratagem + ' ability ' + v.ability + ' changed ' + v.changed + ' identical ' + v.identical); }

// The 22: Type says Movement/Shooting Ability with an empty CP.
// The core stratagem file's own 54 records; 22 of them are typed Movement/Shooting Ability.
const core22 = abilities.filter(r => /^core-stratagems?#/.test(String(r.id)));
t('the 22 core ability records classify as abilities', core22.length, 22);
ok('none of them is a stratagem', core22.every(r => recordShape(stripBuiltBlock(r), r.heading).family === 'ability'));
ok('they render ability rows, not a CP badge', core22.every(r => { const h = recordBody(r); return h.indexOf('svl-ability') !== -1 && h.indexOf('svl-cp') === -1; }));
const proseAbilities = abilities.filter(r => { try { return !cardFor(r, {}); } catch (e) { return true; } });
t('every ability that takes the prose path renders as an ability', proseAbilities.filter(r => recordBody(r).indexOf('svl-ability') === -1).length, 0);
t('the rest are cards and keep their card rendering', abilities.length - proseAbilities.length, 2);
t('every stratagem keeps its CP badge', stratagems.filter(r => { const s = recordShape(stripBuiltBlock(r), r.heading); return !s.cp || recordBody(r).indexOf('svl-cp') === -1 || recordBody(r).indexOf(esc(s.cp)) === -1; }).length, 0);
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
t('nothing outside the two families changed', changed - fam.stratagem - fam.ability, 0);
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
