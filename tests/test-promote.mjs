import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KINDS, bankQuestions, candidates, entryLine, insertEntry, loadTraces, norm, parseExpectation, readerPick, traceStatus, validateExpectation } from './promote-traces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- who may be promoted -----------------------------------------------------
// A writer that failed is a broken run, not a question, and it must not reach the
// bank by accident - including a trace written before the writer field existed,
// where the empty answer is the only evidence there is.
const bank = ['What is Engagement?'];
t('a real question is promotable', traceStatus({ question: 'Can a unit shoot after it Fell Back?', writer: 'ok', answer: 'Yes.' }, bank), 'promotable');
t('a declined answer is still a real question', traceStatus({ question: 'Q?', writer: 'declined', answer: 'The findings do not answer this question.' }, bank), 'promotable');
t('an empty writer is refused', traceStatus({ question: 'Q?', writer: 'empty', answer: '' }, bank), 'writer-empty');
t('a timed-out writer is refused', traceStatus({ question: 'Q?', writer: 'timeout', answer: '' }, bank), 'writer-timeout');
t('a missing field with an empty answer is refused', traceStatus({ question: 'Q?', answer: '' }, bank), 'writer-empty');
t('a missing field with an answer is allowed', traceStatus({ question: 'Q?', answer: 'Yes.' }, bank), 'promotable');
t('a question already in the bank is not promoted twice', traceStatus({ question: 'what is   ENGAGEMENT?', writer: 'ok', answer: 'x' }, bank), 'already-in-bank');
t('the question match ignores case and space', norm('  What IS   Engagement? '), 'what is engagement?');

// --- what the human is offered ----------------------------------------------
t('candidates are the records the page retrieved, in order', candidates({ findings: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, 2), ['a', 'b']);
t('candidates survive an empty findings list', candidates({ findings: [] }), []);

// --- the entry ---------------------------------------------------------------
t('the labels are the bank\'s own', KINDS, ['literal', 'paraphrase', 'player', 'cross-source', 'multi-hop', 'out-of-corpus']);
const line = entryLine({ q: 'Can a unit shoot after it Fell Back?', expect: ['core-rules#Shooting'], kind: 'player' });
t('one line, valid JSON', JSON.parse(line), { q: 'Can a unit shoot after it Fell Back?', expect: ['core-rules#Shooting'], kind: 'player' });
t('no newline in the entry', line.indexOf('\n'), -1);

// --- appending leaves everything above it alone ------------------------------
const fixture = '{\r\n  "questions": [\r\n    { "q": "a", "expect": [], "kind": "literal" }\r\n  ]\r\n}\r\n';
const grown = insertEntry(fixture, line);
t('the file still parses', JSON.parse(grown).questions.length, 2);
t('the new entry is last', JSON.parse(grown).questions[1].q, 'Can a unit shoot after it Fell Back?');
t('the old entry survives unchanged, with a comma appended', grown.indexOf('    { "q": "a", "expect": [], "kind": "literal" },\r\n') !== -1, true);
t('the comma was added to the previous entry', grown.indexOf('"kind": "literal" },') !== -1, true);
t('the closing bracket is still there', grown.endsWith('  ]\r\n}\r\n'), true);
t('CRLF is preserved', grown.indexOf('\r\n') !== -1 && grown.indexOf('\n\n') === -1, true);
t('a file that does not end in a questions array is refused', (() => { try { insertEntry('nope', line); return 'no throw'; } catch (e) { return 'threw'; } })(), 'threw');

// --- an id may itself contain the separator ----------------------------------
// The FAQ-derived corpus ids carry commas of their own, and --expect separates
// ids with one: a comma that belongs to an id is escaped, and the escape is only
// the CLI's - the fixture gets the id the corpus spells.
t('plain ids split on the comma', parseExpectation('a,b'), ['a', 'b']);
t('an escaped comma belongs to the id', parseExpectation('a\\,b,c'), ['a,b', 'c']);
t('a comma-free id is unchanged', parseExpectation('core-rules#Shooting'), ['core-rules#Shooting']);
t('whitespace around an id is trimmed', parseExpectation('  a  ,  b  '), ['a', 'b']);
t('an empty --expect names no ids', parseExpectation(''), []);
t('and neither does a missing one', parseExpectation(null), []);
t('the real Secured-Objectives id survives the parser',
  parseExpectation('unitrules#000002541~2,core-rules#Secured-Objectives->-Q:-If-my-unit-has-taken-control-of-an-objective-at-the-end-of-my-movement-phase-and-that-unit-has-as-an-ability-that-secures-an-objective-they-control\\,-can-they-secure-that-objective?'),
  ['unitrules#000002541~2', 'core-rules#Secured-Objectives->-Q:-If-my-unit-has-taken-control-of-an-objective-at-the-end-of-my-movement-phase-and-that-unit-has-as-an-ability-that-secures-an-objective-they-control,-can-they-secure-that-objective?']);

// --- expectations are checked against the corpus -----------------------------
t('an id the corpus does not have is reported', validateExpectation(['nope#x'], [{ id: 'a#b' }]), ['nope#x']);
t('an id the corpus has passes', validateExpectation(['a#b'], [{ id: 'a#b' }]), []);

// --- the real bank -----------------------------------------------------------
t('the bank parses and has questions', bankQuestions().length > 20, true);
t('the trace directory is read', Array.isArray(loadTraces()), true);

// --- the reader's pick reaches the harvest -----------------------------------
// The pick is the strongest candidate a trace carries, and the harvest is where a
// human reads the candidates: it is printed, and it does not become the
// expectation on its own. The trace's kind is still unknown, and --promote still
// demands a human --kind and --expect.
t('no pick is shown when the reader made none', readerPick({ findings: [] }), '');
t('the record the reader chose is shown', readerPick({ answeredBy: 'core-rules#Shooting' }), 'answeredBy: core-rules#Shooting');
t('none of these is shown as its own candidate', readerPick({ answeredNone: true }), 'answeredNone: true');

const harvestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-harvest-'));
try {
  const base = { at: '2026-10-13T12:00:00.000Z', lang: 'en', mode: 'deep', writer: 'ok', answer: 'Yes [1].', kind: 'unknown',
    judge: { answered: true, cited: [1] }, signals: { sources: ['core-rules'] },
    findings: [{ n: 1, set: 'rules', source: 'core-rules', id: 'core-rules#Shooting' }] };
  fs.writeFileSync(path.join(harvestDir, '2026-10.ndjson'),
    JSON.stringify(Object.assign({}, base, { id: 'feedfacefeedface', question: 'Can a unit shoot after it Fell Back?', answeredBy: 'core-rules#Shooting' })) + '\n'
    + JSON.stringify(Object.assign({}, base, { id: 'cafecafecafecafe', question: 'What is the Melta rule?', answeredNone: true })) + '\n');
  const script = path.join(__dirname, 'promote-traces.mjs');
  const h = spawnSync(process.execPath, [script, '--harvest', '--all', '--dir', harvestDir, '--limit', '10'], { encoding: 'utf8' });
  t('the harvest runs on a trace that carries a pick', h.status, 0);
  t('and prints the record the reader chose', /answeredBy: core-rules#Shooting/.test(h.stdout), true);
  t('and prints none-of-these', /answeredNone: true/.test(h.stdout), true);
  const noKind = spawnSync(process.execPath, [script, '--promote', '--id', 'feedfacefeedface', '--dir', harvestDir], { encoding: 'utf8' });
  t('a pick promotes nothing on its own', noKind.status, 1);
  t('and --kind is still the human\'s', /--kind must be one of/.test(noKind.stdout), true);
} finally { fs.rmSync(harvestDir, { recursive: true, force: true }); }

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
