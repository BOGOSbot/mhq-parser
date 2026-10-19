#!/usr/bin/env node
'use strict';
/**
 * wargear-marks: the two marks the export leaves bare.
 *
 * Across all 7,758 rows of Datasheets_wargear.csv not one range cell carries an inch
 * mark and not one BS_WS cell carries a plus - the source writes 12, 3, Melee, N/A, -.
 * The game's own notation is a RENDER convention (task-34): the numbers stay as they
 * are in the corpus, and the reader sees 12" and 3+. Two callers: the card builder
 * (src/unit-card.mjs) marks the structured fields, and the flat passage text is
 * marked with markWargearText wherever a reader is shown it - a finding's excerpt,
 * the passage sheet, the record dialog's first paint and the flat record body.
 * 'Melee' is not a distance and 'N/A' / '-' mean the profile has none: those, and an
 * empty cell, are left exactly as the source wrote them. Both marks are idempotent.
 */
export function markRange(value, type) {
  const v = String(value == null ? '' : value).trim();
  return /^\d+$/.test(v) && String(type == null ? '' : type).trim().toLowerCase() === 'ranged' ? v + '"' : v;
}
export function markHit(value) {
  const v = String(value == null ? '' : value).trim();
  return /^\d+$/.test(v) ? v + '+' : v;
}
// The flat ingest text - 'Wargear Grabba Dragga (Ranged): Range 12 A 1 BS 2 S 10 AP -2 D 3'.
// Only a bare numeric after 'Range ' or after 'BS ' / 'WS ' is touched; a cell that
// already ends in its mark does not match again, so this is safe to apply twice.
export function markWargearText(text) {
  return String(text == null ? '' : text)
    .replace(/\bRange (\d+)(?![\d"])/g, 'Range $1"')
    .replace(/\b(BS|WS) (\d+)(?![\d+])/g, '$1 $2+');
}
export default { markRange, markHit, markWargearText };