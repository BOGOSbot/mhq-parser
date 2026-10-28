// task-99: THE APPENDIX RUN-ON, pinned on the PAGE's own output rather than on the code that
// makes it.
//
// The Wahapedia appendix marks its entries as divs, not headings, so a run of them became the
// text of whichever record was open, and the last heading the scraper saw (a FAQ question) became
// their parent. 13.08 Benefit of Cover ended up inside the Feel No Pain FAQ's DEADLY DEMISE
// record. These assertions read the CORPUS, so they fail if the bug comes back through any door.
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };

const all = readAllCorpus().filter(isDelivered);
const byId = new Map(all.map((r) => [String(r.id), r]));
const leafOf = (r) => String(r.heading || '').split(' > ').pop() || '';

// --- 1. the run-on record is gone, and the rule it swallowed is its own record -----
const runOn = all.find((r) => /Feel-No-Pain/i.test(String(r.id)) && /DEADLY-DEMISE/i.test(String(r.id)));
ok('the run-on record no longer exists', !runOn);
const torrent = all.filter((r) => leafOf(r).indexOf('[TORRENT]') === 0 || leafOf(r).indexOf('TORRENT') === 0);
ok('TORRENT is its own record', torrent.length > 0);
// The core rules' own record and the appendix's, one per source: the corpus already keeps a rule
// once per source, and the appendix entry had to leave the run-on it was buried in.
const cov = all.filter((r) => String(r.ruleId || '') === '13.08');
const coreCov = cov.filter((r) => String(r.source) === 'core-rules');
const appCov = cov.filter((r) => String(r.source) === 'rules-appendix');
ok('the core rules carry one 13.08 record', coreCov.length === 1);
ok('and it is Benefit of Cover under Terrain', coreCov.length === 1 && /Benefit of Cover/i.test(leafOf(coreCov[0])) && /Terrain/i.test(String(coreCov[0].heading)));
// 2026-10-28: the appendix's 13.08 was never an appendix entry. The page prints Benefit of
// Cover only inside a hover tooltip, and the tooltip templates (104 copies of rules that live
// elsewhere, all filed under '[ONE SHOT]') are no longer read on that page. The rule is the
// core rules' record, once.
ok('the appendix carries no 13.08 record (it was a tooltip copy)', appCov.length === 0);
ok('and no other source carries 13.08', cov.length === 1);
// The run-on itself stays guarded: no appendix record swallows the abilities after it.
const runOnBodies = all.filter((r) => String(r.source) === 'rules-appendix' && String(r.text).indexOf('[TORRENT]') !== -1 && String(r.text).indexOf('[EXTRA ATTACKS]') !== -1 && String(r.text).length > 1200);
ok('and no appendix body is a run of other rules', runOnBodies.length === 0);

// '[ONE SHOT]' holds its own clarification only: the rules update filed after it (24.28.01,
// 24.37.01) and the Universal Rules Updates section are not its children.
const oneShot = all.filter((r) => String(r.source) === 'rules-appendix' && /^\[ONE SHOT\]/.test(String(r.heading)));
ok('[ONE SHOT] is the entry and its 24.26.01 clarification', oneShot.length === 2 && oneShot.every((r) => !r.ruleId || /^24\.26/.test(String(r.ruleId))));
const uru = byId.get('rules-appendix#Universal-Rules-Updates');
ok('Universal Rules Updates is a section of its own', !!uru && !uru.parent);
ok('and the stratagem updates sit under it', all.filter((r) => String(r.parent) === 'rules-appendix#Universal-Rules-Updates').length >= 5);

// --- 2. no FAQ question is a parent ------------------------------------------------
const faqParents = all.filter((r) => /^Q:/.test(leafOf(r)) && all.some((x) => String(x.parent) === String(r.id)));
ok('no record whose heading is a FAQ question has children', faqParents.length === 0);
if (faqParents.length) console.log('  ' + faqParents.slice(0, 3).map((r) => r.id.slice(-60)).join(', '));

// --- 3. the appendix entries are not parented under FAQ questions -------------------
// The legitimate set is the SEE-ALSO children and the chunk split; the run-on appended appendix
// entries to whichever record was open, and those are what must not appear.
const appendixKids = all.filter((r) => {
  const p = byId.get(String(r.parent || ''));
  return p && (String(p.source) === 'rules-appendix') && /^Q:/.test(leafOf(p));
});
ok('no appendix entry is a child of a FAQ question', appendixKids.length === 0);

// --- 4. the inline headings the appendix writes are real records -------------------
const bracketed = all.filter((r) => /^\[/.test(leafOf(r)));
ok('a bracketed appendix entry became a record', bracketed.length > 0);
const numberFirst = all.filter((r) => /^\d{2}\.\d{2}(\.\d{2})?\s+\S/.test(leafOf(r)));
ok('a number-first appendix entry became a record', numberFirst.length > 0);

// --- 5. prose that merely ends in a number is still prose --------------------------
// The pattern must not swallow sentences. A body line that reads as a sentence and ends in a
// number is the false positive the guards exist for; no record may be titled like one.
const proseTitles = all.filter((r) => /^(the|this|that|these|those|it|if|when|where|a|an|you|your|once|each|every|any|in|on|at|for|to|see|page)\b/i.test(leafOf(r)) && /\d{2}\.\d{2}$/.test(leafOf(r)));
ok('no record is titled like a sentence that ends in a number', proseTitles.length === 0);

// --- 6. the cross-reference stays: Core Abilities naming DEADLY DEMISE is legitimate --
// Core Abilities is a FACTION record, and the DEADLY DEMISE entry under it is the page's own
// heading ('Duplicated Abilities > DEADLY DEMISE'), not an inline split: it must survive.
const everything = readAllCorpus().filter(isDelivered);
const dmEntry = everything.filter((r) => /Duplicated Abilities > DEADLY DEMISE$/i.test(String(r.heading)));
ok('the Core Abilities DEADLY DEMISE entry survives', dmEntry.length === 1);
ok('and it is a real rule, not a stub', dmEntry.length === 1 && String(dmEntry[0].text).length > 200);

console.log(pass + ' passed, ' + fail + ' failed   rules records ' + all.length);
process.exitCode = fail ? 1 : 0;
