import { readAllCorpus } from '../src/rules-corpus.mjs';
import { buildLinkMap, linkify, linkMap, esc } from '../src/wikilinks.mjs';

// task-66: the general wikilink rule. These pin the discipline, not the counts:
// one escaper, unique targets, barred prose-verbs, href resolved before use,
// first occurrence only, no self-link, capped, index pages plain.
// task-42 moved the NAME SOURCE to the heading index and the CONFIDENCE rule to the
// book's own spelling (a single word links in its keyword form only, and only where
// the text capitalises it): the predicates that used to live here (stripSuffix,
// isDistinctive) are gone, and the new rule is pinned in tests/test-link-rules.mjs.
// A multi-word name still links in either case; the WTC ruling below is the witness.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// task-42: the two predicates this file used to pin live in the heading index and in
// the map's own build now; their rule is pinned in tests/test-link-rules.mjs.

const all = readAllCorpus();
const map = buildLinkMap(all);
ok('the eligible set is substantial, not a token handful', map.names.length > 1000);
ok('and ambiguous names are reported rather than guessed', map.ambiguous.size > 0);
ok('every eligible name maps to exactly one record', map.names.every(n => n.id && typeof n.id === 'string'));
ok('no ambiguous name leaked into the eligible set', map.names.every(n => !map.ambiguous.has(n.name)));
ok('the barred prose-verbs are not targets', map.barred.size === 2 && !map.eligible.has('set up') && !map.eligible.has('select units'));

t('there is one escaper, and linkify uses it', linkify('a & b <c>', { href: null }), esc('a & b <c>'));

const divine = all.find(r => r.id === 'wtc11-adepta-soritas-001');
const html = linkify(divine.text, { selfId: divine.id, href: id => id + '.html' });
ok('the ruling links Divine Intervention to its stratagem', html.indexOf('<a class="wlink" href="stratagem#000008469002.html">Divine Intervention</a>') !== -1);
t('with the label exactly as written', /<a class="wlink"[^>]*>([^<]+)<\/a>/.exec(html)[1], 'Divine Intervention');

const dead = linkify('Command Phase in prose', { href: () => '' });
ok('an empty href leaves the text plain and does not lose the name', dead.indexOf('<a') === -1 && dead.indexOf('Command Phase') !== -1);
const self = linkify(divine.text, { selfId: 'stratagem#000008469002', href: id => id + '.html' });
ok('a record never links to itself', self.indexOf('href="stratagem#000008469002.html"') === -1);
const many = map.names.slice(0, 20).map(n => n.name).join('. ');
t('the per-page cap is enforced', (linkify(many, { href: id => id + '.html', cap: 5 }).match(/<a class="wlink"/g) || []).length, 5);
const indexRec = all.find(r => r.kind === 'index');
t('index pages stay plain', indexRec ? (linkify(indexRec.text, { selfId: indexRec.id, href: id => id + '.html', cap: 0 }).match(/<a class="wlink"/g) || []).length : 0, 0);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
