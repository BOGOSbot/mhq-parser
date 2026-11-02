// The heading shapes the 2026-11-02 audit found in the corpus, pinned as behaviour of the
// extractor rather than as numbers in a file: a rebuild from the saved pages must keep all
// four fixes, and a fixture is the only way to test them without a 760 KB page.
import { extractSections, deriveTitle, stripChrome } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('FAIL ' + name + (detail === undefined ? '' : '\n  got : ' + JSON.stringify(detail)));
}
const body = sec => String(sec.text).split('\n').slice(1).join('\n').trim();
const PAGE = html => extractSections(html, { name: 'core-rules', url: 'https://example.test/' });

// 1. The page prints its title again as the first line of its own body.
const intro = PAGE('<h2 id="Introduction">Welcome to the Warhammer 40,000 Core Rules.</h2><p>Welcome to the Warhammer 40,000 Core Rules. This page contain everything you need to know, and then some more words to clear the floor.</p>');
const introBody = String(intro[0].text).split('\n')[1] || '';
ok('the title is not printed twice in the body', introBody.indexOf('Welcome to the Warhammer') !== 0 && introBody.indexOf('This page contain') === 0, introBody.slice(0, 90));

// A short title must not eat a sentence that happens to start with it.
const shorty = PAGE('<h2 id="Dice">Dice</h2><p>Dice are rolled whenever the rules call for it, and that is often enough to matter.</p>');
ok('a one-word title does not strip a sentence that opens with it', body(shorty[0]).indexOf('Dice are rolled') === 0, body(shorty[0]).slice(0, 60));

// 2. A body that is only the accordion's toggle is not a rule.
const toggle = PAGE('<h2 id="Fight-Phase">Fight Phase</h2><p>The fight phase is resolved in steps and this sentence makes it long enough to keep.</p><h3 id="FAQ">FAQ</h3><p>Show</p>');
ok('a toggle-only body is dropped', toggle.filter(s => /FAQ/.test(String(s.heading))).length === 0, toggle.map(s => s.heading));
// ...but a real FAQ answer under that label survives.
const realFaq = PAGE('<h2 id="FAQ">FAQ</h2><p>Q: Does this survive? A: Yes it does, and the answer is long enough to be worth keeping as a record of its own.</p>');
ok('a real answer under FAQ is kept', realFaq.length === 1, realFaq.length);

// 3. The card toolbar's title is UI, not a rule (the event companion's 'WEC_LayTitle').
const toolbar = '<div class="ca7CardToolbar"><h3 id="WEC_LayTitle">Layout</h3><span class="DetFilterToggleText">Hide</span></div><p>Player Hand</p>';
ok('the card toolbar is stripped', stripChrome(toolbar, { name: 'event-companion' }).indexOf('WEC_LayTitle') === -1);
ok('...and another source keeps it', stripChrome(toolbar, { name: 'core-rules' }).indexOf('WEC_LayTitle') !== -1);

// 4. A field label is never a title.
ok('a field label is not a derived title', deriveTitle('MAXIMUM DISTANCE: 3"\nELIGIBLE IF: It is the Fight phase.') === '', deriveTitle('MAXIMUM DISTANCE: 3"\nELIGIBLE IF: It is the Fight phase.'));
ok('the line after the label becomes the title', deriveTitle('ELIGIBLE IF: x\nConsolidation Move is the rule here.') === 'Consolidation Move is the rule here.', deriveTitle('ELIGIBLE IF: x\nConsolidation Move is the rule here.'));
ok('an ordinary first line still titles', deriveTitle('A unit that Falls Back is not eligible to shoot.') === 'A unit that Falls Back is not eligible to shoot.');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
