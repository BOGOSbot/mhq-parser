import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { mergeChunkParts } from '../src/wiki-plan.mjs';
import { recordBody } from '../src/wiki-cards.mjs';
import { recordCard } from '../src/unit-card.mjs';

// task-29: the (1/2)/(2/2) chunks are one record in the reader's surfaces. The
// corpus and the index keep the parts (the agent's passage window needs them); the
// display reassembles them - the ledger row, the record view and the tree must not
// disagree. Merging is by the heading's base name because part/parts read 1/1 on
// every labelled chunk (the corpus audit, 2026-10-19).
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + ' | got: ' + JSON.stringify(got).slice(0, 240) + ' | want: ' + JSON.stringify(want).slice(0, 240)); } };

const all = readAllCorpus();
const labelled = all.filter(s => /\(\d+\/\d+\)$/.test(String(s.heading || '')));
t('the corpus still has labelled chunks (the split rule is untouched)', labelled.length > 0, true);
const part1 = labelled.find(s => String(s.id).endsWith('~1')) || labelled[0];
const m = /^(.*?) \((\d+)\/(\d+)\)$/.exec(String(part1.heading));
const baseId = String(part1.id).replace(/~\d+$/, '');
const of = parseInt(m[3], 10);
const parts = [];
for (let i = 1; i <= of; i++) parts.push(all.find(s => s.id === baseId + '~' + i));
ok('the probe group has all its parts', parts.length === of && parts.every(Boolean));

// --- the pure merge ----------------------------------------------------------
const merged = mergeChunkParts(part1, all);
t('the merged record is named by its base heading', merged.heading, m[1]);
t('and carries every part id it was built from', merged.mergedFrom, parts.map(p => p.id));
t('and its text carries the last part', merged.text.indexOf(String(parts[of - 1].text).slice(0, 40)) !== -1, true);
t('a record that is not a chunk is untouched', mergeChunkParts({ id: 'x#1', heading: 'A plain rule', text: 'body' }, all).heading, 'A plain rule');

// --- the record card (JSON record view) and the fragment (HTML) --------------
const corpora = { rules: all.filter(s => s.set === 'rules'), factions: all.filter(s => s.set === 'factions'), rulings: all.filter(s => s.set === 'rulings') };
const card1 = recordCard(part1.id, { corpora });
const cardLast = recordCard(parts[of - 1].id, { corpora });
ok('the record card of any part names the base record', card1 && cardLast && card1.title === cardLast.title);
ok('and its text is the whole rule, not the part', !!card1 && card1.text.indexOf(String(parts[of - 1].text).slice(0, 40)) !== -1);
const html = recordBody(part1, { corpora });
ok('the rendered fragment is the whole record', html.length > 300 && /wprov|wcard|wprose/.test(html));

// --- the front end: rows and swipe order -------------------------------------
const surface = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wiki-surface.js'), 'utf8');
const fnSrc = name => {
  const at = surface.indexOf('function ' + name + '(');
  let i = surface.indexOf('{', at), depth = 0;
  for (; i < surface.length; i++) {
    if (surface[i] === '{') depth++;
    else if (surface[i] === '}') { depth--; if (!depth) return surface.slice(at, i + 1); }
  }
  return '';
};
const mergeChunks = new Function(fnSrc('chunkBase') + '\n' + fnSrc('mergeChunks') + '\nreturn mergeChunks;')();
const siblingRows = [{ id: baseId + '~1', n: 1, heading: m[1] + ' (1/2)', excerpt: 'first', rank: 2 }, { id: baseId + '~2', n: 2, heading: m[1] + ' (2/2)', excerpt: 'second', rank: 3 }, { id: 'other#1', n: 3, heading: 'A different record', excerpt: 'x', rank: 4 }];
const rows = mergeChunks(siblingRows);
t('two sibling parts become one row', rows.length, 2);
t('the row is named by the base heading, marker gone', rows[0].heading, m[1]);
t('the second part is folded into the row, not dropped', [rows[0].excerpt, rows[0].mergedIds], ['first second', [baseId + '~2']]);
ok('the slideshow order merges too - the page cannot disagree with the ledger', /heroOrder\(mergeChunks\(findings\)/.test(surface) && /mergeChunks\(sortedFindings\(state\.findings/.test(surface));
t('the merged row keeps the folded passage number', rows[0].mergedNs, [2]);
// Two different records can share a base heading (108 delivered id-groups do): the
// id is the group, the heading is only a fallback.
const sameName = mergeChunks([{ id: 'a#1~1', n: 1, heading: 'Abilities (1/2)', excerpt: 'a' }, { id: 'b#2~1', n: 2, heading: 'Abilities (1/2)', excerpt: 'b' }]);
t('two records that share a base heading do NOT merge', sameName.length, 2);
ok('and the ledger counts a citation to either part as a citation to the record', /var rowNs = function \(f\) \{ return \[f\.n\]\.concat\(f\.mergedNs \|\| \[\]\); \};/.test(surface) && /usedNums\.indexOf\(ns\[x\]\) !== -1/.test(surface) && /rowNs\(used\[k\]\)\.indexOf\(quotedFrom\) !== -1/.test(surface));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;