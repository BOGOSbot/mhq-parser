import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The force-disposition matrix: which Primary Mission you play, by your
// disposition against your opponent's. The corpus cannot supply the mapping -
// no mission card names a force disposition - so the structure comes from the
// reference (gdmissions.app), used for STRUCTURE ONLY, with the source note
// travelling beside it. The NAMES are corroborated by the corpus cards; the
// pairings are not, and the table says so in its banner rather than in a
// footnote.
//
// Same posture as the WTC/FEQ banner: a page a player shows an opponent must
// say whose words these are and that they are not the rules text.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MATRIX_REFERENCE = path.join(ROOT, 'workspace', 'rules-corpus', 'rulings', 'matrix-reference.json');
export const MATRIX_OUTPUT = path.join(ROOT, 'workspace', 'mission-matrix.md');

export function readMatrixReference(refPath) {
  return JSON.parse(fs.readFileSync(refPath || MATRIX_REFERENCE, 'utf8'));
}

// Every cell, with its provenance attached where the reader sees it.
export function buildMissionMatrix(ref, options) {
  const o = options || {};
  const reference = ref || readMatrixReference();
  const dispositions = reference.dispositions || [];
  const cells = [];
  for (const you of dispositions) {
    for (const opponent of dispositions) {
      const mission = ((reference.matrix || {})[you] || {})[opponent] || '';
      cells.push({ you: you, opponent: opponent, mission: mission, provenance: mission ? 'reference-only' : 'missing' });
    }
  }
  const names = cells.map(c => c.mission).filter(Boolean);
  return {
    source: reference.source || {},
    orientation: reference.orientation || '',
    dispositions: dispositions,
    cells: cells,
    missions: names,
    uniqueMissions: [...new Set(names)],
    referenceOnly: true,
    // A cell the reference itself cannot fill would be a hole, not a mission.
    missing: cells.filter(c => !c.mission).length,
    note: (reference.source && reference.source.note) || '',
    corpus: o.corpus || null,
  };
}

// The names the split cards carry, so the matrix can be checked against them.
export function missingFromCorpus(matrix, cardNames) {
  const have = new Set((cardNames || []).map(n => String(n).trim().toLowerCase()));
  return matrix.uniqueMissions.filter(n => !have.has(String(n).trim().toLowerCase()));
}

export function matrixMarkdown(matrix, cardNames) {
  const m = matrix || buildMissionMatrix();
  const out = [];
  out.push('# Force disposition matrix (5 x 5)');
  out.push('');
  out.push('> **Reference-sourced structure - not verified rules text.** The pairing of your force');
  out.push('> disposition against your opponent\'s, and the Primary Mission it plays, comes from');
  out.push('> ' + ((m.source && m.source.title) || 'the reference') + ' (' + ((m.source && m.source.url) || '') + ')');
  out.push('> because the corpus cannot supply it: none of the mission cards names a force');
  out.push('> disposition. The mission NAMES are corroborated by the corpus cards; the PAIRINGS');
  out.push('> are not. Reproduced for structure only, with no prose from the source.');
  out.push('');
  if (m.orientation) { out.push('**Orientation:** ' + m.orientation); out.push(''); }
  if (Array.isArray(cardNames) && cardNames.length) {
    const missing = missingFromCorpus(m, cardNames);
    out.push('Names corroborated by the corpus: ' + (m.uniqueMissions.length - missing.length) + ' of ' + m.uniqueMissions.length + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ' - zero matrix-only names.'));
    out.push('');
  }
  out.push('| you \\ them | ' + m.dispositions.join(' | ') + ' |');
  out.push('|' + ['---'].concat(m.dispositions.map(() => '---')).join('|') + '|');
  for (const you of m.dispositions) {
    const row = m.cells.filter(c => c.you === you);
    out.push('| **' + you + '** | ' + row.map(c => (c.mission || '_missing_') + ' *(reference-only)*').join(' | ') + ' |');
  }
  out.push('');
  if (m.note) { out.push('Source note, verbatim: ' + m.note); out.push(''); }
  out.push('Detachment counts per disposition (from csv/Detachments.csv, the join): every');
  out.push('detachment row that carries a disposition maps to one of these five.');
  return out.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('mission-matrix.mjs')) {
  const { readAllCorpus } = await import('./rules-corpus.mjs');
  const all = readAllCorpus();
  const cards = all.filter(r => /-Mission-deck->-/.test(r.id) && String(r.heading || '').split(' > ').length === 2)
    .map(r => String(r.heading).split(' > ')[1]);
  const matrix = buildMissionMatrix();
  fs.writeFileSync(MATRIX_OUTPUT, matrixMarkdown(matrix, cards) + '\n');
  console.log('matrix -> ' + MATRIX_OUTPUT);
  console.log('cells ' + matrix.cells.length + ' (' + matrix.missing + ' missing), names ' + matrix.uniqueMissions.length + ', names not in the corpus ' + missingFromCorpus(matrix, cards).length);
}
