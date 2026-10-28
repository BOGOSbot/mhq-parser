import { stripChrome, extractSections } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// The appendix's shape, cut down: a section title as h3.outline_header, ability entries as h2,
// sub-rules as numbered h3, a rules update filed after the last entry, a second section, and the
// tooltip templates the page carries after its last heading.
const body = ' with enough words in it to clear the floor for a section body of its own.';
const page = [
  '<h3 id="Core-Abilities" class="outline_header">Core Abilities</h3>',
  '<h2 id="[EXTRA-ATTACKS]">[EXTRA ATTACKS]</h2>',
  '<h3 id="Only-[EXTRA-ATTACKS]-weapons">Only [EXTRA ATTACKS] weapons <span class="h_number">24.11.01</span></h3>Extra attacks rule' + body,
  '<h2 id="[ONE-SHOT]">[ONE SHOT]</h2>',
  '<h3 id="Multiple-[ONE-SHOT]-Weapons">Multiple [ONE SHOT] Weapons <span class="h_number">24.26.01</span></h3>One shot rule' + body,
  '<h3 id="Precision-and-Devastating-Wounds">Precision and Devastating Wounds <span class="h_number">24.28.01</span></h3>Precision rule' + body,
  '<h3 id="[TORRENT]">[TORRENT] <span class="h_number">24.37.01</span></h3>Torrent rule' + body,
  '<h3 id="Universal-Rules-Updates" class="outline_header">Universal Rules Updates</h3><p>This document presents rules updates' + body + '</p>',
  '<h3 id="Modifying-a-Stratagem-s-CP-Cost">Modifying a Stratagem’s CP Cost</h3>CP cost rule' + body,
  '<div class="tooltip_templates"><span id="tooltip_content00001"><h3>LETHAL HITS 24.23</h3>A hover copy of a rule that lives in the core rules' + body + '</span></div>',
].join('\n');

const at = (secs, title) => (secs.find((s) => s.title === title) || {}).heading || 'MISSING';
const appendix = extractSections(stripChrome(page, { name: 'rules-appendix' }), { name: 'rules-appendix' });
t('the clarification stays under its ability', at(appendix, 'Multiple [ONE SHOT] Weapons'), '[ONE SHOT] > Multiple [ONE SHOT] Weapons');
t('a rules update numbered under another ability leaves it', at(appendix, 'Precision and Devastating Wounds'), 'Precision and Devastating Wounds');
t('so does the next one', at(appendix, '[TORRENT]'), '[TORRENT]');
t('a section title closes the entry above it', at(appendix, 'Universal Rules Updates'), 'Universal Rules Updates');
t('and its rules sit under it', at(appendix, 'Modifying a Stratagem’s CP Cost'), 'Universal Rules Updates > Modifying a Stratagem’s CP Cost');
t('the other ability keeps its own sub-rule', at(appendix, 'Only [EXTRA ATTACKS] weapons'), '[EXTRA ATTACKS] > Only [EXTRA ATTACKS] weapons');
t('the tooltip copy is not read', appendix.filter((s) => /LETHAL HITS/.test(s.heading)).length, 0);

// Every other page keeps its old reading: the tooltips (the core rules' FAQ answers live there)
// and the tag-level hierarchy.
const other = extractSections(stripChrome(page, { name: 'core-rules' }), { name: 'core-rules' });
t('another page still reads its tooltips', other.filter((s) => /LETHAL HITS/.test(s.heading)).length, 1);
t('and still files by tag level', at(other, 'Universal Rules Updates'), '[ONE SHOT] > Universal Rules Updates');

console.log((fail ? 'FAIL' : 'ok') + ' test-appendix-structure: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
