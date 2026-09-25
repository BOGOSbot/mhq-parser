import fs from 'node:fs';
import { URL_RE, ADMIN_LIST_RE, extractEventSlug, isAdminUrl, isLoginPage, authError, splitArticles, buildPlayers, loginFormError, setCookieOf, splitAdminRows, adminListContent, adminStatusOf, adminArticle, getMeta, totals, parseOrganizedRows, formatDateOf } from '../parse.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- URL_RE: shapes we must accept -------------------------------------
const ok_ = [
  ['public army-lists', 'https://miniheadquarters.com/tournaments/team/army-lists/la-croisade-des-canuts-2-2026-09-19'],
  ['public details',    'https://miniheadquarters.com/tournaments/team/details/la-croisade-des-canuts-2-2026-09-19'],
  ['individual',        'https://miniheadquarters.com/tournaments/individual/army-lists/open-2026-09-19'],
  ['2v2',               'https://miniheadquarters.com/tournaments/2v2/army-lists/slug'],
  ['side-by-side',      'https://miniheadquarters.com/tournaments/side-by-side/details/slug'],
  ['admin army-lists',  'https://miniheadquarters.com/tournaments/team/administrate/bogos-team-6-des-sous-terre-2026-10-10/army-lists'],
  ['admin details',     'https://miniheadquarters.com/tournaments/individual/administrate/slug/details'],
  ['trailing slash',    'https://miniheadquarters.com/tournaments/team/army-lists/slug/'],
];
for (const [n, u] of ok_) t('accept: ' + n, URL_RE.test(u), true);

// --- URL_RE: shapes we must reject --------------------------------------
const bad = [
  ['wrong host',     'https://example.com/tournaments/team/army-lists/x'],
  ['no type',        'https://miniheadquarters.com/tournaments/army-lists/x'],
  ['unknown type',   'https://miniheadquarters.com/tournaments/teams/army-lists/x'],
  ['unknown segment','https://miniheadquarters.com/tournaments/team/notes/x'],
  ['no slug',        'https://miniheadquarters.com/tournaments/team/army-lists'],
  ['empty slug',     'https://miniheadquarters.com/tournaments/team/army-lists/'],
  ['two slugs',      'https://miniheadquarters.com/tournaments/team/army-lists/a/b'],
  ['not https',      'http://miniheadquarters.com/tournaments/team/army-lists/x'],
];
for (const [n, u] of bad) t('reject: ' + n, URL_RE.test(u), false);

// --- extractEventSlug ---------------------------------------------------
t('slug public', extractEventSlug('https://miniheadquarters.com/tournaments/team/army-lists/la-croisade-des-canuts-2-2026-09-19'), 'la-croisade-des-canuts-2-2026-09-19');
t('slug admin',  extractEventSlug('https://miniheadquarters.com/tournaments/team/administrate/bogos-team-6-des-sous-terre-2026-10-10/army-lists'), 'bogos-team-6-des-sous-terre-2026-10-10');
t('slug details',extractEventSlug('https://miniheadquarters.com/tournaments/individual/details/x-1'), 'x-1');
t('slug query',  extractEventSlug('https://miniheadquarters.com/tournaments/team/army-lists/slug?tab=2'), 'slug');

// --- The UI's admin URL builder must produce URLs the parser accepts ------
// index.html builds it as /tournaments/<type>/administrate/<slug>/army-lists
// for the Browse "organiser view" checkbox. Mirror it here so a change to
// URL_RE cannot silently break that checkbox - the failure would be a bare 400.
function adminUrlOf(ev) {
  return 'https://miniheadquarters.com/tournaments/' + ev.type +
    '/administrate/' + ev.slug + '/army-lists';
}
for (const ev of [
  { type: 'team', slug: 'bogos-team-6-des-sous-terre-2026-10-10' },
  { type: 'individual', slug: 'fluffpoesie-solo-40k-decembre-2021-12-19' },
  { type: '2v2', slug: 'some-2v2-slug' },
  { type: 'side-by-side', slug: 'some-sbs-slug' },
]) {
  const u = adminUrlOf(ev);
  t('admin url accepted: ' + ev.type, URL_RE.test(u), true);
  t('admin slug recovered: ' + ev.type, extractEventSlug(u), ev.slug);
  t('admin url flagged: ' + ev.type, isAdminUrl(u), true);
}

// --- isAdminUrl ----------------------------------------------------------
t('admin true',  isAdminUrl('https://miniheadquarters.com/tournaments/team/administrate/slug/army-lists'), true);
t('admin false', isAdminUrl('https://miniheadquarters.com/tournaments/team/army-lists/slug'), false);

// server.mjs maps this exact phrase to HTTP 401; keep the coupling honest.
t('authError phrase matches server 401 regex', /authentication required/.test(authError('https://miniheadquarters.com/tournaments/team/administrate/s/army-lists')), true);
t('authError phrase absent from normal errors', /authentication required/.test('no army lists found - this event has probably not published its lists yet'), false);

// --- isLoginPage: positive on the real Django login fixture ---------------
const login = fs.readFileSync(new URL('./fixtures/login.html', import.meta.url), 'utf8');
t('login fixture detected', isLoginPage(login), true);
t('authError mentions cookie', /--cookie/.test(authError('https://miniheadquarters.com/tournaments/team/administrate/s/army-lists')), true);
t('authError mentions url', /\barmy-lists\b/.test(authError('https://miniheadquarters.com/tournaments/team/administrate/s/army-lists')), true);

// --- login failure parsing ----------------------------------------------
// loginSession POSTs credentials and tells success from a sessionid in
// Set-Cookie; anything else is a failure whose reason is Django's own text.
// That text lives inside a red panel, not a <p class="error">, so the panel is
// matched by its tint. Verified against a real failed-login response.
const loginFailed = fs.readFileSync(new URL('./fixtures/login-failed.html', import.meta.url), 'utf8');
t('failed login error extracted', loginFormError(loginFailed), 'Please enter a correct username and password. Note that both fields may be case-sensitive.');
t('login page has no error', loginFormError(login), null);
// The red panel is the only red block on the page, so nothing else can match.
t('no false positive on slate text', loginFormError('<p class="text-slate-400">Some neutral text here</p>'), null);

// Set-Cookie parsing: node reports this header as an array.
t('setCookieOf array', setCookieOf({ 'set-cookie': ['csrftoken=abc123; Path=/', 'sessionid=sess999; HttpOnly'] }, 'sessionid'), 'sess999');
t('setCookieOf single string', setCookieOf({ 'set-cookie': 'sessionid=onlyone; Path=/' }, 'sessionid'), 'onlyone');
t('setCookieOf absent', setCookieOf({ 'set-cookie': ['other=x; Path=/'] }, 'sessionid'), null);
t('setCookieOf no header', setCookieOf({}, 'sessionid'), null);
t('setCookieOf value with slash', setCookieOf({ 'set-cookie': ['sessionid=abc/def123; Path=/'] }, 'sessionid'), 'abc/def123');

// Without the login-wall check, a logged-out admin fetch yields zero armies
// and the misleading "lists not published yet" error. Prove the wall hides
// the real cause.
t('login page yields 0 armies', buildPlayers(splitArticles(login)).length, 0);
t('login page yields 0 articles', splitArticles(login).length, 0);

// --- isLoginPage: negative on the real public army-lists fixture ---------
const pub = fs.readFileSync(new URL('./fixtures/public.html', import.meta.url), 'utf8');
t('public page NOT login', isLoginPage(pub), false);


// --- Admin (organiser) pages -------------------------------------------
// The admin event page is a <table> of submitted armies; each army's body
// lives on its own /administrate/army-lists/<id> page, so a full admin parse
// fetches one page per army. The fixtures are a real event and its armies.

// The per-army route is not under the event slug, so it is its own URL arm.
t('accept admin per-army', URL_RE.test('https://miniheadquarters.com/tournaments/team/administrate/army-lists/47377'), true);
t('accept admin per-army individual', URL_RE.test('https://miniheadquarters.com/tournaments/individual/administrate/army-lists/12345'), true);
t('detail id extracted', ADMIN_LIST_RE.exec('https://miniheadquarters.com/tournaments/team/administrate/army-lists/47377')[1], '47377');
// The index URL ends in /army-lists with nothing after it, so it must NOT be
// mistaken for a per-army URL - a false match would silently parse one army.
t('index is not per-army', ADMIN_LIST_RE.exec('https://miniheadquarters.com/tournaments/team/administrate/slug-2026-01-01/army-lists'), null);
t('detail url flagged admin', isAdminUrl('https://miniheadquarters.com/tournaments/team/administrate/army-lists/47377'), true);
// The admin index puts the slug BEFORE /army-lists, so it is recovered the
// other way round and the event date still parses from it.
t('index slug recovered', extractEventSlug('https://miniheadquarters.com/tournaments/team/administrate/bogos-team-6-des-sous-terre-2026-10-10/army-lists'), 'bogos-team-6-des-sous-terre-2026-10-10');

const adminIdx = fs.readFileSync(new URL('./fixtures/admin/index.html', import.meta.url), 'utf8');
const rows = splitAdminRows(adminIdx);
t('admin row count', rows.length, 6);
t('rows have unique ids', new Set(rows.map(r => r.id)).size, 6);
t('row id', rows[0].id, '47377');
t('row username', rows[0].username, 'Blork');
t('row team', rows[0].team, 'Random Wargame Club');
t('row faction', rows[0].faction, 'Chaos - Chaos Knights');
t('row status', rows[0].status, 'Pending validation');
t('row lastModified', rows[0].lastModified, '09/21/2026 10:41 a.m.');
t('row url', rows[0].url, 'https://miniheadquarters.com/tournaments/team/administrate/army-lists/47377');
// A non-admin page has no such table, so the splitter must not invent rows.
t('public page has no admin rows', splitAdminRows(pub).length, 0);
t('login page has no admin rows', splitAdminRows(login).length, 0);

const listHtml = fs.readFileSync(new URL('./fixtures/admin/list-47377.html', import.meta.url), 'utf8');
const content = adminListContent(listHtml);
t('admin content found', content !== null, true);
t('admin content names the player', /Blork/.test(content), true);
t('admin content has points', /(\s*135\s*pts)/.test(content), true);
t('admin status on detail page', adminStatusOf(listHtml), 'Pending');
t('admin status absent from index', adminStatusOf(adminIdx), null);

// The table row becomes a synthetic <h2> "Name : Faction" plus the body, so
// the public parsing pipeline is reused unchanged. This is the round trip.
const players = buildPlayers([adminArticle(rows[0], content)]);
t('admin player count', players.length, 1);
t('admin player name', players[0].name, 'Blork');
t('admin player faction', players[0].faction, 'Chaos - Chaos Knights');
t('admin player team', players[0].teamName, 'Random Wargame Club');
t('admin unit count', (players[0].units || []).length, 14);
t('admin parsed points', totals(players[0]).parsedPts, 2000);
t('admin declared points', totals(players[0]).declaredPts, 2000);
t('admin detachment', getMeta(players[0]).detachment, 'Houndpack Lance, Hunting Warpack (Marked Prey)');

// A submitted list can be empty; that must yield a player, not a crash.
const empty = buildPlayers([adminArticle({ id: '99', username: 'Nobody', faction: 'Undeclared', team: '' }, '')]);
t('empty body still yields a player', empty.length, 1);
t('empty body player name', empty[0].name, 'Nobody');
// --- organizer events: the events the caller runs -------------------------------
// The sitemap cannot see private or unpublished events, so the picker reads
// MHQ's authenticated list instead. One <tr> per event: public details href,
// name, a display-form date, and opacity-60 on the <tr> for past tournaments.
const organized = fs.readFileSync(new URL('./fixtures/organized.html', import.meta.url), 'utf8');
const org = parseOrganizedRows(organized);
t('organized row count', org.length, 4);
t('organized name', org[0].name, 'BOGOS Team : 6 dés sous terre');
t('organized slug', org[0].slug, 'bogos-team-6-des-sous-terre-2026-10-10');
t('organized type', org[0].type, 'team');
t('organized date parsed', org[0].date, '2026-10-10');
t('organized admin url', org[0].url, 'https://miniheadquarters.com/tournaments/team/administrate/bogos-team-6-des-sous-terre-2026-10-10/army-lists');
t('organized public url', org[0].detailsUrl, 'https://miniheadquarters.com/tournaments/team/details/bogos-team-6-des-sous-terre-2026-10-10');
t('organized format from type', org[0].format, 'teams');
t('organized past flag off', org[0].past, false);
t('organized listCount unknown', org[0].listCount, null);
// Finished events carry opacity-60 on the <tr>; that is the site's only signal.
const past = org.filter(e => e.past);
t('past rows found', past.length, 3);
t('past row date', past[0].date, '2026-05-16');
// Each type maps to the label the format filter in the UI matches.
t('2v2 format from type', org.find(e => e.type === 'side-by-side').format, '2v2 (side-by-side)');
t('1v1 format from type', org.find(e => e.type === 'individual').format, '1v1');
// The site uses a display form; listEvents uses ISO, so it needs translating.
t('formatDateOf oct', formatDateOf('Oct. 10, 2026'), '2026-10-10');
t('formatDateOf no dot', formatDateOf('Sept 5, 2027'), '2027-09-05');
t('formatDateOf single digit', formatDateOf('Mar 4, 2026'), '2026-03-04');
t('formatDateOf not a date', formatDateOf('Pending validation'), null);
t('formatDateOf empty', formatDateOf(''), null);
t('formatDateOf unknown month', formatDateOf('Foo 3, 2026'), null);
// Nothing to parse on a page that is not the list.
t('login page yields no rows', parseOrganizedRows(login).length, 0);
t('public page yields no rows', parseOrganizedRows(pub).length, 0);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
