import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHtml, renderMini } from '../parse.mjs';
import { candidates, entryFor, entryForKey, eventKey, is40k, isClosed, keyOfUrl, loadIndex, readEvent, rowFor, saveIndex } from '../archive.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// A parse of the real public fixture, written where an archived event lives.
const pub = fs.readFileSync(new URL('./fixtures/public.html', import.meta.url), 'utf8');
const parsed = parseHtml(pub, { name: 'fixture.html' });

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-archive-' + tag + '-'));
}
function writeEvent(dir, name, output) {
  const rel = path.join('events', name);
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(output));
  return rel.split(path.sep).join('/');
}

// --- isClosed: the rule the whole harvest turns on -------------------------
t('closed yesterday', isClosed({ date: '2026-01-01' }, '2026-01-02'), true);
t('not closed today', isClosed({ date: '2026-01-02' }, '2026-01-02'), false);
t('not closed tomorrow', isClosed({ date: '2026-01-03' }, '2026-01-02'), false);
// A date that cannot be read is neither side of today. Guessing would archive
// an event that has not happened yet.
t('undated is not closed', isClosed({ date: null }, '2026-01-02'), false);
t('empty date is not closed', isClosed({ date: '' }, '2026-01-02'), false);
t('non-string date is not closed', isClosed({ date: 20260101 }, '2026-01-02'), false);

// --- is40k: the other half of "what is worth keeping" ----------------------
t('40k', is40k('Warhammer 40,000'), true);
t('40k spacing', is40k('Warhammer 40K'), true);
t('30k', is40k('Warhammer 30,000'), false);
t('old world', is40k('Warhammer: The Old World'), false);
t('missing game', is40k(null), false);

// --- keyOfUrl: which URLs the cache is allowed to answer -------------------
// A hit has to be a plain public event page. Anything else is either a
// different view (organiser) or not an event at all, and answering those from
// the cache would show the wrong armies.
t('army-lists url', keyOfUrl('https://miniheadquarters.com/tournaments/team/army-lists/foo-2026-01-01'), 'team/foo-2026-01-01');
t('details url', keyOfUrl('https://miniheadquarters.com/tournaments/individual/details/foo-2026-01-01'), 'individual/foo-2026-01-01');
t('side-by-side url', keyOfUrl('https://miniheadquarters.com/tournaments/side-by-side/army-lists/bar'), 'side-by-side/bar');
t('trailing slash', keyOfUrl('https://miniheadquarters.com/tournaments/team/army-lists/foo/'), 'team/foo');
t('query string', keyOfUrl('https://miniheadquarters.com/tournaments/team/army-lists/foo?tab=2'), 'team/foo');
t('organiser url is not cached', keyOfUrl('https://miniheadquarters.com/tournaments/team/administrate/foo-2026-01-01/army-lists'), null);
t('single submitted army is not cached', keyOfUrl('https://miniheadquarters.com/tournaments/team/administrate/army-lists/47377'), null);
t('another host', keyOfUrl('https://example.com/tournaments/team/army-lists/foo'), null);
t('not an event path', keyOfUrl('https://miniheadquarters.com/tournaments/team'), null);
t('not a url at all', keyOfUrl('nonsense'), null);
// The key the site resolves from a URL has to be the key the harvest writes.
t('key round trip', eventKey('team', 'foo'), keyOfUrl('https://miniheadquarters.com/tournaments/team/army-lists/foo'));

// --- the store: write an entry, read it back the way the server does -------
const dir = tmpDir('store');
const rel = writeEvent(dir, 'team--fixture.json', parsed.output);
const entry = {
  key: eventKey('team', 'fixture'),
  type: 'team',
  slug: 'fixture',
  name: parsed.output.event.name,
  date: parsed.output.event.date,
  format: 'teams',
  game: 'Warhammer 40,000',
  url: 'https://miniheadquarters.com/tournaments/team/army-lists/fixture',
  detailsUrl: 'https://miniheadquarters.com/tournaments/team/details/fixture',
  listCount: parsed.output.count,
  bytes: 1234,
  archivedAt: '2026-10-04T00:00:00.000Z',
  file: rel,
};
saveIndex(dir, { events: [entry] });

const idx = loadIndex(dir);
t('index has the entry', idx.events.length, 1);
t('index carries a generated stamp', typeof idx.generated, 'string');
t('lookup by key', entryForKey(idx, 'team/fixture').slug, 'fixture');
t('lookup by type and slug', entryFor(idx, 'team', 'fixture').slug, 'fixture');
t('a miss is null, not an error', entryFor(idx, 'team', 'something-else'), null);
t('a miss on an empty index is null', entryFor({ events: [] }, 'team', 'x'), null);

// What the server answers from the archive must be what a live parse answers:
// same players, same count, same mini view. Anything else and the cache is a
// different tool wearing the same shape.
const hit = readEvent(dir, entryForKey(idx, 'team/fixture'));
t('count survives the round trip', hit.count, parsed.output.count);
t('players survive the round trip', hit.players.length, parsed.output.players.length);
t('event survives the round trip', hit.event, parsed.output.event);
t('mini view is identical', renderMini(hit), parsed.miniText);

// An index entry whose file is gone must read as a miss, so the caller can go
// and fetch the page instead of failing the request.
t('missing file reads as null', readEvent(dir, { file: 'events/gone.json' }), null);
t('entry without a file reads as null', readEvent(dir, { key: 'x' }), null);

// --- rowFor: the archive has to look like a sitemap row --------------------
// One picker, one row shape: an archived event must not need a second render
// path on the page.
const row = rowFor(entry);
t('row is closed', row.past, true);
t('row is marked archived', row.archived, true);
t('row is pre-checked', row.checked, true);
t('row keeps its list count', row.listCount, parsed.output.count);
t('row keeps its format', row.format, 'teams');
t('row keeps its date', row.date, parsed.output.event.date);
t('row keeps its url', row.url, entry.url);
t('row keeps its details url', row.detailsUrl, entry.detailsUrl);
t('row keeps its slug', row.slug, 'fixture');

// --- candidates: what a rerun would still fetch ----------------------------
const sitemap = [
  { type: 'team', slug: 'a', date: '2026-01-01' },      // closed, not archived yet
  { type: 'team', slug: 'fixture', date: '2026-01-01' }, // closed, already archived
  { type: 'team', slug: 'b', date: '2030-01-01' },      // not closed
  { type: 'team', slug: 'c', date: null },              // undated
];
t('candidates skip the archived', candidates(sitemap, idx, { today: '2026-10-04' }).map(e => e.slug), ['a']);
t('refresh reconsiders the archived', candidates(sitemap, idx, { today: '2026-10-04', refresh: true }).map(e => e.slug).sort(), ['a', 'fixture']);
// 'fixture' stays out even once it is in the past: it is already archived, so
// a rerun must not fetch it again. 'b' joins 'a' once its date is behind us.
t('candidates leave the future alone', candidates(sitemap, idx, { today: '2031-01-01' }).map(e => e.slug).sort(), ['a', 'b']);
t('an empty archive has nothing to skip', candidates([sitemap[0]], { events: [] }, { today: '2026-10-04' }).length, 1);

// --- an absent archive is not an error -------------------------------------
// A clone without the archive committed, or a server started before the first
// harvest: the picker still works, there is simply nothing cached.
const empty = tmpDir('empty');
t('no index reads as empty', loadIndex(empty).events.length, 0);
t('lookup in an absent archive', entryFor(loadIndex(empty), 'team', 'x'), null);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
