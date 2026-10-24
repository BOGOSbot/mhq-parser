// src/render-context.mjs: the one input shape a record render reads.
//
// recordBody() and its helpers read a fixed set of parts. Before this module the parts
// were a six-key bag assembled by hand at every call site, and one call site assembled it
// wrong: corpora arrived as a Map instead of {rules, factions, rulings}, the truthiness
// guard passed, and 834 records rendered differently from the route with nothing failing.
// A constructor turns that class of bug into a loud one at the seam.
//
// The context is immutable after construction. recordBody() derives its per-record values
// (selfId, the link budget) without writing anything back, so a caller's object is never
// mutated and a context cannot be silently re-shaped mid-render.
//
// This module imports nothing: it is a validator and a constructor, so the server, the
// bundlers and the renderer can all depend on it without a cycle.

const CONTEXT = Symbol('render-context');

// The three halves a corpus takes. A record is rendered against the corpus it came from,
// split the way the server splits it; a Map of records by id is not one of these.
const HALVES = ['rules', 'factions', 'rulings'];

function normaliseCorpora(corpora) {
  if (corpora == null) return null;
  if (corpora instanceof Map) {
    throw new TypeError('render-context: corpora is a Map; recordBody expects the three-half object {rules, factions, rulings} (this is the shape that silently rendered 834 records differently)');
  }
  if (typeof corpora !== 'object' || typeof corpora.get === 'function') {
    throw new TypeError('render-context: corpora must be {rules, factions, rulings} arrays, got ' + Object.prototype.toString.call(corpora));
  }
  for (const key of Object.keys(corpora)) {
    if (HALVES.indexOf(key) === -1) {
      throw new TypeError('render-context: corpora has an unknown half \'' + key + '\'; expected only ' + HALVES.join(', '));
    }
    const value = corpora[key];
    if (value != null && !Array.isArray(value)) {
      throw new TypeError('render-context: corpora.' + key + ' must be an array of records, got ' + Object.prototype.toString.call(value));
    }
  }
  const out = { rules: [], factions: [], rulings: [] };
  for (const key of HALVES) if (Array.isArray(corpora[key])) out[key] = corpora[key];
  return out;
}

// Build the context. Every part is optional; the factory fills the defaults recordBody
// used to fill by writing into the caller's bag: no corpora means no chunk merge, no
// selfId means the renderer derives it from the record, and the link budget is fresh.
//
//   corpora  {rules, factions, rulings} arrays, or null   (validated, never a Map)
//   chunk    the sibling lookup from chunkLookup(), or null
//   index    the card index from cardIndex(), or null
//   href     id -> '#<slug>' (a function), or null
//   selfId   the record being rendered, so it never links to itself ('' means derive)
//   frText   the French body for this record, or '' for English
//   lang     'en', 'fr', or undefined for the bilingual ruling pane
//   cap      the prose link cap when the caller needs one
export function renderContext(parts) {
  const p = parts || {};
  const ctx = {
    corpora: normaliseCorpora(p.corpora),
    chunk: p.chunk || null,
    index: p.index || null,
    href: typeof p.href === 'function' ? p.href : null,
    selfId: p.selfId == null ? '' : String(p.selfId),
    frText: p.frText == null ? '' : String(p.frText),
    lang: p.lang,
    cap: p.cap,
    // One link budget per rendered record: the prose, the legend, the ability rows and
    // the field table draw on the same count and the same first-mention set.
    state: { used: new Set(), count: 0 },
  };
  Object.defineProperty(ctx, CONTEXT, { value: true, enumerable: false });
  return Object.freeze(ctx);
}

export function isRenderContext(value) { return !!(value && value[CONTEXT] === true); }

// recordBody's argument: a context from this factory, or a plain options object from a
// caller that has not been migrated (the tests do that). A plain object is normalised
// through the same factory, so both paths validate identically; the plain object is never
// written to.
export function asRenderContext(opts) { return isRenderContext(opts) ? opts : renderContext(opts); }
