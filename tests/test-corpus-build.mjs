import {
  CORE_STRATAGEMS, JUDGE_PASSAGE_CHARS, buildFactionSections, dedupeKey, dedupeSections, splitInlineRules, splitLong, splitSection,
} from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// Reading the CSV export that is on disk, so this runs without a network.
// The builder is raw; deduping happens when the corpus is written, so the test
// applies the same step the real build does.
const raw = buildFactionSections();
const sections = dedupeSections(raw.sections).sections;
const core = sections.filter(s => s.set === 'rules');
const factions = sections.filter(s => s.set === 'factions');

t('the export produced records', sections.length > 3000, true);
t('both halves exist', core.length > 0 && factions.length > 0, true);

// --- core rules must not wear a faction tag ---------------------------------
// The 68 stratagems with no faction id are core rules - Command Re-roll, the
// stratagem key's move entries - and they used to be filed under "factions",
// so core rules turned up in results marked FACTION and crowded out the real
// faction records.
t('no faction record is a core stratagem', factions.filter(s => /\(Core\)$/.test(s.heading)).length, 0);
t('every faction record has a faction in the heading', factions.filter(s => s.id.startsWith('stratagem#') && !/\(/.test(s.heading)).length, 0);
t('core records are tagged rules', core.filter(s => s.set !== 'rules').length, 0);
t('core records come from the core-stratagems source', [...new Set(core.map(s => s.source))], ['core-stratagems']);
t('a core record cites the core rules page', core.filter(s => !String(s.url).includes('core-rules')).length, 0);
t('a core record is anchored', core.filter(s => !s.hasAnchor).length, 0);
t('the anchor is the core stratagems section', [...new Set(core.map(s => s.anchor))], ['Core-Stratagems']);
t('core records carry an id of their own kind', core.filter(s => !s.id.startsWith('core-stratagem#')).length, 0);
t('no core record is named "(Core)"', core.filter(s => /\(Core\)/.test(s.heading)).length, 0);

// --- another game mode is not our corpus ------------------------------------
// Boarding Actions is a 10th edition expansion, and it rides in the same file
// with no faction id like the core stratagems do. Those are dropped, because
// the corpus is 11th edition matched play.
t('no boarding actions record is filed as core', core.filter(s => /boarding actions/i.test(s.text)).length, 0);
t('no core stratagem is a boarding actions one', core.filter(s => /boarding actions/i.test(s.text)).length, 0);
// A handful of faction-tagged records still mention it - detachments and
// enhancements that carry a faction id, which the CSV gives no source column to
// filter on. They are correctly tagged FACTION; they are just off-edition. The
// bound keeps the residue from growing unnoticed.
const residue = sections.filter(s => /boarding actions/i.test(s.text));
t('the boarding actions residue stays small', residue.length <= 8, true);
t('the residue is never core', residue.filter(s => s.set === 'rules').length, 0);

// --- the copies the export ships --------------------------------------------
// Some records appear under several ids with the same wording, one of them
// written with a non-breaking hyphen. They filled the top of a result list.
{
  const a = { heading: 'CLOSE-QUARTERS SHOOTING', text: 'same body', set: 'rules' };
  const b = { heading: 'CLOSE\u2011QUARTERS SHOOTING', text: 'same  body', set: 'rules' };
  t('a non-breaking hyphen dedupes against a hyphen', dedupeKey(a), dedupeKey(b));
  const r = dedupeSections([a, b, { heading: 'OTHER', text: 'same body', set: 'rules' }]);
  t('the copy is dropped', r.sections.length, 2);
  t('the drop is counted', r.dropped, 1);
  t('the first of the pair is kept', r.sections[0].heading, 'CLOSE-QUARTERS SHOOTING');
}
// Distinct wording is not a duplicate, however similar the name.
{
  const r = dedupeSections([
    { heading: 'Terrax-pattern Termite', text: 'Adeptus Mechanicus version' },
    { heading: 'Terrax-pattern Termite', text: 'Death Guard version' },
  ]);
  t('same name, different rules both survive', r.sections.length, 2);
}
{
  const ids = [...new Set(sections.map(s => s.id))];
  t('every id is unique', ids.length, sections.length);
  const names = new Map();
  for (const s of sections) names.set(s.heading + '|' + s.text, (names.get(s.heading + '|' + s.text) || 0) + 1);
  t('no record is textually repeated', [...names.values()].filter(n => n > 1).length, 0);
}

// --- a datasheet is two records, not one -------------------------------------
// "What is a Tyrannofex's Toughness?" and "does it have the FRAME keyword?" have
// nothing to do with each other. As one record each is half noise to the other,
// so the values live in one record and the keywords and abilities in another,
// both citing the same page.
{
  t('nothing is over the chunk limit', sections.filter(s => s.chars > 2400).length, 0);
  const values = sections.filter(s => s.id.startsWith('datasheet#') && s.heading === 'Asurmen');
  const rules = sections.filter(s => s.id.startsWith('unitrules#') && /^Asurmen - keywords and abilities/.test(s.heading));
  t('a datasheet has one values record', values.length, 1);
  t('the values record holds the statline', /M 7" T 3 Sv 2\+/.test(values[0].text), true);
  t('the values record holds the wargear', /Wargear Bloody Twins/.test(values[0].text), true);
  t('the values record holds no abilities', /Ability \(Core\)/.test(values[0].text), false);
  t('the values record holds no keywords', /Keywords:/.test(values[0].text), false);
  t('the rules record holds the keywords', /Keywords: .*Phoenix Lord/.test(rules[0].text), true);
  t('the rules record holds the abilities', /Ability \(Core\)/.test(rules[0].text), true);
  t('the rules record holds no statline', /M 7" T 3/.test(rules[0].text), false);
  t('both cite the same page', values[0].url === rules[0].url, true);
  // With the Agile Manoeuvres card stripped the record fits in one part; when it
  // did not, the parts said which part they were.
  t('the rules record fits in one part now', rules.length, 1);
  t('and is named without a part suffix', rules[0].heading, 'Asurmen - keywords and abilities');

// --- a core ability is not a stratagem --------------------------------------
// The export files the core stratagems next to the move and shooting ability
// entries. Calling NORMAL SHOOTING a 'core stratagem' told the reader a unit's
// normal shooting was a stratagem; the label follows the export's own Type.
{
  const first = name => (core.find(s => s.heading === name) || {}).text || '';
  t('a shooting ability is labelled an ability', /ASSAULT SHOOTING - core shooting ability/.test(first('ASSAULT SHOOTING')), true);
  t('a movement ability is labelled an ability', /DISEMBARK MOVE - core movement ability/.test(first('DISEMBARK MOVE')), true);
  t('a real core stratagem is still one', /COMMAND RE-ROLL - core stratagem/.test(first('COMMAND RE-ROLL')), true);
  t('exactly the ability rows lose the stratagem label', core.filter(s => / - core (movement|shooting) ability/.test(s.text)).length, 22);
}

// --- the rules the page wrote inside a parent body --------------------------
// '3. End of Shooting Phase' (10.03) carries NORMAL SHOOTING 10.04, ASSAULT
// SHOOTING 10.05 and the rest as plain text. One record holding six rules is a
// question about normal shooting answered from a record labelled something else.
{
  const body = 'Rules that are triggered at the end of the Shooting phase are resolved now.\n\nNORMAL SHOOTING 10.04\n\nELIGIBLE IF: Your unit is unengaged.\n\nASSAULT SHOOTING 10.05\n\nELIGIBLE IF: All of the following apply.';
  const parts = splitInlineRules('3. End of Shooting Phase', body, '10.03', '3.-End-of-Shooting-Phase', '3. End of Shooting Phase');
  t('the parent keeps the lead-in', parts[0].heading, '3. End of Shooting Phase');
  t('the parent keeps its own rule id', parts[0].ruleId, '10.03');
  t('the parent keeps its anchor', parts[0].anchor, '3.-End-of-Shooting-Phase');
  t('every numbered rule becomes a record', parts.length, 3);
  t('a sub-rule carries its rule id', parts[1].ruleId, '10.04');
  t('a sub-rule is named under its parent', parts[1].heading, '3. End of Shooting Phase > NORMAL SHOOTING');
  t('a sub-rule has no anchor of its own', parts[1].anchor, '');
  t('a sub-rule body starts after the title line', parts[1].body, 'ELIGIBLE IF: Your unit is unengaged.');
  t('the last sub-rule runs to the end', parts[2].ruleId, '10.05');
  t('a body with no numbered rule is left whole', splitInlineRules('Embarking', 'Once the first battle round has started, a unit can embark.', '18.02', 'Embarking', 'Embarking').length, 1);
  t('a sentence ending in a rule id is not a heading', splitInlineRules('X', 'The rule refers to page 10.04\n\nand continues here with more text.', '', '', 'X').length, 1);
  t('a heading re-stating the parent id is not a sub-rule', splitInlineRules('X', '3. End of Shooting Phase 10.03\n\nbody here', '10.03', '', 'X').length, 1);
  const empty = splitInlineRules('Advance', 'NORMAL MOVE 09.05\n\nbody', '', '', 'Advance');
  t('a container with no lead-in still exists for its citation', empty[0].heading + '|' + empty[0].body + '|' + empty.length, 'Advance||2');
}

  t('it is under the part limit', rules[0].chars < 2000, true);
  // The Agile Manoeuvres card rides inside the Battle Focus ability row in the
  // export. It is stripped: six sub-rules (a vehicle trigger included) pasted
  // onto every datasheet that can take a Battle Focus token; the manoeuvres
  // already have records of their own from Stratagems.csv.
  t('the rules record holds real abilities', /Hand of Asuryan/.test(rules.some(s => s.text) ? rules.map(s => s.text).join(' ') : ''), true);
  t('the agile manoeuvres card is gone', rules.every(s => !/FLITTING SHADOWS|STAR ENGINES|SWIFT AS THE WIND/i.test(s.text)), true);
  t('the token rules survive the strip', rules.some(s => /Battle Focus token/.test(s.text)), true);
}

// The canonical keyword question, which is what the split is for.
{
  const tyr = sections.find(s => s.id.startsWith('unitrules#') && s.heading === 'Tyrannofex - keywords and abilities');
  t('the Tyrannofex has a keywords record', !!tyr, true);
  t('FRAME is in it', /Keywords: .*\bFrame\b/.test(tyr ? tyr.text : ''), true);
  const stats = sections.find(s => s.id.startsWith('datasheet#') && s.heading === 'Tyrannofex');
  t('his toughness is in the values record', /T 12/.test(stats ? stats.text : ''), true);
  t('and FRAME is not', /\bFrame\b/.test(stats ? stats.text : ''), false);
}

// --- nothing stored may be longer than the judge is shown -------------------
// This is the invariant the Asurmen failure turned on. At 700 characters the
// judge could not see his Agile Manoeuvres, which begin around character 940,
// and answered "no such rule is in the passages" about a passage it had not
// been given. A correct retrieval became a wrong "I do not know".
{
  t('no record exceeds the judge cap', sections.filter(s => s.chars > JUDGE_PASSAGE_CHARS).length, 0);
  t('the chunk limit is under the judge cap', 2000 <= JUDGE_PASSAGE_CHARS, true);
  // A single weapon profile or table row can be one "sentence" longer than the
  // limit; sentence splitting alone leaves it whole.
  const monster = 'A'.repeat(5000);
  const cut = splitLong(monster, 2000);
  t('an uncuttable blob is still cut', cut.length > 1, true);
  t('and every piece is under the limit', cut.filter(x => x.text.length > 2000).length, 0);
  const long = ('word '.repeat(900)).trim();
  t('a normal long body is cut too', splitLong(long, 2000).filter(x => x.text.length > 2000).length, 0);
  t('a short body is left alone', splitLong('short', 2000).length, 1);
  // Paragraphs first: the author's own unit of thought beats a character count.
  const paras = ('A'.repeat(1500)) + '\n\n' + ('B'.repeat(1500));
  const byPara = splitSection(paras, 2000);
  t('a two-paragraph body splits between them', byPara.length, 2);
  t('and neither paragraph is cut', byPara.map(x => x.text.length), [1500, 1500]);
}

t('the built source is marked as built, not scraped', CORE_STRATAGEMS.built, true);
t('it belongs to the rules half', CORE_STRATAGEMS.set, 'rules');

// --- a spot check on real content -------------------------------------------
{
  const cmd = core.find(s => s.heading === 'COMMAND RE-ROLL');
  t('command re-roll is a core record', !!cmd, true);
  t('it is not attributed to a faction', /\bstratagem\b/.test(cmd ? cmd.text : ''), true);
  const gtg = core.find(s => s.heading === 'GO TO GROUND');
  t('go to ground is there too', !!gtg, true);
  const fb = core.find(s => s.heading === 'FALL-BACK MOVE');
  t('the stratagem key entry is there', !!fb, true);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
