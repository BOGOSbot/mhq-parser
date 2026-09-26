import { pageEvents } from '../parse.mjs';
import { FILTER_WINDOW_DAYS, verdictOf, decorate, filteredList, scanEnvelope, plainEnvelope } from '../server.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// ============================================================
// The /events contract. The picker printed "1328 found · checking undefined of
// 1328 in the last…" and refetched every three seconds forever, because the
// unfiltered branch returned no "scanned" or "windowDays" while the UI branched
// on the presence of "total" - which both branches carry. These assertions pin
// the two envelopes, the verdict cache that decorates them, and the status line
// that reads them, so none of the three can drift apart again.
// ============================================================

// --- pageEvents: "count" is the page, "total" is the pool ----------------
// Both used to come back as the pool, which is how a 250-row list announced
// itself as "1328 found".
const POOL = [1, 2, 3, 4, 5];
t('page: count is the page', pageEvents(POOL, 2).count, 2);
t('page: total is the pool', pageEvents(POOL, 2).total, 5);
t('page: events is a prefix', pageEvents(POOL, 2).events, [1, 2]);
t('page: limit beyond the pool', pageEvents(POOL, 99).count, 5);
t('page: empty pool', pageEvents([], 10), { events: [], count: 0, total: 0 });

// --- The two envelopes ------------------------------------------------------
const LIST_EVENTS_RESULT = {
  events: [
    { slug: 'a', type: 'team', date: '2026-09-19',
      url: 'https://miniheadquarters.com/tournaments/team/army-lists/a',
      detailsUrl: 'https://miniheadquarters.com/tournaments/team/details/a' },
    { slug: 'b', type: 'individual', date: '2026-08-01',
      url: 'https://miniheadquarters.com/tournaments/individual/army-lists/b',
      detailsUrl: 'https://miniheadquarters.com/tournaments/individual/details/b' },
  ],
  count: 2, total: 5, cached: false, fetchedAt: '2026-09-26T00:00:00.000Z',
};

const plain = plainEnvelope(LIST_EVENTS_RESULT);
t('plain: filtered is false', plain.filtered, false);
t('plain: done is true - no scan to poll for', plain.done, true);
t('plain: no window to name', plain.windowDays, null);
t('plain: count is the rows returned', plain.count, plain.events.length);
t('plain: count does not exceed total', plain.count <= plain.total, true);
t('plain: carries no scanned figure', 'scanned' in plain, false);
t('plain: keeps the list fields', plain.cached, false);
t('plain: keeps the list total', plain.total, 5);

const SCAN_EVENTS = [LIST_EVENTS_RESULT.events[0]];
const inFlight = scanEnvelope(SCAN_EVENTS, { scanned: 12, total: 476, done: false });
const finished = scanEnvelope(SCAN_EVENTS, { scanned: 476, total: 476, done: true });
t('scan: filtered is true', inFlight.filtered, true);
t('scan: window is the filter window', inFlight.windowDays, FILTER_WINDOW_DAYS);
t('scan: count is the rows returned', inFlight.count, inFlight.events.length);
t('scan: reports the in-flight figure', inFlight.scanned, 12);
t('scan: done tracks the progress', inFlight.done, false);
t('scan finished: done is true', finished.done, true);
t('scan finished: reports the check count', finished.scanned, 476);

// --- The verdict cache, and the decoration that reads it ---------------------
// The plain listing is one sitemap read; decoration must never fetch. A row is
// therefore in one of three states, and 0 is an answer rather than "unknown".
const NOW = Date.now();
const ev = (slug, type) => ({
  slug,
  detailsUrl: 'https://miniheadquarters.com/tournaments/' + (type || 'team') + '/details/' + slug,
});
const CACHE = new Map([
  [ev('a').detailsUrl, { game: 'Warhammer 40,000', hasLists: true, listCount: 4, at: NOW }],
  [ev('b', 'individual').detailsUrl, { game: 'Warhammer 40,000', hasLists: false, listCount: 0, at: NOW }],
  [ev('stale').detailsUrl, { game: 'Warhammer 40,000', hasLists: true, listCount: 9, at: NOW - 2 * 60 * 60 * 1000 }],
  [ev('other').detailsUrl, { game: 'Infinity', hasLists: true, listCount: 3, at: NOW }],
]);
const ROWS = [ev('a'), ev('b', 'individual'), ev('c'), ev('stale'), ev('other')];

t('verdict: a fresh answer counts', verdictOf(ev('a'), CACHE) !== null, true);
t('verdict: never checked', verdictOf(ev('c'), CACHE), null);
t('verdict: a stale answer is not current', verdictOf(ev('stale'), CACHE), null);

const dec = decorate(ROWS, CACHE);
t('decorate: a fresh answer is attached', dec[0].listCount, 4);
t('decorate: zero is an answer, not unknown', dec[1].listCount, 0);
t('decorate: an unknown stays absent', 'listCount' in dec[2], false);
t('decorate: a stale answer stays absent', 'listCount' in dec[3], false);
t('decorate: every game is labelled, not just 40k', dec[4].listCount, 3);
t('decorate: it does not mutate its input', 'listCount' in ROWS[0], false);
t('decorate: it keeps the row count', dec.length, ROWS.length);

const FL = filteredList(ROWS, 10, CACHE);
t('filtered: only 40k with lists out', FL.length, 1);
t('filtered: and it is the right row', FL[0].slug, 'a');
t('filtered: the limit still binds', filteredList(ROWS, 1, CACHE).length, 1);

// Decoration is where the count enters the plain contract.
const DECORATED = plainEnvelope(LIST_EVENTS_RESULT, CACHE);
t('plain: a decorated row carries its count', DECORATED.events[0].listCount, 4);
t('plain: a zero is passed through, not dropped', DECORATED.events[1].listCount, 0);
t('plain: decoration does not change the shape', DECORATED.filtered, false);
t('plain: decoration does not end the listing', DECORATED.done, true);

// --- The status line, mirrored from index.html -----------------------------
// The UI writes the row count first, then this overwrites it. "mine" is handled
// before any of these branches and is not mirrored here.
function windowLabel(days) {
  if (!days) return '';
  if (days >= 365 && days % 365 === 0) {
    const y = days / 365;
    return y + (y === 1 ? ' year' : ' years');
  }
  return days + ' days';
}
// How many of the rows returned already carry a verdict.
function checkedOf(j) {
  let n = 0;
  for (const e of j.events || []) if (e.listCount != null) n++;
  return n;
}
function statusText(j) {
  // The plain branch counts the rows in evCache, which is j.events verbatim.
  const shown = (j.events || []).length;
  if (j.filtered === false) {
    const checked = checkedOf(j);
    return shown + ' of ' + j.total + ' events ·' +
      (checked ? ' ' + checked + ' checked ·' : '') + ' all games, lists not checked';
  }
  if (j.done === true) return j.count + ' events in the last ' + windowLabel(j.windowDays) + ' (' + j.scanned + ' checked)';
  if (j.scanned != null) return j.count + ' found · checking ' + j.scanned + ' of ' + j.total + ' in the last ' + windowLabel(j.windowDays) + '…';
  return '';
}
// The lists column of a row, mirrored from renderEvList.
function listsLabel(e) {
  return e.listCount == null ? '…' : e.listCount + ' list' + (e.listCount === 1 ? '' : 's');
}
function listsClass(e) {
  return e.listCount == null ? 'pending' : (e.listCount > 0 ? 'yes' : 'no');
}
// Whether loadEvents reschedules itself.
function polls(j) {
  return j.filtered !== false && j.done !== true && j.scanned != null;
}

t('window label: 365', windowLabel(365), '1 year');
t('window label: 730', windowLabel(730), '2 years');
t('window label: 90', windowLabel(90), '90 days');
t('window label: none', windowLabel(null), '');

t('plain: names the catalogue', statusText(plain), '2 of 5 events · all games, lists not checked');
t('plain: says how many rows are checked', statusText(DECORATED), '2 of 5 events · 2 checked · all games, lists not checked');
t('plain: no "undefined" in the line', /undefined/.test(statusText(plain)), false);
t('plain: does not poll', polls(plain), false);

t('label: never asked is a dash', listsLabel(dec[2]), '…');
t('label: zero is an answer', listsLabel(dec[1]), '0 lists');
t('label: one is singular', listsLabel({ listCount: 1 }), '1 list');
t('label: four is plural', listsLabel({ listCount: 4 }), '4 lists');
t('class: never asked is pending', listsClass(dec[2]), 'pending');
t('class: zero is no', listsClass(dec[1]), 'no');
t('class: a count is yes', listsClass(dec[0]), 'yes');

t('in flight: reports progress', statusText(inFlight), '1 found · checking 12 of 476 in the last 1 year…');
t('in flight: polls', polls(inFlight), true);
t('in flight: no "undefined" in the line', /undefined/.test(statusText(inFlight)), false);

t('finished: reports the check count', statusText(finished), '1 events in the last 1 year (476 checked)');
t('finished: does not poll', polls(finished), false);

// The regression. A response that carries a "total" and nothing else is what the
// unfiltered branch used to look like; the old UI matched it, printed
// "checking undefined of 1328" and polled forever.
const BARE = { events: [], count: 0, total: 1328, cached: false, fetchedAt: '2026-09-26T00:00:00.000Z' };
t('bare total: the line stays empty', statusText(BARE), '');
t('bare total: no "undefined" in the line', /undefined/.test(statusText(BARE)), false);
t('bare total: does not poll', polls(BARE), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
