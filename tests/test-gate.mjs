import { HALVES, gateHalf, gatePrompt } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- the shape ---------------------------------------------------------------
// One short item in, one label out. The gate is only worth its call if the
// answer is a choice between the two halves and nothing else - a free-text
// answer would need parsing, and parsing a route is how a wrong route gets
// silently invented.
const q = gatePrompt('How many points does a Space Marine Captain cost?');
t('one question', Object.keys(q), ['half']);
t('it is a choice, not a judgement', q.half.type, 'choice');
t('the labels are exactly the two halves', Object.keys(q.half.criteria).sort(), ['factions', 'rules']);
t('the question is in the instruction', q.half.instructions.includes('Space Marine Captain'), true);
t('the halves are the two namespaces', HALVES, ['rules', 'factions']);

// --- no key, no route --------------------------------------------------------
// A missing key must not produce a guess: the caller decides what an un-routed
// question does, and searching both is the safe reading.
const none = await gateHalf('What is Engagement?', '');
t('no key means no half', none.half, '');
t('no key means no confidence', none.confidence, null);
t('no key is reported, not hidden', typeof none.error, 'string');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
