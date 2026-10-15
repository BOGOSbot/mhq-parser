import { retrieveWide, entityAnchors, grepWithTerms } from '../src/rules-corpus.mjs';

// Anchoring may not steal a slot. The retrievers' scores decide the topK pick;
// the anchored records (the unit the question names) and its clarifications are
// appended after it. Their guarantee - presence - survives; the power to evict a
// record a retriever already ranked does not. That eviction showed up as
// scoreless '-' entries above scored hits.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// A closed port: the vector leg fails and is caught, the lexical leg carries the
// test, as it does in production with no index. No model call, no index.
const cfg = { url: 'http://127.0.0.1:1', token: 'none' };
const corpus = [
  { id: 'emb', set: 'rules', heading: 'Embarking', text: 'A unit can embark on a transport it is within 3" of.', url: 'https://x/core-rules' },
  { id: 'shoot', set: 'rules', heading: 'Shooting', text: 'A unit can shoot after it moves.', url: 'https://x/core-rules' },
  { id: 'solitaire', set: 'rules', heading: 'Solitaire', text: 'A Solitaire fights alone.', url: 'https://x/factions' },
  { id: 'move', set: 'rules', heading: 'NORMAL MOVE', text: 'Move the unit up to its Move characteristic.', url: 'https://x/core-rules' },
];
const q = 'Can a Solitaire embark after shooting?';
const opts = { corpus, namespace: 'rules', cfg, terms: ['embark', 'shooting', 'solitaire'], topK: 2, grepNet: 10, anchorCap: 3 };

// The anchor ranking puts 'shoot' outside the topK pick. Before this change it
// was unshifted to the FRONT and pushed the pick out of the window.
t('the anchor is real and sits outside the pick', entityAnchors(q, corpus, 3, opts.terms).map(a => a.id), ['emb', 'shoot', 'solitaire']);
const found = await retrieveWide(q, opts);
const ids = found.map(f => f.id);
const window = ids.slice(0, 2);
t('the retrievers decide the window', window, ['emb', 'solitaire']);
ok('MUTATION: the record the anchor used to displace is recovered', window.indexOf('solitaire') !== -1 && window.indexOf('shoot') === -1);
ok('and the anchor is still in the result, after the window', ids.indexOf('shoot') >= opts.topK);
t('the literal lane keeps its record at rank 1', [found[0].id, found[0].leg, found[0].rank], ['emb', 'lexical', 1]);

// With no anchored record present the output is the retrievers' own order - the
// pre-change behaviour, untouched.
const plainQ = 'What happens when a transport is destroyed?';
const plainTerms = ['transport', 'destroyed'];
t('this question anchors nothing', entityAnchors(plainQ, corpus, 3, plainTerms).length, 0);
const plainOpts = { corpus, namespace: 'rules', cfg, terms: plainTerms, topK: 2, grepNet: 10, anchorCap: 3 };
const plain = await retrieveWide(plainQ, plainOpts);
const lex = grepWithTerms(plainTerms, corpus, 10, plainQ).map(s => s.id);
t('no anchor: the output is exactly the retriever order', plain.map(f => f.id), lex);
const again = await retrieveWide(plainQ, plainOpts);
t('and it is deterministic', again.map(f => f.id), plain.map(f => f.id));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
