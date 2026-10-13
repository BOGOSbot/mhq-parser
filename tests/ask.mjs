#!/usr/bin/env node
'use strict';
/**
 * Ask a rules question end to end.
 *
 *   node tests/ask.mjs "can a unit shoot after it fell back?"
 *
 * Both halves are searched - core rules and faction rules - five findings each,
 * and every finding is printed with its link. The compiled answer is an
 * addition to those findings, never a substitute: the citations are the
 * product, and the reader can always go and read the rule. The judge is a
 * signal about the findings, not a replacement for them.
 */
import { credential, fastCredential, modelCredential, FAST_MODEL, MODEL } from '../src/rules.mjs';
import { compileFindings, findingFor, judgeCoverage, readAllCorpus, retrieveDual } from '../src/rules-corpus.mjs';

const question = process.argv.slice(2).filter(a => a.indexOf('--') !== 0).join(' ').trim();
if (!question) { console.error('usage: node tests/ask.mjs "<question>"'); process.exit(1); }

const JEV = credential('OPENCODE_GO_API_KEY');
const FAST = fastCredential();    // the judge, on the fast route
const SENSE = modelCredential();  // the writer

const t0 = Date.now();
const dual = await retrieveDual(question, { jevKey: JEV, grepNet: 60, jevMax: 80 });
const findings = dual.all.map((s, i) => findingFor(s, i + 1));
const retrieved = Date.now() - t0;

const t1 = Date.now();
const verdict = await judgeCoverage(question, findings, FAST).catch(e => ({ rulesQuestion: null, answered: null, passages: [], why: String(e.message) }));
const judged = Date.now() - t1;

const t2 = Date.now();
const answer = await compileFindings(question, findings, SENSE).catch(e => 'compile failed: ' + e.message);
const compiled = Date.now() - t2;

console.log('QUESTION  ' + question);
console.log('writer ' + MODEL + '  judge ' + FAST_MODEL);
console.log('retrieved in ' + retrieved + 'ms  |  judged in ' + judged + 'ms  |  compiled in ' + compiled + 'ms');
console.log('');
console.log('FINDINGS  ' + findings.length + '  (' + dual.rules.length + ' core, ' + dual.factions.length + ' faction)');
for (const f of findings) {
  console.log('  [' + f.n + '] ' + (f.set === 'factions' ? 'FACTION' : 'CORE   ') + '  ' + (f.faction ? f.faction + ' - ' : '') + f.heading + (f.ruleId ? '  (' + f.ruleId + ')' : ''));
  console.log('       ' + f.href);
  console.log('       ' + f.excerpt.replace(/\s+/g, ' ').slice(0, 200));
}
console.log('');
console.log('JUDGE  ' + (verdict.rulesQuestion === null ? 'unparsed: ' + verdict.why
  : (verdict.rulesQuestion ? '' : 'not a rules question  ') + (verdict.answered ? 'the findings answer it' : 'the findings do NOT answer it') + '  ' + verdict.why));
console.log('');
console.log('ANSWER');
console.log(answer || '(none)');
