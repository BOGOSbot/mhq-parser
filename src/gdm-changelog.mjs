// The canon for "is our copy current": gdmissions.app's Core Rules Data
// Changelog.
//
// Why this page and not a Wahapedia marker. The marker on Wahapedia's rules
// pages is a book table that read "June 2026" on 2026-10-28 while the page text
// already carried the 2026-10-14 rule changes: it dates the book, not the copy.
// gdmissions publishes one row per data version of the official app export -
// the same export the faction half and the missions are now built from (see
// docs/mfm-source.md) - so the number it lists is directly comparable with the
// dump's own metadata.data_version. One integer against one integer, no clocks.
//
// What is read. The page is a Next.js app, and the per-version details render
// in the browser; the server HTML carries only the version picker, one
// <option> per version:
//
//   <option value="995">Data version 995 · 16 Oct 2026 · 1 change</option>
//   ...
//   <option value="PDF">The Core Rules PDF · 18 Jun 2026 · 5 notes</option>
//
// That list is the whole contract: the latest version, its date, and how many
// Core Rules changes each version made. A page with no such options is an
// error, never "current" - a layout change must not read as "nothing to do".

export const GDM_CHANGELOG_URL = 'https://gdmissions.app/11th/rules/changelog';
export const GDM_VERSION_HISTORY_URL = 'https://gdmissions.app/version-history';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function decode(s) {
  return String(s)
    .replace(/&middot;|&#183;|&#xb7;/gi, '·')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// '16 Oct 2026' -> '2026-10-16'; '' when the date does not read as one.
export function isoDate(text) {
  const m = String(text || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return '';
  return m[3] + '-' + String(MONTHS[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0');
}

// -> { latest, versions: [{ version, date, iso, changes }] newest first, baseline }
export function parseGdmChangelog(html) {
  const seen = new Map();
  let baseline = null;
  const re = /<option\b[^>]*\bvalue="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const value = m[1].trim();
    const label = decode(m[2]);
    const parts = label.split('·').map(s => s.trim());
    if (/^\d+$/.test(value)) {
      const head = (parts[0] || '').match(/data version\s+(\d+)/i);
      if (!head || head[1] !== value) continue;
      const changes = ((parts[2] || '').match(/(\d+)\s+change/i) || [])[1];
      seen.set(Number(value), {
        version: Number(value),
        date: parts[1] || '',
        iso: isoDate(parts[1]),
        changes: changes === undefined ? null : Number(changes),
      });
    } else if (/pdf/i.test(value)) {
      baseline = { label: parts[0] || '', date: parts[1] || '', iso: isoDate(parts[1]), notes: Number(((parts[2] || '').match(/(\d+)/) || [])[1] || 0) };
    }
  }
  const versions = Array.from(seen.values()).sort((a, b) => b.version - a.version);
  if (!versions.length) throw new Error('gdmissions changelog: no data versions on the page (has the layout changed?)');
  return { latest: versions[0].version, versions, baseline };
}

// Our dump's version against the changelog.
//   current  - same number
//   behind   - gdmissions lists newer versions; `missed` names them
//   ahead    - our dump is newer than the changelog (gdmissions has not caught up)
//   unknown  - we have no version stamp at all (the CSV rollback, or no dump)
export function compareDataVersion(ours, parsed) {
  const n = Number(String(ours || '').trim());
  const latest = parsed && parsed.latest;
  if (!String(ours || '').trim() || !Number.isFinite(n)) return { state: 'unknown', ours: '', latest, missed: [], changes: 0 };
  if (n === latest) return { state: 'current', ours: n, latest, missed: [], changes: 0 };
  if (n > latest) return { state: 'ahead', ours: n, latest, missed: [], changes: 0 };
  const missed = parsed.versions.filter(v => v.version > n);
  return { state: 'behind', ours: n, latest, missed, changes: missed.reduce((s, v) => s + (v.changes || 0), 0) };
}

// The live read. `fetchText` is injectable so the tests never touch the network.
export async function fetchGdmChangelog(options) {
  const opts = options || {};
  const url = opts.url || GDM_CHANGELOG_URL;
  const fetchText = opts.fetchText || (async u => {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mhq-rules/1)' }, signal: AbortSignal.timeout(opts.timeoutMs || 30000) });
    if (!r.ok) throw new Error('gdmissions changelog: HTTP ' + r.status);
    return r.text();
  });
  return parseGdmChangelog(await fetchText(url));
}

// One line for --check and --update.
export function describeCanon(cmp) {
  if (cmp.state === 'current') return 'current  (dump v' + cmp.ours + ' is the latest data version)';
  if (cmp.state === 'ahead') return 'ahead    (dump v' + cmp.ours + ', changelog lists v' + cmp.latest + ' - gdmissions has not caught up)';
  if (cmp.state === 'unknown') return 'unknown  (no dump version on disk - the faction half is not built from the MFM dump)';
  const list = cmp.missed.map(v => 'v' + v.version + ' ' + (v.iso || v.date) + ' (' + (v.changes === null ? '?' : v.changes) + ')').join(', ');
  return 'BEHIND   (dump v' + cmp.ours + ', latest v' + cmp.latest + '; missed ' + list + ' - ' + cmp.changes + ' Core Rules change(s))';
}
