import fs from 'node:fs';
import { URL_RE, extractEventSlug, isAdminUrl, isLoginPage, authError, splitArticles, buildPlayers } from '../parse.mjs';

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

// Without the login-wall check, a logged-out admin fetch yields zero armies
// and the misleading "lists not published yet" error. Prove the wall hides
// the real cause.
t('login page yields 0 armies', buildPlayers(splitArticles(login)).length, 0);
t('login page yields 0 articles', splitArticles(login).length, 0);

// --- isLoginPage: negative on the real public army-lists fixture ---------
const pub = fs.readFileSync(new URL('./fixtures/public.html', import.meta.url), 'utf8');
t('public page NOT login', isLoginPage(pub), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
