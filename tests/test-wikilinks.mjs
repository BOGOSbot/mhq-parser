import { readAllCorpus } from '../src/rules-corpus.mjs';
import { buildLinkMap, linkify, linkMap, isDistinctive, stripSuffix } from '../src/wikilinks.mjs';

// task-66: the general wikilink rule. The name map is the feature's spine, so the
// tests pin its discipline, not its counts: unique targets only, distinctive
// words, suffix-stripped titles, first occurrence only, no self-link, capped.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

t('the suffix stripper removes the parenthetical and the colon tail', [stripSuffix('ARCANE GENETIC ALCHEMY (Adeptus Custodes)'), stripSuffix('Set Up: first')], ['ARCANE GENETIC ALCHEMY', 'Set Up']);
t('a generic word alone is not distinctive', [isDistinctive('Stratagem'), isDistinctive('Unit'), isDistinctive('Divine Intervention')], [false, false, true]);

const all = readAllCorpus();
const map = buildLinkMap(all);
ok('the eligible set is substantial, not a token handful', map.names.length > 1000);
ok('and ambiguous names are reported rather than guessed', map.ambiguous.size > 0);
ok('every eligible name maps to exactly one record', map.names.every(n => n.id && typeof n.id === 'string'));
ok('no ambiguous name leaked into the eligible set', map.names.every(n => !map.ambiguous.has(n.name)));

const divine = all.find(r => r.id === 'wtc11-adepta-soritas-001');
const html = linkify(divine.text, { selfId: divine.id, href: id => id + '.html' });
ok('the ruling links Divine Intervention to its stratagem', html.indexOf('<a class="wlink" href="stratagem#000008469002.html">Divine Intervention</a>') !== -1);
t('with the label exactly as written', /<a class="wlink"[^>]*>([^<]+)<\/a>/.exec(html)[1], 'Divine Intervention');
t('and only the first occurrence is linked', (html.match(/<a class="wlink"/g) || []).length, 1);

const self = linkify(divine.text, { selfId: 'stratagem#000008469002', href: id => id + '.html' });
ok('a record never links to itself', self.indexOf('href="stratagem#000008469002.html"') === -1);
const many = map.names.slice(0, 20).map(n => n.name).join('. ');
const capped = linkify(many, { href: id => id + '.html', cap: 5 });
t('the per-page cap is enforced', (capped.match(/<a class="wlink"/g) || []).length, 5);
const plain = linkify('Command Phase', { href: null });
ok('without an href the text stays plain (and escaped)', plain.indexOf('<a') === -1 && plain.indexOf('Command Phase') !== -1);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
