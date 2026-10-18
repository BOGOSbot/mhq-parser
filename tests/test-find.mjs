import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchHeadings } from '../src/header-index.mjs';

// The drawer's search: finding an entry by name, across every book, from the
// heading projection the lookup router already keeps in memory. These are the
// properties a reader would notice if one broke: the name comes first, a mention
// is never an answer, both languages work, and a tap has somewhere to go.
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const unit = searchHeadings('tyrannofex');
ok('a unit name finds its datasheet first', unit.rows.length >= 1 && unit.rows[0].title === 'Tyrannofex' && unit.rows[0].kind === 'datasheet');
const strat = searchHeadings('rapid ingress');
ok('a stratagem name finds the stratagem', strat.rows.length >= 1 && /RAPID INGRESS/i.test(strat.rows[0].title) && strat.rows[0].kind === 'stratagem');
const across = searchHeadings('battle-shock');
ok('one query reaches the rules half', across.rows.length >= 3 && across.rows.some(r => /battle-shock/i.test(r.title)));
ok('a nested row says where the record sits', Array.isArray(across.rows[0].crumbs) && across.rows[0].crumbs.indexOf('Core Concepts') !== -1);
ok('the exact name ranks above the mentions', /^battle-shock rolls$/i.test(across.rows[0].title));

ok('a mention is not a result', searchHeadings('oath of moment').rows.length === 0);
ok('a heading sentence is never offered as a name', searchHeadings('can a unit shoot after it fell back').rows.every(r => r.title.length <= 64 && r.title.indexOf('?') === -1));

ok('a verb in front of a name is not part of the name', searchHeadings('find fuegan').rows[0].title === 'Fuegan');
ok('the French phrasings use the same tables', searchHeadings('trouve fuegan').rows[0].title === 'Fuegan');

ok('one letter searches nothing', searchHeadings('a').rows.length === 0 && searchHeadings('').rows.length === 0);
ok('the list is capped', searchHeadings('battle', { limit: 2 }).rows.length <= 2);
ok('a bound result still counts the whole match', searchHeadings('battle', { limit: 2 }).total >= 3);

// The wire: the drawer asks our own server, which answers from that projection,
// and every row carries the slug the record can be opened by.
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.css'), 'utf8');
ok('the route exists', server.indexOf("u.pathname === '/rules/find'") !== -1 && server.indexOf('handleRulesFind') !== -1);
ok('the route answers from the heading index, with the payload slug', /searchHeadings\(q, \{ limit: 40 \}\)/.test(server) && /slugs = surfaceSlugMap\(\)/.test(server) && /slug: slugs.get\(r.id\)/.test(server));
ok('a row without a slug is dropped, because it cannot be opened', /\.filter\(r => r\.slug\)/.test(server));
ok('the client searches our route', client.indexOf("CFG.find || '/rules/find'") !== -1);
ok('typing debounces into one request', /setTimeout\(function \(\) \{ runSearch\(q\); \}, 180\)/.test(client));
ok('a stale answer cannot overwrite a newer query', /if \(state.searchQ !== q\) return;/.test(client));
ok('a hit opens the record it names', /recordBySlug\(r.slug\)\.then\(function \(rec\) \{ if \(rec\) showInDrawer\(rec, true\); \}\)/.test(client));
ok('the empty state offers the other act', client.indexOf('Ask it instead') !== -1);
ok('the field says what it searches', client.indexOf("filter.placeholder = 'Find a rule, unit or stratagem'") !== -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
