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
const page = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');

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

// task-108: opening a CHAPTER rebuilt the tree, threw the open record away and moved
// the scroll (measured: 08.05 open, tap 19, tapped header at 453 landed at -72).
// The tapped node anchors the render, and the open record is restored after it.
ok('the render is anchored to the tapped node', /function renderTree\(anchor\)/.test(surface) && /var a0 = anchor \? findByAttr\(box, anchor\.attr, anchor\.val\) : null;/.test(surface));
ok('and the tapped node is put back after the rebuild', /var a1 = findByAttr\(box, anchor\.attr, anchor\.val\);/.test(surface) && /box\.scrollTop \+= drift/.test(surface));
ok('a node carries its own key as the anchor', /renderTree\(\{ attr: 'data-node', val: key \}\)/.test(surface) && /renderTree\(anchor\)/.test(surface) && /openBranch\(b\.b, \{ attr: 'data-branch', val: b\.b \}\)/.test(surface));
ok('the open record survives a re-render', /state\.openRec = r;/.test(surface) && /function restoreInline\(\)/.test(surface) && /toggleInline\(r, row\.parentNode, row\.svSiblings\)/.test(surface));
ok('and closing it forgets it', /existing\.remove\(\); state\.openRec = null;/.test(surface));

// task-14: a chapter's sections and its own rows are one numbered list in the
// drawer - intro row first, then 0x.0x sections and numbered rows by number, so a
// single-record section (01.06) keeps its place.
ok('a chapter interleaves its sections and rows by number', /function chapterItems\(/.test(surface) && /n\.lvl === 'chapter' && kids\.length/.test(surface) && /cmpKey\(x\.key, y\.key\) \|\| x\.ord - y\.ord/.test(surface));
ok('and its own intro row sorts before the numbered list', /key = \[-1, 0, 0\]/.test(surface));

// task-8/20: the one door. A finding row opens the door the settings choose; the
// switch left the record header and the drawer head for the settings sheet, the
// choice is kept in localStorage ('mhq.rules.door', In the book by default), and
// the section path under a row follows it. The drawer side reuses the entry the
// tree already has.
ok('a row tap asks the door, not the record directly', /ctx\.openDoor\(state, f\)/.test(surface) && !/ctx\.openRecord\(state, f\.id\)/.test(surface));
ok('the section path is a button that follows the switch', /'fcrumbs fpath'/.test(surface) && /ctx\.doorMode\(state\) === 'inline' \? ctx\.t\('doorInline'\) : ctx\.t\('doorWiki'\)/.test(surface));
ok('the row carries one ... sheet button', /'fmore'/.test(surface) && /ctx\.findingSheet\(state, f\)/.test(surface));
ok('the sheet keeps Put first, Ignore and the book door', /sheetAction\('first'/.test(page) && /sheetAction\('ignore'/.test(page) && /sheetAction\('wiki'/.test(page) && /t\('sheetWiki'\)/.test(page));
ok('the record header carries no door switch any more', page.indexOf('doorbar') === -1 && page.indexOf('doorSeg(') === -1);
ok('the choice is persisted under one key', page.indexOf("var DOOR_KEY = 'mhq.rules.door'") !== -1 && /localStorage\.setItem\(DOOR_KEY/.test(page));
ok('Wiki is the default, and the stored value migrates by meaning', /saved === 'quick'\) return 'wiki'/.test(page) && /saved === 'book'\) return 'inline'/.test(page) && /return 'wiki';/.test(page));
ok('the settings sheet is where the choice is made', /id="findingsseg"/.test(page) && /data-door="wiki"/.test(page) && /data-door="inline"/.test(page) && /function setDoor\(mode\)/.test(page));
ok('inline mode opens the drawer through the surface entry', /function openInline\(state, f\)/.test(page) && /api\.openRecordInTree\(f\)/.test(page));
ok('the drawer reveals the record in its chapter and inlines it', /function revealInTree\(f\)/.test(surface) && /function findOwner\(root, branch, id\)/.test(surface) && /toggleInline\(recordLike\(f\), row\.parentNode, row\.svSiblings\)/.test(surface));
ok('a record with no tree row still opens at its chapter, and says why', /function findChapterKey\(root, branch, f\)/.test(surface) && /showInDrawer\(recordLike\(f\), true, 'This record has no place in the tree/.test(surface));
ok('the drawer head paints no switch', surface.indexOf('doorSwitch') === -1 && /openRecordInTree: revealInTree/.test(surface));

// The bar must not bring back the duplicate title the row already prints.
ok('the bar does not reintroduce the inline title', surface.indexOf('sv-inline-title') === -1 && surface.indexOf('sv-inline-meta') === -1);

// Grounded in the shipped payload: the bar has somewhere to go on the real corpus.
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', 'rules.json'), 'utf8'));
let node = null;
(function walk(n) { if ((n.recs || []).some(r => r.id === 'core-rules#2.-Profiles')) node = n; (n.kids || []).forEach(walk); })(index);
const recs = (node && node.recs) || [];
const at = recs.findIndex(r => r.id === 'rules-appendix#Modifiers');
ok('2. Profiles and its definitions sit in one row list', recs.length > 2 && recs[0].id === 'core-rules#2.-Profiles' && at > 0 && at < recs.length - 1);
// task-5: the appendix's definitions follow the rule in number order under the
// 0x.0x section, so the section's lead row and the first definition are neighbours.
ok('its neighbours are the rule and the next definition', recs[at - 1].title === '2. Profiles' && recs[at + 1].title === 'Ignore Modifiers');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
