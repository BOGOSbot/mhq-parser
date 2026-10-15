// What the corpus actually calls an expectation. One implementation, shared by
// the eval harness (tests/eval-retrieval.mjs) and the guard test
// (tests/test-bank-scoreable.mjs): an expectation that no longer matches a
// corpus id exactly is resolved through the chunker's own conventions, never by
// fuzzy matching.
//
//  - the record is still there but the rule moved under it: the splitter keeps a
//    container's id and gives the rule a child, '<container>->-<TITLE>';
//  - the id names a record the part splitter divided: the corpus carries
//    '<id>~1', '<id>~2', ... and not the unsuffixed base. That is the same
//    convention, in the record-id lane rather than the anchor lane, and it is
//    what left unitrules#000002541 unresolvable: the expectation named the
//    pre-split citation, the corpus had only its parts, and the harness printed
//    NOT FOUND so the question could never score.
export function splitParts(id, ids) {
  const out = [];
  for (const x of ids) {
    if (x !== id && x.startsWith(id + '~') && /^\d+$/.test(x.slice(id.length + 1))) out.push(x);
  }
  return out;
}

// ix: { byId: Set, byKey: Map, ids: string[] }
export function resolveExpectation(id, ix) {
  if (ix.byId.has(id)) return { resolved: id, parts: [id], via: 'exact', note: '' };
  const moved = ix.byKey.get(id);
  if (moved) return { resolved: moved, parts: [moved], via: 'moved', note: '  moved      ' + id + '  ->  ' + moved };
  const parts = splitParts(id, ix.ids);
  if (parts.length) return { resolved: id, parts: parts, via: 'split', note: '  split      ' + id + '  ->  ' + parts.join(', ') };
  return { resolved: id, parts: [], via: 'missing', note: '  NOT FOUND  ' + id };
}
