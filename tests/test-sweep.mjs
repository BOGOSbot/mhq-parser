import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASK_MODES, applySweepVerdicts, judgePrompt, normalizeChecks, readAllCorpus, runChecks, sweepChecks,
} from '../src/rules-corpus.mjs';

// task-43: the deep sweep. The judge names what it would have to look up to be sure
// nothing is missing, each check is run FOR REAL through the same two legs the
// retrieval uses, and the judge is shown what came back and asked to resolve it.
//
// The three properties that matter, and the one that must never be relaxed:
//   1. the loop TERMINATES, and every bound that stopped it is reported;
//   2. 'absent' is only ever said after a search RAN - a search that threw, or that
//      the budget stopped, is unresolved, never absent;
//   3. fast mode is untouched: no checks in the prompt, byte-identical prompt.
// The model call is injected, so these are pinned without spending a real call.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const passages = [
  { id: 'core-rules#A', heading: 'Fall Back', ruleId: '09.07', set: 'rules', text: 'A unit that Falls Back cannot shoot.' },
  { id: 'core-rules#B', heading: 'Shooting Phase', ruleId: '05', set: 'rules', text: 'A unit may shoot in the Shooting phase.' },
];
const corpus = readAllCorpus();

// --- the prompt -------------------------------------------------------------
const base = judgePrompt('can a unit shoot after falling back?', passages, {});
ok('the fast prompt carries no checks field', base.indexOf('checks') === -1);
ok('and no checks bullet', base.indexOf('- checks:') === -1);
ok('the fast prompt is byte-identical whether the option is absent or false',
  judgePrompt('can a unit shoot after falling back?', passages, { sweep: false }) === base);
ok('the fast prompt is byte-identical to the one with no options at all',
  judgePrompt('can a unit shoot after falling back?', passages, {}) === base);
const swept = judgePrompt('can a unit shoot after falling back?', passages, { sweep: true });
ok('the deep prompt declares the checks schema', swept.indexOf('"checks"') !== -1);
ok('and the bullet that explains what a check is', swept.indexOf('- checks:') !== -1 && swept.indexOf('not "follow"') !== -1);
ok('the sweep prompt is longer than the fast one, by that clause only', swept.length > base.length && swept.indexOf('checks') !== -1);

// --- the checks the judge asked for -----------------------------------------
ok('normalizeChecks caps the list', normalizeChecks([{ query: 'a b c' }, { query: 'd e f' }, { query: 'g h i' }], 2).length === 2);
ok('it drops a query with no words to search on', normalizeChecks([{ what: 'x', query: '?!' }, { what: 'y', query: 'ab' }]).length === 0);
ok('it keeps a usable one and names it', normalizeChecks([{ what: 'a claim', query: 'fall back shoot' }])[0].what === 'a claim');
ok('a bare string becomes both what and query', normalizeChecks(['fall back shoot'])[0].query === 'fall back shoot');
ok('a non-array is no checks at all', normalizeChecks(null).length === 0 && normalizeChecks({ query: 'x' }).length === 0);

// --- the search is real, and never surfaces a filtered record ---------------
const shown = new Set();
const ran = await runChecks([{ what: 'whether anything grants it', query: 'fall back shoot' }], { corpus: corpus, shown: shown, hits: 3, vector: false });
ok('a check runs the lexical leg for real', ran[0].ran === true && ran[0].hits.length > 0);
ok('and every hit is a record the product delivers',
  ran[0].hits.every(h => { const rec = corpus.find(r => String(r.id) === h.id); return !!rec && String(rec.kind || '') !== 'index'; }));
ok('no Legends record can reach a check', ran[0].hits.every(h => !/legends/i.test(h.id)));
const empty = await runChecks([{ what: 'nothing', query: 'zzzqqqxxyyww' }], { corpus: corpus, shown: shown, hits: 3, vector: false });
ok('a search that finds nothing still RAN', empty[0].ran === true && empty[0].hits.length === 0);

// --- absent only after a search ---------------------------------------------
const absent = applySweepVerdicts(empty, { checks: [{ n: 1, absent: true, why: 'nothing there' }] });
ok('an empty search the judge read can be absent', absent[0].verdict === 'absent');
const notRun = applySweepVerdicts([{ what: 'x', query: 'y', ran: false, hits: [], error: 'boom' }], { checks: [{ n: 1, absent: true }] });
ok('a search that did NOT run is never absent', notRun[0].verdict === 'unresolved');
const silent = applySweepVerdicts(ran, { checks: [] });
ok('a check the judge said nothing about is unresolved', silent[0].verdict === 'unresolved');
const invented = applySweepVerdicts(ran, { checks: [{ n: 1, id: 'invented#id' }] });
ok('a verdict naming a record the search did not return is refused', invented[0].verdict === 'unresolved');
const answered = applySweepVerdicts(ran, { checks: [{ n: 1, id: ran[0].hits[0].id, why: 'this one' }] });
ok('a verdict naming a real hit is answered', answered[0].verdict === 'answered' && answered[0].id === ran[0].hits[0].id);
const outOfRange = applySweepVerdicts(ran, { checks: [{ n: 9, absent: true }] });
ok('a verdict about a check that does not exist is ignored', outOfRange[0].verdict === 'unresolved');

// --- the loop: termination, bounds, and the absent ending -------------------
const loopOpts = extra => Object.assign({
  corpus: corpus, shown: new Set(), vector: false, hits: 3,
  rounds: 2, checksPerRound: 4, calls: 2, budgetMs: 60000,
}, extra);
// (1) an empty list is the judge saying it is sure: no round, no call.
const none = await sweepChecks('q', [], loopOpts({ ask: async () => '{}' }));
ok('no checks means no round and no call', none.rounds === 0 && none.calls === 0 && none.checks.length === 0);
ok('and it reports its bounds anyway', none.bounds.rounds === 2 && none.bounds.calls === 2 && none.bounds.checksPerRound === 4 && none.bounds.budgetMs === 60000);
// (2) the absent ending: one round, every check absent, the loop stops on 'absent'.
let asked = 0;
const absentRun = await sweepChecks('q', [{ what: 'a', query: 'zzzqqqxxyy' }, { what: 'b', query: 'zzzqqqxxyy' }], loopOpts({
  ask: async () => { asked++; return JSON.stringify({ checks: [{ n: 1, absent: true, why: 'no' }, { n: 2, absent: true, why: 'no' }] }); },
}));
ok('an all-absent round ends the loop', absentRun.rounds === 1 && absentRun.stopped === 'absent');
ok('and it made exactly one call', absentRun.calls === 1 && asked === 1);
ok('both checks are recorded absent, by name', absentRun.absent.length === 2 && absentRun.absent[0] === 'a');
ok('with no search left unresolved', absentRun.unresolved === 0);
// (3) the call bound: a round that resolves nothing does not spin.
let asked2 = 0;
const unresolvedRun = await sweepChecks('q', [{ what: 'a', query: 'fall back shoot' }], loopOpts({
  ask: async () => { asked2++; return JSON.stringify({ checks: [] }); },
}));
ok('a round that resolves nothing ends on nothing-new', unresolvedRun.stopped === 'nothing-new' && unresolvedRun.rounds === 1 && asked2 === 1);
ok('and the check is unresolved, never absent', unresolvedRun.checks[0].verdict === 'unresolved' && unresolvedRun.absent.length === 0);
// (4) the rounds bound: a judge that keeps resolving checks with records can still not
// loop forever. It has to resolve one per round - a round that resolves nothing ends
// the loop on 'nothing-new', which is a different ending and is pinned above. The id
// is read off a 'c<n> [id]' line, not the first bracket in the prompt: a corpus id can
// contain a bracket of its own (rules-appendix#[ONE-SHOT]...).
const hitId = prompt => ((prompt.match(/c1 \[([^\]]+)\]/) || [])[1] || '');
let asked3 = 0;
// A judge that never settles: it names no record and does not call the search empty,
// so the check stays unresolved and the loop has to be stopped by a bound.
const manyRounds = await sweepChecks('q', [{ what: 'whether shooting is allowed at all', query: 'shooting' }], loopOpts({
  rounds: 2, calls: 5,
  ask: async () => { asked3++; return JSON.stringify({ checks: [{ n: 1, id: null, absent: false, why: 'still unsure' }] }); },
}));
ok('the rounds bound stops the loop and is reported', manyRounds.stopped === 'rounds' && manyRounds.rounds === 2 && asked3 === 2);
// task-49 re-anchored this pin: `checks` is every ATTEMPT (both rounds are recorded
// for the trace) and `unresolved` counts the FINAL view, which is one entry per check.
ok('and every round it ran is recorded, unresolved', manyRounds.checks.length === 2 && manyRounds.final.length === 1 && manyRounds.unresolved === 1 && manyRounds.absent.length === 0);
// (5) the calls bound is reported too.
let asked4 = 0;
const manyCalls = await sweepChecks('q', [{ what: 'whether shooting is allowed at all', query: 'shooting' }], loopOpts({
  rounds: 9, calls: 1,
  ask: async () => { asked4++; return JSON.stringify({ checks: [{ n: 1, id: null, absent: false, why: 'still unsure' }] }); },
}));
ok('the calls bound stops the loop and is reported', manyCalls.stopped === 'calls' && manyCalls.calls === 1 && asked4 === 1);
// (5b) a check the judge cannot settle is re-run on the CLAIM's own words, not on the
//      same query: the same search would return the same list.
let asked5 = 0;
let asked6 = 0;
const rephrased = await sweepChecks('q', [{ what: 'whether shooting is allowed after falling back', query: 'shooting' }], loopOpts({
  rounds: 2, calls: 5,
  ask: async prompt => { asked5++; return JSON.stringify({ checks: [{ n: 1, id: null, absent: false, why: 'unsure' }] }); },
}));
ok('an unresolved check is carried into a second round', rephrased.rounds === 2 && asked5 === 2);
ok('and the second round searches the claim, not the same words', rephrased.checks.length === 2 && rephrased.checks[1].query === 'whether shooting is allowed after falling back');
// (6) the budget: a clock already spent ends it before the first search, and the
//     checks that did run are kept as unresolved - never absent.
const broke = await sweepChecks('q', [{ what: 'a', query: 'fall back shoot' }], loopOpts({
  budgetMs: 1, startedAt: Date.now() - 5000, ask: async () => { throw new Error('must not be called'); },
}));
ok('a spent budget stops the loop before any call', broke.stopped === 'budget' && broke.calls === 0);
ok('and nothing is called absent on a budget stop', broke.absent.length === 0);
// (7) a judge call that throws leaves the check unresolved.
const threw = await sweepChecks('q', [{ what: 'a', query: 'fall back shoot' }], loopOpts({ ask: async () => { throw new Error('model down'); } }));
ok('a judge call that throws leaves the check unresolved', threw.checks[0].verdict === 'unresolved' && threw.absent.length === 0);
// (8) an answered check is reported as answered, and the loop keeps its one round.
const answeredRun = await sweepChecks('q', [{ what: 'a', query: 'fall back shoot' }], loopOpts({
  ask: async prompt => JSON.stringify({ checks: [{ n: 1, id: hitId(prompt), why: 'this one' }] }),
}));
ok('a check the judge resolved with a record is answered', answeredRun.checks[0].verdict === 'answered' && !!answeredRun.checks[0].id);
ok('and it is not counted absent', answeredRun.absent.length === 0 && answeredRun.answered === 1);

// --- task-49: one row per check, and silence that says so ---------------------
// (9) an empty checks list is a RESULT, not a silence: the judge answered and named
//     nothing to check, and the event says so with a reason.
const nothing = await sweepChecks('q', [], loopOpts({ ask: async () => { throw new Error('must not be called'); } }));
ok('no checks is reported as nothing-to-check, not as an empty stop', nothing.stopped === 'nothing-to-check');
ok('and it ran no round and no call', nothing.rounds === 0 && nothing.calls === 0);
ok('its final view is empty and so is its absence list', nothing.final.length === 0 && nothing.absent.length === 0);
// (10) a retried check is ONE check: `checks` keeps every attempt for the trace and
//      `final` carries one entry per check with the LAST outcome.
const retried = await sweepChecks('q', [{ what: 'whether shooting is allowed after falling back', query: 'shooting' }], loopOpts({
  rounds: 2, calls: 5,
  ask: async prompt => (asked6++ === 0)
    ? JSON.stringify({ checks: [{ n: 1, id: null, absent: false, why: 'unsure' }] })
    : JSON.stringify({ checks: [{ n: 1, id: null, absent: true, why: 'nothing there' }] }),
}));
ok('the event keeps every attempt', retried.checks.length === 2);
ok('and the final view has ONE entry for the retried check', retried.final.length === 1);
ok('carrying the LAST outcome', retried.final[0].verdict === 'absent');
ok('and the number of attempts it took', retried.final[0].attempts === 2);
ok('the absence list counts the check once', retried.absent.length === 1);
// (11) the renderer collapses by the same key, so a retried check cannot print twice.
//      Extracted from the client, the way tests/test-rules-page.mjs extracts rowName.
const SURFACE = read('src/wiki-surface.js');
const fnSrc = name => { const at = SURFACE.indexOf('function ' + name + '('); if (at === -1) return ''; let depth = 0; for (let i = SURFACE.indexOf('{', at); i < SURFACE.length; i++) { if (SURFACE[i] === '{') depth++; else if (SURFACE[i] === '}') { depth--; if (!depth) return SURFACE.slice(at, i + 1); } } return ''; };
const sweepRows = new Function(fnSrc('sweepRows') + '; return sweepRows;')();
const sweepSaid = new Function(fnSrc('sweepSaid') + '; return sweepSaid;')();
const collapsed = sweepRows({ checks: [
  { n: 1, what: 'the D6 threshold', verdict: 'unresolved' },
  { n: 2, what: 'another thing', verdict: 'absent' },
  { n: 1, what: 'the D6 threshold', verdict: 'absent' },
] });
ok('the renderer shows one row per check', collapsed.length === 2);
ok('with the last outcome on the retried one', collapsed[0].verdict === 'absent' && collapsed[0].attempts === 2);
ok('and the untouched one keeps its own', collapsed[1].verdict === 'absent' && collapsed[1].attempts === 1);
ok('the retry is named as a detail on that row only', sweepSaid(collapsed[0]).indexOf('re-run on its own words') !== -1 && sweepSaid(collapsed[1]).indexOf('re-run') === -1);
ok('a check with no n falls back to its position', sweepRows({ checks: [{ what: 'a', verdict: 'absent' }, { what: 'b', verdict: 'absent' }] }).length === 2);
ok('an empty event collapses to no rows', sweepRows({ checks: [] }).length === 0 && sweepRows(null).length === 0);
// The empty case and the footer, as source: the count comes from the rows drawn.
ok('an empty sweep says nothing was to be checked', SURFACE.indexOf('Nothing to check') !== -1 && /sv-sweep-none/.test(SURFACE));
// A sweep that FAILED is not entitled to the corpus claim: the empty case branches on
// the reason, and the failed branch must exist and be reachable.
ok('a failed sweep says it could not run, not that there was nothing', /var failed = s\.stopped === 'failed'/.test(SURFACE) && SURFACE.indexOf('Could not check') !== -1);
ok('and the two empty cases are different strings', SURFACE.indexOf('Could not check') !== SURFACE.indexOf('Nothing to check'));
ok('the footer counts the rows it drew, not the attempts', /Checked ' \+ rows\.length/.test(SURFACE) && !/Checked ' \+ s\.checks\.length/.test(SURFACE));
ok('and the absent count comes from the same rows', /rows\.filter\(function \(r\) \{ return r\.verdict === 'absent'; \}\)\.length/.test(SURFACE));
// The event still carries every attempt for the trace, so nothing is lost.
ok('the event keeps the attempts and adds the final view', /checks: all, final: final/.test(read('src/rules-corpus.mjs')));
ok('and the server emits the sweep even with nothing to check', /mode\.sweep && judge && judge\.answered === true\)/.test(read('src/server.mjs')) && !/judge\.checks\.length\)\s*$/.test(read('src/server.mjs').slice(read('src/server.mjs').indexOf('const sweepRun'), read('src/server.mjs').indexOf('const sweepRun') + 200)));
// --- the mode and the wiring ------------------------------------------------
ok('deep is the mode that sweeps', !!ASK_MODES.deep.sweep && ASK_MODES.fast.sweep === undefined);
ok('the deep bounds are the ones the card names', ASK_MODES.deep.sweep.rounds === 2 && ASK_MODES.deep.sweep.checksPerRound === 4 && ASK_MODES.deep.sweep.calls === 2);
const server = read('src/server.mjs');
ok('the sweep runs only in deep mode, and only on an answered question', /mode\.sweep && judge && judge\.answered === true/.test(server));
ok('the sweep clause rides in the judge prompt', /sweep: !!mode\.sweep/.test(server));
ok('the budget is the sweep\'s own clock, not the ask\'s', /startedAt: Date\.now\(\),/.test(server) && /budgetMs: mode\.sweep\.budgetMs/.test(server));
ok('the event is emitted and carried in the JSON reply', /type: 'sweep'/.test(server) && /judge, sweep, answer/.test(server));
ok('the sweep never reorders the findings', /const sweepRun = /.test(server) && /sweepRun \? await sweepRun : null/.test(server));

console.log('sweep bounds ' + JSON.stringify(ASK_MODES.deep.sweep));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
