import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, htmlToText, stripAbilityFlavour } from '../src/rules-corpus.mjs';
import { lookupRecord } from '../src/header-index.mjs';

// task-50: the 19 universal abilities the core rules page defines verbatim but
// the scraper left without a heading of their own. The constraint is the whole
// test: every word of the new records must already be on the page - no rules
// text is authored here. SUPA-HAZARDOUS has no definition on the page (it is a
// typo in a weapon profile) and is deliberately left out.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = readAllCorpus();
const defs = all.filter(r => r.id.indexOf('ability-def#') === 0);
// 2026-10-24: the page is read through the same strip the corpus build applies, so the
// verbatim guarantee survives the flavour cut - the record is still page text, minus the
// one sentence Wahapedia marks as flavour.
const pageText = stripAbilityFlavour(htmlToText(fs.readFileSync(path.join(ROOT, 'workspace', 'rules-corpus', 'core-rules.html'), 'utf8')).replace(/\s+/g, ' '));

// 21 since task-99: excluding the appendix from the 'already has a heading' check let
// [EXTRA ATTACKS] and [ONE SHOT] through, both real page definitions the corpus uses.
t('21 abilities were recovered', defs.length, 21);
t('each new record is a section under the Abilities parent', [...new Set(defs.map(r => r.parent))], ['core-rules#Abilities']);
t('and carries the core rules page as its source', [...new Set(defs.map(r => r.source))], ['core-rules']);
t('every record is edition 11', [...new Set(defs.map(r => String(r.edition)))], ['11']);
t('every record is named by its bracketed heading', defs.map(r => r.heading).sort(), ['[ANTI]', '[ASSAULT]', '[BLAST]', '[CLEAVE]', '[CLOSE-QUARTERS]', '[DEVASTATING WOUNDS]', '[EXTRA ATTACKS]', '[HAZARDOUS]', '[HEAVY]', '[IGNORES COVER]', '[INDIRECT FIRE]', '[LANCE]', '[LETHAL HITS]', '[MELTA]', '[ONE SHOT]', '[PISTOL]', '[PRECISION]', '[PSYCHIC]', '[RAPID FIRE]', '[SUSTAINED HITS]', '[TWIN-LINKED]'].sort());

// The no-fabrication guarantee, checked whole: each record's text is a substring
// of the page's own text. A single invented sentence would break this.
t('every definition is verbatim from the page, minus the flavour sentence', defs.filter(r => pageText.indexOf(r.text) !== -1).length, 21);
ok('and each carries the rulebook number the page prints', defs.every(r => /^2[0-9]\.[0-9]+$/.test(String(r.ruleId))));
t('no record is empty', defs.filter(r => !String(r.text || '').trim()).length, 0);

// The typo is left out, on purpose and visibly.
ok('SUPA-HAZARDOUS got no record: the page defines no such ability', !defs.some(r => r.heading.indexOf('SUPA-HAZARDOUS') !== -1));
ok('and the corpus still uses it, which is why the test names it', all.some(r => String(r.text || '').indexOf('[SUPA-HAZARDOUS]') !== -1));

// The router now answers the names, which was the point of the card.
for (const [q, id] of [['find lethal hits', 'ability-def#lethal-hits'], ['find devastating wounds', 'ability-def#devastating-wounds'], ['find sustained hits', 'ability-def#sustained-hits'], ['find ignores cover', 'ability-def#ignores-cover']]) {
  const hit = lookupRecord(q);
  t('the router answers ' + q, [hit.found, hit.id], [true, id]);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
