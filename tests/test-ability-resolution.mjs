// task-99: the ability resolution, OLD against NEW, over EVERY ability in the corpus.
//
// This is the acceptance test for the bucketed scan: if the two agree on every ability, the record
// bodies cannot have moved. The old rule is re-implemented here exactly as it was (a scan over
// every section, no memo, no buckets) and the shipped function is the new one.
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { findAbilityRecord } from '../src/unit-card.mjs';
import { abilityRuleIds } from '../src/unit-card.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// THE OLD RULE, verbatim in behaviour: every section, first of equal scores wins.
function findOld(ability, rules, factions) {
  const half = { Core: 'rules', Faction: 'factions' }[ability && ability.type];
  if (!half) return null;
  const sections = (half === 'rules' ? rules : factions) || [];
  if (!sections.length || !ability.name) return null;
  const name = norm(ability.name);
  const words = name.split(' ').filter(Boolean);
  const ids = (ability.ruleIds || []).map(norm).filter(Boolean);
  let best = null;
  for (const sec of sections) {
    const raw = String(sec.heading || '');
    const path = raw.split(' > ').filter(Boolean);
    const leaf = norm(path[path.length - 1] || '');
    const whole = norm(raw);
    const starts = leaf === name || leaf.indexOf(name + ' ') === 0 || whole === name || whole.indexOf(name + ' ') === 0;
    if (!starts) continue;
    const hay = whole + ' ' + norm(sec.anchor || '') + ' ' + norm(sec.ruleId || '');
    const own = leaf || whole;
    const withId = ids.length ? ids.some((id) => hay.indexOf(id) !== -1) : false;
    const idInTitle = ids.length ? ids.some((id) => own.indexOf(id) !== -1) : false;
    const extra = own.split(' ').length - words.length;
    const score = [withId ? 0 : 1, idInTitle ? 0 : 1, extra];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])
      || (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2])) best = { sec, score };
  }
  return best ? best.sec : null;
}

const all = readAllCorpus().filter(isDelivered);
const halves = { rules: [], factions: [] };
for (const rec of all) { const s = String(rec.set || ''); if (halves[s]) halves[s].push(rec); }

// Every ability the cards know: name plus the rule ids the record cites, which is what the card
// passes in.
let abilities = 0, same = 0, diff = 0;
const examples = [];
for (const rec of all) {
  const ids = abilityRuleIds(rec.text || rec.body || '');
  const heading = String(rec.heading || '');
  const name = heading.split(' > ').pop();
  for (const type of ['Core', 'Faction']) {
    const ability = { type, name, ruleIds: ids };
    const a = findOld(ability, halves.rules, halves.factions);
    const b = findAbilityRecord(ability, halves.rules, halves.factions);
    abilities++;
    if (a === b) same++;
    else { diff++; if (examples.length < 5) examples.push({ name, type, old: a && a.id, now: b && b.id }); }
  }
}
ok('every ability resolves to the same section', diff === 0);
ok('and there were abilities to check', abilities > 1000);
if (diff) console.log('  differed ' + diff + '/' + abilities + '  ' + JSON.stringify(examples));
console.log(pass + ' passed, ' + fail + ' failed   abilities checked ' + abilities);
process.exitCode = fail ? 1 : 0;
