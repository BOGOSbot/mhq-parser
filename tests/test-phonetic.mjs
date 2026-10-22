import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONETIC_ALIASES, aliasWord, buildPhoneticIndex, levenshtein, phoneticDistance, phoneticIndexSize, phoneticKey, phoneticMatches, phoneticWords } from '../src/phonetic.mjs';
import { resetHeaderIndex, searchHeadings, phoneticIndex } from '../src/header-index.mjs';

// task-18: the phonetic leg. The key's rules are the note's, measured there; the
// ingest indexes the words INSIDE names (Agamatus lives only inside Agamatus
// Custodians) and the aliases are the hand-written ones the corpus cannot derive
// (Eldar -> Aeldari). The surface is /rules/find's own search.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const good = JSON.stringify(got) === JSON.stringify(want); if (good) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- the key ----------------------------------------------------------------
t('letters only, accents folded', [phoneticKey('Fuegan'), phoneticKey('Cérastes'), phoneticKey("T'au")], ['fuegan', 'kera', 'tau']);
t('ch folds to k, not s', [phoneticKey('Archon'), phoneticKey('arcon')], ['arkon', 'arkon']);
t('ph folds to f, gu to k and the silent final d goes', [phoneticKey('Fuegan'), phoneticKey('Wraithguard')], ['fuegan', 'vraitkar']);
t('silent finals go and doubles collapse', [phoneticKey('Kabalites'), phoneticKey('Ynnari')], ['kabali', 'inari']);
ok('vowels stay in', phoneticKey('Yvraine').indexOf('a') !== -1 && phoneticKey('Ynnead') !== phoneticKey('dans'));
t('the same word in two spellings meets', phoneticDistance('arcon', 'Archon'), 0);
t('one substitution is a near miss, not a rename', Math.round(phoneticDistance('cobalites', 'Kabalite') * 100) / 100, 0.17);
ok('a different word is far', phoneticDistance('archon', 'tyrannofex') > 0.6);
t('levenshtein is the normal one', [levenshtein('kitten', 'sitting'), levenshtein('', 'ab')], [3, 2]);

// --- the ingest -------------------------------------------------------------
const index = buildPhoneticIndex([
  { id: 'a', words: ['Agamatus', 'Custodians'] },
  { id: 'b', words: ['Archon'] },
  { id: 'c', words: ['Kabalite', 'Warriors'] },
  { id: 'd', words: ['Aeldari'] },
]);
t('every word of a name is a key, not just the whole name', phoneticIndexSize(index).words, 6);
t('a word inside a name is found by itself', phoneticMatches('agamatus custodians', index, { limit: 5 }).map(m => m.id), ['a']);
t('a misheard name is found', phoneticMatches('arcon', index, { limit: 5 })[0].id, 'b');
t('a French-accented plural is found', phoneticMatches('cobalites', index, { limit: 5 })[0].id, 'c');
t('the heard spelling is reported', /arcon~Archon/.test(phoneticMatches('arcon', index, { limit: 5 })[0].heard.join(',')), true);
t('a name the voice got right adds nothing new', phoneticMatches('fuegan', index, { limit: 5 }), []);
t('a question with no name adds nothing', phoneticMatches('can a unit shoot after it fell back', index, { limit: 5 }), []);

// --- the aliases the corpus cannot produce ----------------------------------
t('Eldar is 11th edition Aeldari', aliasWord('eldar'), 'aeldari');
t('dark eldar is rewritten whole to Drukhari', phoneticWords('dark eldar'), ['drukhari']);
ok('the alias table is hand-written and documented', Object.keys(PHONETIC_ALIASES).length >= 5 && PHONETIC_ALIASES.eldar === 'aeldari');

// --- the surface: /rules/find's own search ----------------------------------
resetHeaderIndex();
const arcon = searchHeadings('find arcon', { limit: 20 });
ok('a misheard lookup returns the record, phonetically', arcon.rows.length > 0 && arcon.rows[0].phonetic === true && /Archon/.test(arcon.rows[0].title));
ok('the row says how it was heard', Array.isArray(arcon.rows[0].heard) && arcon.rows[0].heard.join(',').indexOf('arcon~Archon') !== -1);
const cobalites = searchHeadings('find cobalites', { limit: 20 });
ok('a misheard plural returns the datasheet', cobalites.rows.some(r => r.phonetic && /Kabalite Warriors/.test(r.title)));
const eldar = searchHeadings('eldar', { limit: 40 });
ok('the old faction name reaches the new one', eldar.rows.some(r => r.phonetic && /Aeldari/.test(r.title)));
// task-33: the fixture was 'Agamatus Custodians', which the 2026-10-19 export re-issued
// away; the claim is the same with a name the export still carries literally.
const hit = searchHeadings('find redemptor dreadnought', { limit: 10 });
ok('clean text still wins with the literal tier first', hit.rows[0].phonetic !== true && /Redemptor Dreadnought/.test(hit.rows[0].title));
const clean = searchHeadings('fuegan', { limit: 10 });
ok('a name the reader spelled right is literal, with no phonetic noise', clean.rows.length >= 1 && clean.rows.every(r => !r.phonetic));
const noise = searchHeadings('can a unit shoot after it fell back', { limit: 40 });
ok('a question that names nothing stays empty', noise.rows.length === 0 && (noise.phonetic || 0) === 0);
// The rescue gate: 'oath of moment' is a name the corpus knows as a mention, so
// the query is not a misheard name and the leg must not fire. 'arcon' is not in
// the vocabulary at all, so it does.
ok('a known name in a mention does not fire the leg', searchHeadings('oath of moment').rows.length === 0);
ok('an unknown word does fire the leg', searchHeadings('find arcon').phonetic > 0);
ok('the phonetic map is built from the heading projection', phoneticIndexSize(phoneticIndex()).keys > 1000 && phoneticIndexSize(phoneticIndex()).words > 5000);
// The route says how a row was found: a phonetic row carries the heard spelling,
// so the drawer (and this test) can tell a misheard name from a literal match.
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
// task-35: the route's row shape moved into findRows(), so the flag and the heard
// spelling are pinned where they now live, and the route is pinned to that function.
// task-97: the row shape moved to src/search-core.mjs, the file the web bundle ships, so this is
// pinned where it lives and asserted on a REAL row rather than on a source string.
const CORE = fs.readFileSync(path.join(ROOT, 'src', 'search-core.mjs'), 'utf8');
// task-44: the route passes the Legends gate as well, which is a request parameter.
ok('the find route serves the phonetic flag and the heard spelling', /phonetic: r\.phonetic === true/.test(CORE) && /heard: r\.heard \|\| \[\]/.test(CORE) && /findRows\(q, \{ slugs: surfaceSlugMap\(\), delivered: delivered, allow: allow, cap: 40 \}\)/.test(SERVER));

// The real corpus, not a toy: the two traps the note names.
const trapIndex = phoneticIndex();
ok('Agamatus is reachable inside Agamatus Custodians', phoneticMatches('agamatus', trapIndex, { limit: 5 }).length > 0);
const ids = phoneticMatches('eldar', trapIndex, { limit: 5 });
ok('Eldar reaches Aeldari headings through the alias', ids.length > 0);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
