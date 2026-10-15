import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { buildMissionMatrix, missingFromCorpus, matrixMarkdown, MATRIX_OUTPUT, readMatrixReference } from '../src/mission-matrix.mjs';

// task-56, part 2: the force-disposition matrix. The corpus cannot supply the
// pairing - no mission card names a disposition - so the structure is
// reference-sourced and must travel labelled as such, the same posture as the
// WTC/FEQ banner. What IS corpus-checked: every mission name in the matrix
// exists in the split cards, with zero matrix-only names.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = readAllCorpus();
const cards = all.filter(r => /-Mission-deck->-/.test(r.id) && String(r.heading || '').split(' > ').length === 2)
  .map(r => String(r.heading).split(' > ')[1]);
const reference = readMatrixReference();
const matrix = buildMissionMatrix(reference);

t('the reference records where it came from', [!!reference.source.url, !!reference.source.title, !!reference.source.retrieved_at], [true, true, true]);
ok('and carries its provenance note', /STRUCTURE only/.test(String(reference.source.note)) && /NOT verified/.test(String(reference.source.note)));
ok('the orientation is recorded', /rows/.test(matrix.orientation) && /columns/.test(matrix.orientation) && /OPPONENT/i.test(matrix.orientation));
t('the matrix is 5 x 5 with every cell filled', [matrix.dispositions.length, matrix.cells.length, matrix.missing], [5, 25, 0]);
t('and names 25 distinct missions', matrix.uniqueMissions.length, 25);

// The corpus corroborates the NAMES and nothing else.
t('zero matrix-only names: every mission is a corpus card', missingFromCorpus(matrix, cards), []);
t('the corpus holds the 43 cards the reference needs', cards.length, 43);
const mentions = all.filter(r => /-Mission-deck->-/.test(r.id)).filter(r => matrix.dispositions.some(d => String(r.text || '').indexOf(d) !== -1)).length;
t('no card names a disposition: the pairing cannot be corpus-verified', mentions, 0);

// The table a reader sees says whose words these are.
const md = matrixMarkdown(matrix, cards);
ok('the banner says reference-sourced and not verified', /Reference-sourced structure - not verified rules text/.test(md));
ok('every cell is labelled reference-only', (md.match(/reference-only/g) || []).length >= 25);
ok('the source travels with the table', md.indexOf(reference.source.url) !== -1 && md.indexOf(reference.source.title) !== -1);
ok('the orientation and the name check travel with it', md.indexOf('rows') !== -1 && md.indexOf('zero matrix-only names') !== -1);
ok('the written table matches the generated one', fs.readFileSync(MATRIX_OUTPUT, 'utf8').trim() === md.trim());

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
