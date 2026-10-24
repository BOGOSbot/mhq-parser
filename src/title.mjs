// src/title.mjs: what a record is called, in one place.
//
// Pure by contract: no fs, no corpus read, no DOM. Every function below takes the
// record (or its heading) it is given and returns a string. The three answers a caller
// can want are pageSlug() (the address a page lives at), rowLabel() (the name a tree or
// ledger row prints) and displayLabel() (the screen form of a name).
//
// This is a move, not a redesign: every formula is the one its caller had, copied
// verbatim, so a page, a row and a heading keep the same bytes. Where two callers
// disagreed the disagreement is named in the module and the caller keeps its own output;
// see the notes on cleanTitle() and shortLabel().

// The heading path. The corpus writes a record's ancestry as 'A > B > C'; the leaf is
// the record's own name. One split, no empty segments, segments left exactly as the
// source wrote them (a caller that wants them trimmed trims them: trimming here would
// change a few paths that no test covers and this slice may not change a rendered byte).
export function splitHeading(heading) {
  return String(heading == null ? '' : heading).split(' > ').filter(Boolean);
}

// The first segment, unfiltered: a few call sites look up a page outline by the head of
// the path and must keep the raw first element.
export function firstSegment(heading) {
  return String(heading == null ? '' : heading).split(' > ')[0];
}

// The leaf of a heading, or '' when there is none. Callers that fall back to the id
// keep that fallback themselves (it is a caller decision, not a naming one).
export function leafOf(heading) {
  const parts = splitHeading(heading);
  return parts.length ? parts[parts.length - 1] : '';
}

// A record split into parts carries ' (1/2)' in its name, and a unitrules twin carries
// ' - keywords and abilities', optionally followed by the part marker. Both are markers,
// not names.
export const PART_MARKER = /\s*\(\d+\/\d+\)$/;
export const KIND_SUFFIX = /\s*-\s*keywords and abilities(\s*\(\d+\/\d+\))?$/i;
// The client's shortName additionally drops ' - datasheet'. It is a display-only strip
// and only that caller does it, so it lives here as its own function, not inside
// cleanTitle (a page slug with it stripped would change every datasheet address).
export const DATASHEET_SUFFIX = /\s*-\s*datasheet$/i;

export function stripPartMarker(text) { return String(text == null ? '' : text).replace(PART_MARKER, ''); }
export function stripKindSuffix(text) { return String(text == null ? '' : text).replace(KIND_SUFFIX, ''); }
export function stripDatasheetSuffix(text) { return String(text == null ? '' : text).replace(DATASHEET_SUFFIX, ''); }

// The marker strip the page slug and the node names use: the part marker, then the
// unitrules kind suffix. It does not trim: the slug chain trims, and a caller that
// printed the raw result kept it that way. (search-core.mjs keeps its own one-line
// cleanMarker because web-bundle.mjs copies that file verbatim into the WebView and
// cannot follow a relative import; the two are the same two regexes in the same order.)
export function cleanTitle(text) {
  return stripKindSuffix(stripPartMarker(text));
}

// FNV-1a, 8 base-36 characters: the stable tail of a page address. Nobody else knows
// this function, so it lives with the slug (.html page names and index rows share it).
export function hash8(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// The readable part of a page address: '<kind>-<title>', lower case, ASCII, at most 60
// characters, never empty. An untitled record is named by its kind and the id hash, so
// this returns 'record' rather than ''. Verbatim from wiki-toc.mjs.
export function pageTitleSlug(record) {
  const r = record || {};
  const leaf = leafOf(r.heading);
  const slug = (String(r.kind || 'record') + '-' + cleanTitle(leaf))
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || 'record';
}

// The address a delivered record lives at: its book, the readable title, the id hash.
// The book is the caller's (the payload derives it from the tree); this function owns
// the rest of the shape, so the bake and any future caller cannot spell it twice.
export function pageSlug(record, book) {
  const r = record || {};
  return String(book || 'rules') + '--' + pageTitleSlug(r) + '-' + hash8(String(r.id == null ? '' : r.id));
}

// ALL-CAPS in the source is emphasis, not a name: a title that is entirely upper case is
// set in title case on screen. Data keeps the source; only the screen changes. Verbatim
// from the client's displayTitle.
export function displayTitle(text) {
  const s = String(text == null ? '' : text).replace(/^\[(.*)\]$/, '$1').trim();
  if (!s || !/[A-Z]/.test(s) || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-/(\u2019'])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// The display name of a row or a header: the client's shortName - drop the kind suffix
// and the datasheet suffix, then title-case ALL CAPS. The page slug must NOT use this:
// dropping ' - datasheet' would change every datasheet address, which is why the two
// strips are separate functions.
export function shortLabel(text) {
  return displayTitle(stripDatasheetSuffix(stripKindSuffix(text)));
}

// The name a retrieval row prints, and where its breadcrumb stops. A Q&A, errata or
// '[ONE SHOT]' record hangs under the rule it answers about, so its leaf is that rule's
// name and the record's own name is the question segment above it. The tell is local to
// the path: a question segment above the leaf, or a leaf that restates an earlier
// segment. Verbatim from the client's rowName (unit-card carried the same copy).
export function rowLabel(parts) {
  const list = (parts || []).map(p => String(p == null ? '' : p).trim());
  if (!list.length) return { name: '', at: -1 };
  const last = list.length - 1;
  for (let i = last - 1; i >= 0; i--) {
    if (/\?$/.test(list[i]) || /^q\s*:/i.test(list[i])) return { name: list[i], at: i };
  }
  const low = list[last].toLowerCase();
  for (let i = last - 1; i >= 0; i--) {
    if (list[i].toLowerCase() !== low) continue;
    for (let k = i - 1; k >= 0; k--) {
      if (list[k].toLowerCase() !== low) return { name: list[k], at: k };
    }
    break;
  }
  return { name: list[last], at: last };
}
