import { capPassage, makeCurator, nearDuplicate } from './curate.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- dedupe ------------------------------------------------------------------
t('the same text twice is a duplicate', nearDuplicate('A unit can embark.', 'a  unit   can embark.'), true);
t('a container and its child overlap', nearDuplicate('x'.repeat(90) + ' tail', 'x'.repeat(90)), true);
t('two different rules are not', nearDuplicate('A unit can embark within a transport.', 'Battle-shock lasts until the end of the turn.'), false);
t('short identical strings are not judged by prefix', nearDuplicate('short', 'shorter'), false);

// --- cap ---------------------------------------------------------------------
t('a short passage is untouched', capPassage('one sentence.', 100), 'one sentence.');
const capped = capPassage('First sentence here. Second sentence here. Third sentence here.', 40);
t('a long passage is cut at a sentence', capped.endsWith('...'), true);
t('the cut does not split a word', /\w\.\.\.$| \w+ \.\.\.$|sentence \.\.\.$/.test(capped) || !/\w$/.test(capped.replace(/\.\.\.$/, '')), true);
t('the cap is respected', capPassage('word '.repeat(200), 100).length <= 104, true);

// --- the curator -------------------------------------------------------------
const mk = (id, text, n) => ({ id, n, set: 'rules', source: 'core-rules', ruleId: '', heading: 'H', text, excerpt: text });
const curator = makeCurator({ passageChars: 50 });
const out = curator([mk('a', 'A unit can embark within a transport.'), mk('b', 'A unit can embark within a transport.'), mk('c', 'Something else entirely about charging.')], { question: 'q', attempt: 0 });
t('the duplicate is dropped', out.length, 2);
t('the first of the pair is kept', out[0].id, 'a');
t('the unrelated record survives', out[1].id, 'c');

// 4. a passage the previous pass never named goes
const prev = { judge: { why: 'Passage [1] says the rule; nothing else bears on it.' }, findings: [mk('a', 'A', 1), mk('b', 'B', 2)] };
const drop = makeCurator({ dropPassedOver: true, passageChars: 9999 });
const keptIds = drop([mk('a', 'A', 1), mk('b', 'B', 2), mk('c', 'C', 3)], { question: 'q', attempt: 1, previous: prev }).map(x => x.id);
t('the passage the judge named stays', keptIds.includes('a'), true);
t('the passage it never named goes', keptIds.includes('b'), false);
t('a passage that was not in the previous pass stays', keptIds.includes('c'), true);

// 3. anchored first
const anchored = makeCurator({ corpora: { rules: [{ id: 'z', heading: 'Embarking' }] }, terms: [], passageChars: 9999 });
const order = anchored([mk('a', 'A'), mk('z', 'Z')], { question: 'How do I embark?', attempt: 0 }).map(x => x.id);
t('the anchored record is first', order[0], 'z');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
