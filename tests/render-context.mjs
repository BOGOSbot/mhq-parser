// The render context (src/render-context.mjs): one shape, built by a factory, never
// written to. Four fixtures pin the parts a caller can get wrong, because getting one
// wrong silently is what rendered 834 records differently from the route.
//
// Fixtures chosen for the parts that actually vary:
//   1. an ENGLISH record through a factory context (the server's own path);
//   2. a FRENCH body (frText) on a record that has a translation;
//   3. a SPLIT record with a pre-built chunk (task-99's sibling lookup) vs none;
//   4. corpora as a Map, the shape that passed the old truthiness guard - it must fail
//      loudly at the factory, not render differently.
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { cardIndex, chunkLookup, recordBody } from '../src/wiki-cards.mjs';
import { isRenderContext, renderContext } from '../src/render-context.mjs';
import { frUsable } from '../src/i18n-fr.mjs';
import { surfaceSlugMap } from '../src/wiki-surface.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got).slice(0, 300) + '\n  want: ' + JSON.stringify(want).slice(0, 300)); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
function throws(name, fn) {
  try { fn(); fail++; console.log('FAIL ' + name + ' (did not throw)'); }
  catch (e) { pass++; }
}

const all = readAllCorpus().filter(isDelivered);
const byId = new Map(all.map(r => [String(r.id), r]));
const halves = {
  rules: readAllCorpus('rules'),
  factions: readAllCorpus('factions'),
  rulings: readAllCorpus('rulings'),
};
const index = cardIndex(new Map(all.map(r => [String(r.id), r])));
const chunk = chunkLookup(([]).concat(halves.rules || [], halves.factions || [], halves.rulings || []));
const slugs = surfaceSlugMap();
const href = id => { const s = slugs.get(String(id || '')); return s ? '#' + s : ''; };
const base = { corpora: halves, chunk, index, href };

// --- 1. an English record through the factory (the server's path) -------------------
const english = byId.get('datasheet#000001446');
ok('the English fixture is a delivered record', !!english);
const enCtx = renderContext(Object.assign({}, base, { selfId: english.id, frText: '' }));
ok('the factory returns a context', isRenderContext(enCtx));
ok('a context is immutable', Object.isFrozen(enCtx));
const enHtml = recordBody(english, enCtx);
ok('the English record renders', enHtml.length > 200 && enHtml.indexOf('wcard') !== -1);
t('rendering twice is deterministic', recordBody(english, renderContext(Object.assign({}, base, { selfId: english.id, frText: '' }))) === enHtml, true);

// --- recordBody must not write to its argument -------------------------------------
const bag = Object.assign({}, base, { frText: '' });
const bagKeys = Object.keys(bag).sort();
recordBody(english, bag);
t('a plain options object is not written to', Object.keys(bag).sort(), bagKeys);
ok('and no state or selfId was added to it', !('state' in bag) && !('selfId' in bag));
const frozen = Object.assign({}, base, { frText: '' });
Object.freeze(frozen);
ok('a frozen plain object still renders', recordBody(english, frozen).length > 200);

// --- 2. the French body -------------------------------------------------------------
const frenchId = 'core-rules#Introduction';
const frenchRec = byId.get(frenchId);
const frText = frUsable(frenchId);
ok('the French fixture has a translation', !!frenchRec && !!frText);
const frHtml = recordBody(frenchRec, renderContext(Object.assign({}, base, { selfId: frenchId, frText, lang: 'fr' })));
ok('the French body differs from the English one', frHtml !== recordBody(frenchRec, renderContext(Object.assign({}, base, { selfId: frenchId, frText: '', lang: 'en' }))));
ok('and it carries French text the English body does not', (function () {
  const en = recordBody(frenchRec, renderContext(Object.assign({}, base, { selfId: frenchId, frText: '' })));
  const words = String(frText).split(/[^\p{L}]+/u).filter(w => w.length > 7);
  return words.some(w => frHtml.indexOf(w) !== -1 && en.indexOf(w) === -1);
})());

// --- 3. a pre-built chunk (task-99) --------------------------------------------------
const splitRec = byId.get('unitrules#000001446~1');
ok('the split fixture is a delivered part', !!splitRec);
const withChunk = recordBody(splitRec, renderContext(Object.assign({}, base, { selfId: splitRec.id, frText: '' })));
const without = recordBody(splitRec, renderContext({ corpora: halves, index, href, selfId: splitRec.id, frText: '' }));
t('the pre-built chunk renders the same body as none', withChunk === without, true);
ok('and the merged body is the whole rule, not the part alone', withChunk.length > String(splitRec.text || '').length);

// --- 4. the wrong shape (the 834-record Map) ----------------------------------------
throws('a Map corpora throws at the factory', () => renderContext({ corpora: new Map([['rules', []]]) }));
throws('and through recordBody, which normalises a plain bag the same way', () => recordBody(english, { corpora: new Map(), index, href, selfId: english.id }));
throws('an unknown corpora half throws', () => renderContext({ corpora: { rules: [], bogus: [] } }));
throws('a non-array half throws', () => renderContext({ corpora: { rules: {} } }));
ok('no corpora is allowed (the fixture path)', isRenderContext(renderContext({})));

console.log('fixtures: english, french, chunk, map | delivered ' + all.length);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;