#!/usr/bin/env node
'use strict';
/**
 * Real French questions, end to end.
 *
 *   node tests/ask-fr.mjs [--id wracks-battleshock]
 *
 * The corpus is English. A French question has to be turned into English search
 * terms before anything can be retrieved, so this exercises the whole path:
 * glossary + the model for the terms, the dual index for the findings, the
 * judge for a verdict, and a French answer compiled from those findings.
 *
 * Each question carries the answer a French player gave, so the compiled answer
 * can be read against it rather than only scored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credential, fastCredential, modelCredential, FAST_MODEL, MODEL } from '../src/rules.mjs';
import { compileFindings, findingFor, frenchTerms, judgeCoverage, readAllCorpus, retrieveDual } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const only = (() => { const i = process.argv.indexOf('--id'); return i === -1 ? null : process.argv[i + 1]; })();
const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-questions-fr.json'), 'utf8'));
const questions = only ? bank.questions.filter(q => q.id === only) : bank.questions;

const rulesCorpus = readAllCorpus('rules');
const factionsCorpus = readAllCorpus('factions');
const JEV = credential('OPENCODE_GO_API_KEY');
const FAST = fastCredential();    // the translation and the judge
const SENSE = modelCredential();  // the French answer

let answered = 0;
for (const item of questions) {
  console.log('\n' + '='.repeat(78));
  console.log('[' + item.id + ']  writer ' + MODEL + '  judge/terms ' + FAST_MODEL);
  console.log('Q  ' + item.q.replace(/\s+/g, ' ').slice(0, 300));
  const t0 = Date.now();
  const terms = await frenchTerms(item.q, FAST);
  console.log('\nterms (' + terms.length + ') ' + JSON.stringify(terms.slice(0, 10)));
  const dual = await retrieveDual(item.q, { rulesCorpus, factionsCorpus, jevKey: JEV, terms, grepNet: 60, jevMax: 80 });
  const findings = dual.all.map((s, i) => findingFor(s, i + 1));
  const verdict = await judgeCoverage(item.q, findings, FAST).catch(e => ({ answered: null, passages: [], why: e.message }));
  const answer = await compileFindings(item.q, findings, SENSE, { lang: 'fr' }).catch(e => 'compile failed: ' + e.message);
  console.log('\nfindings (' + dual.rules.length + ' core, ' + dual.factions.length + ' faction):');
  for (const f of findings) console.log('  [' + f.n + '] ' + (f.set === 'factions' ? 'FACTION ' : 'CORE    ') + f.heading + (f.ruleId ? '  (' + f.ruleId + ')' : ''));
  console.log('\njudge: ' + (verdict.answered ? 'the findings answer it' : 'the findings do NOT answer it') + '  - ' + verdict.why);
  console.log('\nANSWER (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)\n' + (answer || '(none)'));
  console.log('\nEXPECTED  ' + item.expected);
  if (verdict.answered) answered++;
}
console.log('\n' + '='.repeat(78));
console.log('judged answerable: ' + answered + '/' + questions.length);
