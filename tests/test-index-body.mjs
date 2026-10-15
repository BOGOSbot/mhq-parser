import { TOC_JS, TOC_CSS } from '../src/wiki-toc.mjs';

// The task-61 regression, pinned structurally: the top bar is the index (path
// cards only) and the BODY carries the current level's choices, so a non-leaf
// level can never render an empty pane. The runtime proof is the live page.
let pass = 0, fail = 0;
function ok(name, got) { if (got) pass++; else { fail++; console.log('FAIL ' + name); } }
const js = TOC_JS;
ok('render() appends the entries to the BODY', js.indexOf('entryCards(pane, current())') !== -1);
ok('and never to the path bar', js.indexOf('entryCards(col, current())') === -1);
ok('the path bar is built from the path alone, into col', js.indexOf('col.appendChild(cr)') !== -1 && js.indexOf('data-wc-jump') !== -1);
ok('the body is cleared before the entries are built', js.indexOf('pane.textContent = ""; entryCards(pane, current())') !== -1);
ok('a node with nothing says so instead of rendering blank', js.indexOf('Nothing under this node') !== -1 && js.indexOf('wcempty') !== -1);
ok('the body rows are styled apart from the path pills', TOC_CSS.indexOf('#wcpane .wccard{') !== -1 && TOC_CSS.indexOf('.wccard{flex:0 0 auto') !== -1);
ok('the here-scroll follows the entries into the body', js.indexOf('pane.querySelector(".wccard.here")') !== -1);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
