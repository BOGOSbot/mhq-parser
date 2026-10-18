import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };

// task-103: the reader's own navigation. Measured before the change: the body of
// '2. Profiles' was 2,534 px tall and 322 px wide of a 390 px viewport, and the next
// sibling row sat 2,600 px below the open one - ~3.6 drawer screens of scrolling to
// move from a section to the one after it. Two open records made a 4,909 px tree.
const surface = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.css'), 'utf8');

ok('the reader carries a sibling bar', surface.indexOf('sv-sibbar') !== -1 && surface.indexOf('sv-sib-cur') !== -1);
ok('the bar builds a prev and a next button', /'sv-sib sv-sib-' \+ dir/.test(surface) && /sibButton\(list\[i - 1\], 'prev'\)/.test(surface) && /sibButton\(list\[i \+ 1\], 'next'\)/.test(surface));
ok('a button names its target for a screen reader', /setAttribute\('aria-label', \(dir === 'prev' \? 'Previous: ' : 'Next: '\)/.test(surface));
ok('the bar is sticky at the top of the tree scrollport', /\.sv-sibbar\{position:sticky;top:0/.test(css));
ok('the prev/next targets are 44 px tall', /\.sv-sib\{[^}]*min-height:44px/.test(css));
ok('the current title is the record title, not the numbered row label', /siblingBar\(r, list, at\)/.test(surface) && /sv-sib-cur', titleOf\(r\)/.test(surface));

// The tree hands each row the container's row list, and the row remembers it: that is
// what the bar walks, so the tap does not re-derive the tree from the DOM.
ok('renderNode collects the container rows once', /var rows = shown\.slice\(0, ROW_CAP\)/.test(surface) && /renderRec\(r, rows\)/.test(surface));
ok('renderRec passes the sibling list through', /function renderRec\(r, siblings\)/.test(surface) && /toggleInline\(r, wrap, siblings\)/.test(surface));
ok('the row keeps the list for the bar to walk', /b\.svSiblings = siblings \|\| null/.test(surface));
ok('toggleInline takes the siblings', /function toggleInline\(r, wrap, siblings\)/.test(surface));
ok('a tap opens the sibling and brings its row to the top', /function openSibling\(rec\)/.test(surface) && /scrollIntoView\(\{ block: 'start' \}\)/.test(surface));

// The body reads at the tree's width: the rails cost 12 px per level.
ok('the open body de-indents to the tree edge', /function deIndent\(box\)/.test(surface) && /box\.style\.marginLeft = \(-d\) \+ 'px'/.test(surface) && /deIndent\(box\);/.test(surface));

// One record at a time: two open bodies were the 4,909 px tree.
ok('opening a record closes the other one', /querySelectorAll\('\.sv-inline'\)/.test(surface));
// A detachment's enhancements open INSIDE its own inline box; closing that ancestor
// would append the child to a detached subtree and the tap would do nothing.
ok('the inline that contains the row stays open', /if \(!n\.contains\(wrap\)\) n\.remove\(\)/.test(surface));

// task-107: closing the body above the row just tapped dragged that row off the
// screen (measured: tapped at y=233, landed at y=-105). The tapped row is the
// anchor, and the tree gives back exactly the scroll the closed body took.
ok('the tapped row is measured before the other body closes', /var anchor = tree \? wrap\.getBoundingClientRect\(\)\.top : 0;/.test(surface));
ok('and the tree gives back the scroll that closing it took', /var drift = wrap\.getBoundingClientRect\(\)\.top - anchor;/.test(surface) && /tree\.scrollTop \+= drift/.test(surface));
ok('a row the clamp left above the scrollport is pinned to the top', /if \(wrap\.getBoundingClientRect\(\)\.top < view\.top \+ 2\) wrap\.scrollIntoView\(\{ block: 'start' \}\)/.test(surface));

// The bar must not bring back the duplicate title the row already prints.
ok('the bar does not reintroduce the inline title', surface.indexOf('sv-inline-title') === -1 && surface.indexOf('sv-inline-meta') === -1);

// Grounded in the shipped payload: the bar has somewhere to go on the real corpus.
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', 'rules.json'), 'utf8'));
let node = null;
(function walk(n) { if ((n.recs || []).some(r => r.id === 'core-rules#2.-Profiles')) node = n; (n.kids || []).forEach(walk); })(index);
const recs = (node && node.recs) || [];
const at = recs.findIndex(r => r.id === 'core-rules#2.-Profiles');
ok('2. Profiles sits in a row list with both neighbours', at > 0 && at < recs.length - 1 && recs.length > 2);
ok('its neighbours are the sections a player reads next', !!recs[at - 1] && recs[at - 1].title === '1. Datasheet Name' && !!recs[at + 1] && recs[at + 1].title === '3. Abilities');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
