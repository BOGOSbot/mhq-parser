/**
 * Expectation groups: what one bank entry's `expect` means.
 *
 * An entry may name more than one record, and those records are not always
 * different answers: some are the same answer in two places - a parent and its own
 * child, or the core rule and the appendix's copy of it - so a question the reader
 * has fully answered must not read as half found because one of the two copies did
 * not come back. A group says "any one of these satisfies this expectation";
 * separate groups are separate answers, so a genuine hop stays one group per id
 * and is still counted as not fully found when one of them is missing.
 *
 * Both shapes are accepted, so the bank migrates one entry at a time:
 *   "expect": ["a", "b"]         -> [["a"], ["b"]]        one group per id
 *   "expect": [["a", "b"], "c"]  -> [["a", "b"], ["c"]]   a and b are alternatives
 * A mixed entry reads the same way: a string is a group of one.
 */

function idSet(ids) {
  return ids instanceof Set ? ids : new Set(ids || []);
}

export function expectGroups(expect) {
  const out = [];
  for (const e of expect || []) {
    if (Array.isArray(e)) {
      const group = e.filter(x => typeof x === 'string' && x);
      if (group.length) out.push(group);
    } else if (typeof e === 'string' && e) {
      out.push([e]);
    }
  }
  return out;
}

// A group is satisfied by any member - and, on the reachable reading, by a member
// the splitter moved under a child ('<id>->-<TITLE>').
export function groupSatisfied(group, ids, reach) {
  const set = idSet(ids);
  for (const e of group || []) {
    for (const h of set) {
      if (h === e) return true;
      if (reach === true && h.startsWith(e + '->-')) return true;
    }
  }
  return false;
}

export function satisfiedGroups(groups, ids, reach) {
  return (groups || []).filter(g => groupSatisfied(g, ids, reach));
}

export function missingGroups(groups, ids) {
  return (groups || []).filter(g => !groupSatisfied(g, ids));
}

// The line the partial block prints for one uncovered group: the alternatives that
// never appeared, and, when one of them is only reachable under a child, the
// record it moved to - a real hit for the reader and a real miss for the fixture.
export function missingGroupLine(group, ids) {
  const set = idSet(ids);
  const parts = (group || []).map(e => {
    let under = '';
    for (const h of set) if (h.startsWith(e + '->-')) { under = h; break; }
    return e + (under ? '   (reachable as ' + under + ')' : '');
  });
  return (parts.length === 1 ? 'missing: ' : 'missing group: ') + parts.join('  |  ');
}

// 'expected N groups, found M', with the best rank among the records that were
// found. N counts groups, never ids: two alternatives are one expectation.
export function partialHeadline(needed, found, rank, topk) {
  return '      expected ' + needed + ' group' + (needed === 1 ? '' : 's') + ', found ' + found
    + (rank === null || rank === undefined ? '  (nothing in the top ' + topk + ')' : '  (best rank #' + rank + ')');
}
