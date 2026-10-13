import fs from 'node:fs';
import { KINDS, bankQuestions, candidates, entryLine, insertEntry, loadTraces, norm, traceStatus, validateExpectation } from './promote-traces.mjs';

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

// --- expectations are checked against the corpus -----------------------------
t('an id the corpus does not have is reported', validateExpectation(['nope#x'], [{ id: 'a#b' }]), ['nope#x']);
t('an id the corpus has passes', validateExpectation(['a#b'], [{ id: 'a#b' }]), []);

// --- the real bank -----------------------------------------------------------
t('the bank parses and has questions', bankQuestions().length > 20, true);
t('the trace directory is read', Array.isArray(loadTraces()), true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
