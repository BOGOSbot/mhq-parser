import fs from 'node:fs';
import { parseHtml } from '../parse.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function throws(name, fn, want) {
  try { fn(); fail++; console.log('FAIL ' + name + '\n  want: throw "' + want + '"\n  got : no throw'); }
  catch (e) {
    const msg = String(e && e.message || e);
    if (msg === want) pass++;
    else { fail++; console.log('FAIL ' + name + '\n  got : "' + msg + '"\n  want: "' + want + '"'); }
  }
}

const fix = f => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
// The mini view's first line is "# <event> - <date>"; the rest is the armies.
const miniBody = s => s.slice(s.indexOf(String.fromCharCode(10)));
const pub = fix('public.html');
const army = fix('admin/list-47377.html');
const URL_PUB = 'https://miniheadquarters.com/tournaments/team/army-lists/la-croisade-des-canuts-2-2026-09-19';

// --- a saved page parses exactly like the fetched one --------------------
// The file path only skips the fetch; everything downstream is shared. If the
// two ever diverge, the file button is showing something the URL button does
// not, and one of them is lying.
const viaUrl = parseHtml(pub, { url: URL_PUB });
const viaFile = parseHtml(pub, { name: 'la-croisade-des-canuts-2.html' });
t('file: same armies as the URL path', viaFile.output.count, viaUrl.output.count);
t('file: same players', viaFile.output.players, viaUrl.output.players);
// The mini header carries the event date, which only the URL knows, so compare
// everything under that first line rather than the whole document.
t('file: same mini body', miniBody(viaFile.miniText), miniBody(viaUrl.miniText));
t('file: armies found', viaFile.output.count > 0, true);

// --- the event identity, and where it comes from -------------------------
// With a URL the slug carries the name and the date.
t('url: name from title', viaUrl.output.event.name, 'La Croisade des Canuts 2');
t('url: date from slug', viaUrl.output.event.date, '2026-09-19');
t('url: url kept', viaUrl.output.event.url, URL_PUB);
// A file has no slug, so there is no date to read and no URL to report. The
// <title> of the saved page is still there, so the name survives.
t('file: name still from title', viaFile.output.event.name, 'La Croisade des Canuts 2');
t('file: no date without a slug', viaFile.output.event.date, null);
t('file: no url to report', viaFile.output.event.url, '');

// A saved page with no <title> falls back to the file's own name, prettified.
const noTitle = pub.replace(/<title>[\s\S]*?<\/title>/, '');
t('file: falls back to the file name',
  parseHtml(noTitle, { name: 'tournoi-des-choins-2026-09-19.html' }).output.event.name,
  'tournoi des choins');
t('file: fallback with no name at all',
  parseHtml(noTitle, {}).output.event.name, 'army lists');

// --- a saved admin per-army page ----------------------------------------
// That page has no article cards: its body is one pre-line paragraph, and the
// list header carries the player name. Reading it as a public page would find
// nothing, so the admin reader takes it.
const one = parseHtml(army, { name: 'army.html' });
t('admin file: one army', one.output.count, 1);
t('admin file: player name', one.output.players[0].name, 'Blork');
t('admin file: status kept', one.output.players[0].status, 'Pending');
t('admin file: units parsed', one.output.players[0].units.length > 0, true);

// --- what is not a list page --------------------------------------------
// A file the caller picked by mistake must say so rather than render an empty
// page that looks like a result.
throws('empty file', () => parseHtml('', {}), 'the page is empty - nothing to parse');
throws('blank file', () => parseHtml('   \n  ', {}), 'the page is empty - nothing to parse');
throws('unrelated html', () => parseHtml('<html><body><p>hello</p></body></html>', {}),
  'no army lists found - is this a MiniHeadQuarters army-lists page?');
throws('login page', () => parseHtml(fix('login.html'), {}),
  'no army lists found - is this a MiniHeadQuarters army-lists page?');
throws('non-string', () => parseHtml(null, {}), 'the page is empty - nothing to parse');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
