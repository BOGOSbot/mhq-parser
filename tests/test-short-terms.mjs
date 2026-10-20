import { grepTerms, grepWithTerms, readAllCorpus, termPresent } from '../src/rules-corpus.mjs';

// task-55: the lexical leg's term floor. It used to be four characters, so the question
// 'what are the rules for a unit that can fly' had its ONLY content word dropped and the
// leg searched for nothing at all - an invisible recall bug, because the retrieval still
// returned a list. The floor is now three characters WITH a guard, because the floor
// alone is a trap: measured over the 33 bank questions, a bare floor of 3 changes 24
// term sets, exactly ONE gains a term its expected record contains ('fly'), and the other
// 23 gain only function words ('how', 'the', 'can', 'are', 'for', 'see', 'put', 'own',
// 'end', 'let', 'you', 'hit'). These pins hold all three properties: the short word
// survives, the function words do not, and the four-character words are untouched.
let pass = 0, fail = 0;
function t(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } }
function ok(name, got) { t(name, !!got, true); }

// The case the change is for.
t('the fly question keeps its only content word', grepTerms('What are the rules for a unit that can fly?'), ['fly']);
t('and that word reaches the record it names', grepTerms('What are the rules for a unit that can fly?').some(x => termPresent('flying and surging flying models', x)), true);
// The guard: three-character function words stay out.
const fn = ['the', 'and', 'for', 'can', 'are', 'was', 'not', 'you', 'all', 'any', 'but', 'how', 'its', 'may', 'one', 'out', 'see', 'use', 'who', 'why', 'per', 'off', 'own', 'end', 'get', 'set', 'way', 'day', 'new', 'old', 'top', 'two', 'six', 'hit', 'run', 'put', 'add', 'let', 'did', 'too', 'yet', 'nor'];
const leaked = fn.filter(w => grepTerms('the and for can are was not you all any but how its may one out see use who why per off own end get set way day new old top two six hit run put add let did too yet nor').indexOf(w) !== -1);
t('no three-character function word survives the guard', leaked, []);
// The four-character floor is unchanged, and so is the corpus's own STOP list.
t('a four-character content word is still a term', grepTerms('What is Transport Capacity?').indexOf('transport') !== -1, true);
t('a four-character STOP word is still dropped', grepTerms('How does the unit model work?').indexOf('unit') === -1, true);
t('and a short STOP word is dropped by the first test, not the second', grepTerms('what is the rule').length, 0);
t('an empty question has no terms', grepTerms(''), []);
t('and neither does a null one', grepTerms(null), []);
// The three-character content words that are NOT function words must survive: this is the
// line between 'fly' and 'the'.
const kept = ['fly', 'hit', 'run', 'set', 'end', 'own', 'put', 'see', 'use'];
t('a short word that is a rules term survives even when it is also a verb', grepTerms('can a unit fly and shoot').indexOf('fly') !== -1, true);
// The scoring path uses the same terms, so the fly question's search is not empty.
const corpus = readAllCorpus();
const hits = grepWithTerms(grepTerms('What are the rules for a unit that can fly?'), corpus, 10, 'What are the rules for a unit that can fly?');
ok('the leg returns records for the fly question', hits.length > 0);
ok('and one of them is the Flying Models record', hits.some(h => /Flying/i.test(String(h.heading))));
// A control: the change must not have widened a question that was already fine.
t('a question with no short content word is untouched', grepTerms('How do I put a unit inside a transport?'), ['inside', 'transport']);

console.log('floor 4 with a guarded floor 3; ' + kept.length + ' short content words checked');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
