#!/usr/bin/env node
'use strict';
/**
 * verify-points.mjs - check every unit row of a parsed event against the
 * official points tables (the Munitorum Field Manual, mfm.warhammer-community.com).
 *
 *   node verify-points.mjs <event.json> [--ref-dir .verify-ref] [--lang both|en|fr]
 *                          [--rows <file>] [--report <file>] [--no-scrape] [--quiet]
 *
 * Input: a JSON in the shape parse.mjs/parseHtml write - { event, count, players[] },
 * each player holding units[] with model / points / models / enhancements. This is
 * the file the UI's "Download JSON" button writes, so "verify the JSON I just
 * downloaded" is the whole story.
 *
 * Reference: the MFM renders per faction (imperial-knights, necrons, space-marines,
 * ...). The page is server-shipped but client-rendered with lazy sections, and the
 * /fr render shows rows the /en render hides, so the tool drives a real browser
 * (playwright-cli, if installed) and caches each faction page under --ref-dir,
 * /en first then /fr when a datasheet has no priced row in English.
 *
 * Verification, per row:
 *   1. Datasheet matched into the faction's page: exact, then relaxed
 *      (prefix containment, both directions), then translated aliases.
 *   2. Printed points must be a MFM tier price. Copy brackets (first-second
 *      vs 3rd+ unit) are picked by the copy index when the datasheet lists
 *      two brackets; single-bracket datasheets use it always.
 *   3. On a miss, the delta is checked against the row's own enhancement
 *      (the app and newrecruit exports fold its price into the figure),
 *      then against sums of the row's MFM wargear options - MIXED sums
 *      included: 210 + 15 psycannon + 15 sublimator + 10 enhancement = 250
 *      is the shape that first made this check mandatory.
 *   4. What survives all of that is a row worth a human: stale figure
 *      (a recent +/-N update the roster missed), a player mistake, or a
 *      datasheet the MFM does not list at all.
 *
 * Output: a per-row ledger (--rows, default <event>.verify-rows.json) and a
 * markdown report (--report, default <event>.verify.md). Exit code: 0 when
 * every row verified, 1 when rows remain for a manual look, 2 on usage errors.
 *
 * Programmatic: import { verifyEvent, parseMfmPage, scrapeRef } - see the
 * exports at the bottom and tests/test-verify-points.mjs for the pinned shapes.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

// ============================================================
// MFM page -> price table
// ============================================================
// The rendered page is one innerText stream per unit:
//
//   LOKHUST DESTROYERS          <- unit name (all caps)
//   [triangle marker]           <- optional: the unit changed recently
//   YOUR 1ST TO 2ND UNITS COST  <- bracket header (copy band)
//   6 models | 190 pts          <- size/price pairs; a pair's price may
//   [triangle] 6 models 220 pts <- carry the update arrow inline
//   YOUR 3RD + UNIT COSTS
//   ...
//   WARGEAR OPTIONS             <- per-option prices, attached to the unit above
//   per Gauss cannon | 5 pts
//   LEADER                      <- role labels + the units they can join:
//   IMMORTALS, NECRON WARRIORS     these are NOT units and never name one
//
// French pages use VOTRE UNIT/E COST lines and "N figurines" size lines; the
// matcher below is written once for both.
// Three shapes, en and fr:
//   YOUR UNIT COSTS              (single copy band)
//   YOUR 1ST TO 2ND UNITS COST   (copy band, en)   VOTRE UNITE COUTE (fr)
//   YOUR 4TH + UNIT COSTS / 3RD +
//   DE LA 1RE A LA 2E, VOS UNITES COUTENT (fr copy band)
const BR_PLAIN = /(?:VOTRE|YOUR)\s+UNIT\u00c9?S?\s+(?:CO\u00dbTES?|COSTS?)/i;
const BR_COPY = /(?:VOTRE|YOUR)\s+(?:[1-9](?:ST|ND|RD|TH)(?:\s+TO\s+[1-9](?:ST|ND|RD|TH))?(?:\s*\+)?|\+|[1-9](?:RE|E)(?:\s*\+)?)\s+UNIT\u00c9?S?\s+(?:CO\u00dbTES?|COSTS?)/i;
const BR_FR_VOS = /VOS\s+UNIT\u00c9S\s+CO\u00dbTENT/i;
const isBracketHeader = L => BR_PLAIN.test(L) || BR_COPY.test(L) || BR_FR_VOS.test(L);
const PRICE_RE = /^(?:[▲▼] \([+-]\d+\) )?(\d[\d\s,.']*) pts$/i;
const ARROW_RE = /^[▲▼]$/;
const ROLE_RE = /^(?:LEADER|SUPPORT|TRANSPORT|MENEUR|APPUI|SUPPORT LOGISTIQUE)$/i;
// The last alternative is the fr form "N <datasheet name>" - it can carry
// spaces ("3 Preneurs de Tetes Gardes Loups"), so anything but a price or
// an arrow counts; the pair only becomes one when a price line follows.
const SIZE_RE = /^(\d+) (?:models?|figurines?|[A-Za-z][^\n]*)$/;

function parseMfmPage(text) {
  const lines = text.split('\n').map(l => l.trim());
  const units = [];
  let cur = null, lastName = null, skipList = 0, inWargear = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    // A role label introduces exactly one list line; the unit that follows is
    // real, so the label may not become one and the list must not eat it.
    if (ROLE_RE.test(L)) { skipList = 1; inWargear = false; continue; }
    if (skipList > 0) { skipList = 0; continue; }
    if (/^WARGEAR OPTIONS$/i.test(L) || /^OPTIONS D'\u00c9QUIPEMENT$/i.test(L)) { inWargear = true; continue; }
    if (inWargear && cur) {
      const per = L.match(/^per (.+)$/i);
      if (per) {
        const priceL = lines[i + 1] || '';
        const pm = priceL.match(/^(\d+) pts$/i);
        if (pm) { cur.wargear.push({ per: per[1], pts: +pm[1] }); i++; continue; }
      }
    }
    if (isBracketHeader(L)) {
      inWargear = false;
      if (!cur) { cur = { name: lastName, brackets: [], wargear: [] }; units.push(cur); lastName = null; }
      cur.brackets.push({ label: L, sizes: [] });
      continue;
    }
    if (cur) {
      const sizeM = L.match(SIZE_RE);
      if (sizeM) {
        const priceL = lines[i + 1] || '';
        const pm = priceL.match(PRICE_RE);
        if (pm) {
          const dm = priceL.match(/^([\u25b2\u25bc]) \(([+-]\d+)\) /);
          cur.brackets[cur.brackets.length - 1].sizes.push({
            n: +sizeM[1],
            pts: parseInt(pm[1].replace(/[^\d]/g, ''), 10),
            delta: dm ? +dm[2] : null, // the printed +/-N of the recent update
          });
          i++;
          continue;
        }
      }
      cur = null; inWargear = false; // any non-structural line closes the unit
    }
    if (L && !ARROW_RE.test(L) && !PRICE_RE.test(L) && !/^\d+ /.test(L) &&
        !/^(?:FACTIONS|UNITS|SHOW LEGENDS|MUSTER ARMIES|WE USE COOKIES|ENHANCEMENTS|DETACHMENTS|ACCEPT COOKIES)/i.test(L)) lastName = L;
  }
  return units.filter(u => u.name && u.brackets.length);
}

// Enhancement prices per page: "ENHANCEMENTS" then name/price pairs, tolerating
// arrow-marked prices and the "(Upgrade)" suffixes (stripped before keying, or
// "Deepening Madness (Upgrade)" would never match a row's plain name).
function parseEnhancements(text) {
  const out = {};
  const lines = text.split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    // en: ENHANCEMENTS. fr: OPTIMISATIONS (the French render also labels
    // every enhancement "(Amelioration)").
    if (!/^(?:ENHANCEMENTS|OPTIMISATIONS)$/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      const name = lines[j];
      if (/^\d+ pts$/.test(name) || /^[\u25b2\u25bc]/.test(name) ||
          /^(?:ENHANCEMENTS|DETACHMENTS|[A-Z]{2,}\s*[0-9]*DP)/i.test(name)) break;
      const priceL = lines[j + 1] || '';
      const pm = priceL.match(/^(?:[\u25b2\u25bc] \([+-]\d+\) )?(\d+) pts$/);
      if (pm) {
        const key = name.replace(/\([^)]*\)/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (key && out[key] == null) out[key] = +pm[1];
        j++;
      }
    }
  }
  return out;
}

// ============================================================
// Scraping the reference pages
// ============================================================
// playwright-cli keeps a real Chromium session; the page's innerText is read
// after a settle delay because the units list renders in two waves. The whole
// reference fits in one capture per page - the site does not virtualize on
// scroll - so one open + one read per faction is all it costs.
function scrapeRef(slug, lang) {
  const base = 'https://mfm.warhammer-community.com/' + (lang || 'en');
  // shell: true - on Windows playwright-cli is an npm .cmd shim, which
  // spawnSync cannot exec without a shell. The arguments are fixed strings,
  // so the shell adds no surface.
  // One string, not argv: execFileSync with a shell on Windows warns
  // (DEP0190) when args are passed beside shell: true.
  execFileSync('playwright-cli open ' + base + '/' + slug, { stdio: 'pipe', shell: process.platform === 'win32' });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  return wait(3500).then(async () => {
    const out = execFileSync('playwright-cli eval "document.body.innerText"', { stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' });
    const m = out.match(/### Result\r?\n("(?:[^"\\]|\\.)*")/);
    if (!m) throw new Error('mfm scrape failed for ' + (lang || 'en') + '/' + slug + ': no page text (is playwright-cli installed?)');
    return JSON.parse(m[1]);
  });
}

// The faction page each player's army is read from: the roster's own faction
// plus, where lists regularly ally, the pages those allies live on.
const FACTION_PAGES = {
  'Aeldari - Drukhari': ['aeldari', 'drukhari'], 'Aeldari': ['aeldari'], 'Drukhari': ['drukhari'],
  'Imperium - Imperial Knights': ['imperial-knights', 'adepta-sororitas', 'deathwatch'],
  "Chaos - Emperor's Children": ['emperors-children', 'chaos-space-marines'],
  'Imperium - Adeptus Astartes - White Scars': ['space-marines'],
  'Imperium - Adeptus Astartes': ['space-marines'],
  'Imperium - Adeptus Astartes - Space Wolves': ['space-wolves', 'space-marines'],
  'Imperium - Adeptus Astartes - Dark Angels': ['dark-angels', 'space-marines'],
  'Imperium - Adeptus Astartes - Blood Angels': ['space-marines'],
  'Imperium - Adeptus Astartes - Black Templars': ['space-marines'],
  'Necrons': ['necrons'],
  'Imperium - Astra Militarum': ['astra-militarum'],
  'Chaos - Chaos Knights': ['chaos-knights', 'chaos-daemons'],
  'Chaos - World Eaters': ['world-eaters', 'chaos-space-marines', 'chaos-daemons'],
  'Chaos - Chaos Space Marines': ['chaos-space-marines', 'chaos-daemons'],
  'Orks': ['orks'],
  'Chaos - Death Guard': ['death-guard', 'chaos-space-marines', 'chaos-knights', 'chaos-daemons'],
  'Imperium - Grey Knights': ['grey-knights', 'deathwatch'],
  'Chaos - Thousand Sons': ['thousand-sons', 'chaos-space-marines'],
  'Tyranids': ['tyranids'],
  "T'au Empire": ['tau-empire'],
  'Imperium - Adeptus Custodes': ['adeptus-custodes'],
  // The bare chapter names, for events whose faction field is spelled
  // without the Imperium/Chaos prefix.
  'Grey Knights': ['grey-knights', 'deathwatch'],
  'Space Wolves': ['space-wolves', 'space-marines'],
  'Dark Angels': ['dark-angels', 'space-marines'],
  'Space Marines': ['space-marines'],
  'White Scars': ['space-marines'],
  'Blood Angels': ['space-marines'],
  'Black Templars': ['space-marines'],
  'Death Guard': ['death-guard', 'chaos-space-marines', 'chaos-knights', 'chaos-daemons'],
  'World Eaters': ['world-eaters', 'chaos-space-marines', 'chaos-daemons'],
  "Emperor's Children": ['emperors-children', 'chaos-space-marines'],
  'Thousand Sons': ['thousand-sons', 'chaos-space-marines'],
  'Chaos Knights': ['chaos-knights', 'chaos-daemons'],
  'Chaos Space Marines': ['chaos-space-marines', 'chaos-daemons'],
  'Adeptus Custodes': ['adeptus-custodes'],
  'Astra Militarum': ['astra-militarum'],
  'Imperial Knights': ['imperial-knights', 'adepta-sororitas', 'deathwatch'],
  "T'au Empire": ['tau-empire'],
  'Tyranids': ['tyranids'],
};

// Roster names the pages spell differently. The /fr index makes this list
// small: French rosters match the French pages natively.
const ALIAS = {
  // Datasheet names that differ from the page's own spelling. Keys and values
  // are in norm() form. The /fr render prices some datasheets the /en render
  // shows as a bare reference; a name's French spelling bridges those.
  'IMPERIALRHINO': 'RHINO',            // the grey-knights list calls the SM rhino this
  'SISTERSOFBATTLESQUAD': 'BATTLESISTERSSQUAD',
  'WOLFGUARDHEADTAKERS': 'PRENEURSDETTESGARDESLOUPS',
};

// Names that exist on the site but render as references rather than priced
// rows on the pages reachable in either language. Reported as their own kind
// of row so the report says "unverifiable" instead of implying an error.
const NO_MFM_ROW = new Set(['DRAGONKNIGHTS', 'DRAGONKNIGHT']);

const norm = s => String(s || '').toUpperCase().replace(/[\u2019']/g, '').replace(/[^A-Z0-9]/g, '');

// ============================================================
// Verification
// ============================================================
function tierList(hit) {
  const out = [];
  for (const b of hit.brackets || []) for (const s of b.sizes) out.push({ pts: s.pts, n: s.n, bracket: b.label });
  return out;
}

// Every price a unit can reach: a tier, that tier plus the folded enhancement,
// plus any sum of wargear options - single values k*x AND mixed combos, since
// 210 + 15 + 15 + 10 was exactly what the first corpus mismatch needed.
function reachablePrices(hit, enhPts) {
  const tiers = tierList(hit);
  const wg = (hit.wargear || []).map(w => w.pts).filter(v => v > 0);
  // subset sums of wargear options, each usable more than once, capped: a
  // real unit never takes more than 12 of one option
  let sums = new Set([0]);
  let frontier = new Set([0]);
  for (let step = 0; step < 12; step++) {
    const next = new Set();
    for (const s of frontier) for (const w of wg) if (!sums.has(s + w) && s + w <= 600) { next.add(s + w); sums.add(s + w); }
    if (!next.size) break;
    frontier = next;
  }
  const combos = [];
  for (const t of tiers) {
    for (const s of sums) {
      for (const e of (enhPts != null ? [0, enhPts] : [0])) {
        combos.push({ pts: t.pts + s + e, tier: t, wg: s, enh: e || null });
      }
    }
  }
  return { tiers, combos };
}

// Union of tiers the datasheet's rows price, across the faction's pages:
// used for the CHECK row's nearest-tier note.
function matchTiers(...hits) {
  const seen = new Map();
  for (const h of hits.filter(Boolean)) {
    for (const c of reachablePrices(h, null).combos) {
      const key = c.tier.pts + '/' + c.tier.n;
      if (!seen.has(key)) seen.set(key, c);
    }
  }
  return [...seen.values()];
}

function pickBracket(hit, nth) {
  const brs = (hit.brackets || []).filter(b => b.sizes.length);
  if (!brs.length) return null;
  // Two brackets = copy-sensitive pricing; the first two copies pay the first.
  return brs.length > 1 ? (nth <= 2 ? brs[0] : brs[1]) : brs[0];
}

// One event, one reference cache. Event: { players: [{ name, teamName, faction, units }] }.
function verifyEvent(event, ref, { quiet = false } = {}) {
  const idx = {};
  for (const [pg, arr] of Object.entries(ref.tables)) {
    idx[pg] = {};
    for (const u of arr) { const k = norm(u.name); if (k && !idx[pg][k]) idx[pg][k] = u; }
  }
  // en first, then the fr page of the same faction when one exists - a
  // datasheet may be priced in only one render.
  function pagesFor(faction) {
    const pages = [];
    for (const pg of FACTION_PAGES[faction] || []) {
      if (idx[pg]) pages.push(pg);
      if (idx[pg + '@fr']) pages.push(pg + '@fr');
    }
    return pages;
  }
  function lookup(faction, ds) {
    let n = norm(ds).replace(/^\d+/, ''); // "20 Boyz" / "10 Gretchin" exports
    if (!n || /^\d+$/.test(n)) return null;
    if (ALIAS[n]) n = ALIAS[n];
    const pages = pagesFor(faction);
    for (const pg of pages) {
      if (idx[pg] && idx[pg][n]) return { pg, hit: idx[pg][n], key: n, lang: pg.endsWith('@fr') ? 'fr' : 'en' };
    }
    for (const pg of pages) {
      for (const [k, v] of Object.entries(idx[pg] || {})) {
        if (k.length > 4 && n.length > 4 && (k.startsWith(n) || n.startsWith(k))) return { pg, hit: v, lang: pg.endsWith('@fr') ? 'fr' : 'en', relaxed: true };
      }
    }
    if (NO_MFM_ROW.has(n)) return { pg: null, hit: null, noRow: true };
    return null;
  }
  function enhPriceOf(u, pages) {
    const m = String(u.enhancements || u.enh || '').match(/:\s*(.+)$/);
    if (!m) return null;
    const k = norm(m[1].replace(/\([^)]*\)/g, ''));
    const name = m[1].replace(/\([^)]*\)/g, '').trim();
    // The faction's own pages first (en then fr), then every other cached
    // page: an enhancement whose detachment belongs to a chapter page the
    // render does not carry is still priced somewhere, and a wrong global
    // match cannot lie - the combination still has to reproduce the row's
    // printed figure to count.
    for (const pg of pages) {
      const v = ref.enh[pg] && ref.enh[pg][k];
      if (v != null) return { pts: v, name };
    }
    for (const [pg, map] of Object.entries(ref.enh)) {
      if (map[k] != null) return { pts: map[k], name, global: pg };
    }
    return null;
  }

  const rows = [];
  for (const p of event.players || []) {
    const copies = {};
    for (const u of p.units || []) {
      // Strike Force / Force de Frappe banners are not units, and neither
      // is anything declaring Detachment Points ("Cursed Legion ... (3
      // Detachment Points)") - the repo's isUnitDeclLine has the same rule.
      if (!u.points || u.points >= 1000 || /^(?:Strike Force|Force de Frappe|Force of|DA Recon)/i.test(u.model || '') ||
          /detachment\s+points?/i.test(u.model || '')) continue;
      // " (85 Points)" and " (2)" tails both come off; a roster may carry
      // either. Only digits or digits+points inside the parens count, so a
      // parenthesised enhancement note is untouched.
      let ds = String(u.model || '').trim().replace(/^\d+x\s+/i, '')
        .replace(/\s*\(\s*\d+(?:\s*(?:pts|points?))?\s*\)\s*$/i, '').trim();
      // A numeric-only model name ("20" from "20 Boyz (170 pts)") takes the
      // datasheet off the model line with the largest count.
      if (/^\d+$/.test(norm(ds)) && (u.models || []).length) {
        const best = u.models.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0];
        ds = String(best.name).replace(/^\d+x\s+/i, '').trim();
      }
      let size = 1;
      if ((u.models || []).length) {
        const byName = {};
        for (const m of u.models) byName[norm(m.name)] = (byName[norm(m.name)] || 0) + (m.count || 1);
        size = Math.max(...Object.values(byName));
      } else {
        const cm = String(u.model || '').match(/^(\d+)\s+[A-Za-z]/) || String(u.model || '').match(/\((\d+)\)\s*$/);
        if (cm) size = +cm[1];
      }
      const nth = (copies[norm(ds)] = (copies[norm(ds)] || 0) + 1);
      const row = { player: p.name, team: p.teamName || null, faction: p.faction || null, ds, size, nth, pts: u.points, enhancements: u.enhancements || null, equipment: u.equipment || null };
      const hit = lookup(p.faction, ds);
      if (!hit) { row.status = 'unmatched'; rows.push(row); continue; }
      row.refPage = hit.pg;
      if (hit.noRow) { row.status = 'no-mfm-row'; row.note = 'the MFM lists this datasheet as a reference only; not verifiable'; rows.push(row); continue; }
      // One match pass: a plain tier first (find order puts no-wg/no-enh
      // combos ahead of folded ones), then tier + enhancement and/or wargear.
      // The wargear-only fold needs no enhancement on the row: Defiler 330 =
      // 300 + 15 + 15 carries none, and the first draft of this branch hid
      // every such row behind a null enhancement.
      //
      // The two language renders differ in what they price: /fr sometimes
      // carries no wargear where /en does and vice versa, so on a miss the
      // same datasheet is retried on the faction's other page(s).
      const ep = enhPriceOf(u, pagesFor(p.faction));
      let match = null, matchHit = hit.hit, matchEp = ep;
      for (const cand of [[hit.hit, ep],
        ...pagesFor(p.faction).filter(pg => pg !== hit.pg && idx[pg][hit.key] && idx[pg][hit.key] !== hit.hit)
          .map(pg => [idx[pg][hit.key], null]),
        // ...and the same datasheet by ORDER in the sibling language's table:
        // the two renders list the same datasheets in the same order, and one
        // language may price wargear the other leaves off. Only when the two
        // tables have the same length - a length mismatch would align wrong.
        ...(() => {
          const sibPg = hit.pg.endsWith('@fr') ? hit.pg.slice(0, -3) : hit.pg + '@fr';
          const own = ref.tables[hit.pg], sib = ref.tables[sibPg];
          if (!sib || sib.length !== own.length) return [];
          const at = own.indexOf(hit.hit);
          return at >= 0 && sib[at] && sib[at] !== hit.hit ? [[sib[at], null]] : [];
        })()]) {
        const [h, e] = cand;
        const { combos } = reachablePrices(h, e ? e.pts : null);
        // A plain tier outranks a folded combo: a 220-pt row that is BOTH a
        // 3rd+ bracket price and a folded 190+30 must attribute to the tier,
        // not to the fold that happens to iterate first.
        const m = combos.find(c => c.pts === u.points && !c.wg && !c.enh) ||
          combos.find(c => c.pts === u.points);
        if (m) { match = m; matchHit = h; matchEp = e; break; }
      }
      if (match) {
        row.status = 'ok';
        row.tier = match.tier.n;
        row.bracket = match.tier.bracket;
        const why = [];
        if (match.enh) why.push((matchEp ? matchEp.name : 'enhancement') + ' +' + match.enh);
        if (match.wg) why.push('wargear +' + match.wg);
        if (why.length) row.note = 'verified: ' + match.tier.pts + ' + ' + why.join(' + ');
        rows.push(row);
        continue;
      }
      const br = pickBracket(hit.hit, nth);
      const sizes = br ? br.sizes.slice().sort((a, b) => a.n - b.n) : [];
      const nearest = matchTiers(hit.hit, pagesFor(p.faction), idx[hit.pg][hit.key]).map(c => c.tier)
        .filter((t, i, a) => a.findIndex(x => x.pts === t.pts && x.n === t.n) === i)
        .sort((a, b) => Math.abs(u.points - a.pts) - Math.abs(u.points - b.pts))[0];
      row.status = 'CHECK';
      row.mfmTier = nearest ? nearest.n : null;
      row.mfmPts = nearest ? nearest.pts : null;
      row.delta = nearest ? u.points - nearest.pts : null;
      // The report line already carries the nearest tier; the note only
      // adds what the reader could not see - the declared enhancement that
      // was tried and did not fit.
      row.note = ep ? 'its declared enhancement ' + ep.name + ' (+' + ep.pts + ') does not explain the figure' : null;
      rows.push(row);
    }
  }
  return rows;
}

function summarize(rows) {
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const verified = (counts.ok || 0);
  return { counts, verified, total: rows.length, manual: rows.filter(r => r.status !== 'ok') };
}

// ============================================================
// Reference cache
// ============================================================
// <ref-dir>/<lang>@<slug>.txt per page. The "@lang" marker keeps the two
// languages in one index; the fr page is only fetched for a datasheet that
// has no English priced row, because every /fr page is one more browser
// round-trip.
function loadRef(refDir, factionSlugs, { lang = 'both', noScrape = false } = {}) {
  const tables = {}, enh = {}, langs = lang === 'both' ? ['en', 'fr'] : [lang];
  const missing = [];
  for (const pg of factionSlugs) {
    for (const l of langs) {
      const key = l === 'en' ? pg : pg + '@fr';
      const f = path.join(refDir, key + '.txt');
      if (fs.existsSync(f) && fs.statSync(f).size > 500) {
        const text = fs.readFileSync(f, 'utf8');
        tables[key] = parseMfmPage(text);
        enh[key] = parseEnhancements(text);
      } else {
        missing.push(key);
      }
    }
  }
  return { tables, enh, missing };
}

async function ensureRef(refDir, factionSlugs, opts) {
  fs.mkdirSync(refDir, { recursive: true });
  let ref = loadRef(refDir, factionSlugs, opts);
  if (opts.noScrape) return { ref, scraped: [] };
  const scraped = [];
  for (const key of ref.missing) {
    const [slug, frTag] = key.split('@');
    const lang = frTag ? 'fr' : 'en';
    const text = await scrapeRef(slug, lang);
    fs.writeFileSync(path.join(refDir, key + '.txt'), text);
    scraped.push(key);
    // re-read everything: cheap, keeps the cache coherent
    ref = loadRef(refDir, factionSlugs, opts);
  }
  return { ref, scraped };
}

// The reference slugs an event needs: the union of every faction's pages.
function slugsFor(event) {
  const out = new Set();
  for (const p of event.players || []) {
    for (const pg of FACTION_PAGES[p.faction || ''] || []) out.add(pg);
    if (!p.faction || !(FACTION_PAGES[p.faction || ''] || []).length) {
      // Unknown faction: try a slug from the faction text itself, and warn in
      // the report rather than silently skipping the player.
      out.add('UNKNOWN:' + (p.faction || '(no faction)'));
    }
  }
  return [...out].filter(s => !s.startsWith('UNKNOWN:'));
}

// ============================================================
// CLI
// ============================================================
function parseArgs(argv) {
  const a = { event: null, refDir: null, lang: 'both', rows: null, report: null, noScrape: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ref-dir') a.refDir = argv[++i];
    else if (arg.startsWith('--ref-dir=')) a.refDir = arg.slice('--ref-dir='.length);
    else if (arg === '--lang') a.lang = argv[++i];
    else if (arg.startsWith('--lang=')) a.lang = arg.slice('--lang='.length);
    else if (arg === '--rows') a.rows = argv[++i];
    else if (arg === '--report') a.report = argv[++i];
    else if (arg === '--no-scrape') a.noScrape = true;
    else if (arg === '--quiet') a.quiet = true;
    else if (!arg.startsWith('--') && !a.event) a.event = arg;
    else throw new Error('unexpected argument: ' + arg);
  }
  if (!a.event) {
    throw new Error('provide the event JSON (as parse.mjs / Download JSON write it)\n' +
      '  Usage: node verify-points.mjs <event.json> [--ref-dir <dir>] [--lang both|en|fr] [--rows <file>] [--report <file>] [--no-scrape]');
  }
  if (!['both', 'en', 'fr'].includes(a.lang)) throw new Error('--lang must be both, en or fr');
  if (!a.refDir) a.refDir = path.join(path.dirname(path.resolve(a.event)), '.verify-ref');
  return a;
}

function renderReport(event, rows) {
  const s = summarize(rows);
  const byPlayer = {};
  for (const r of rows.filter(r => r.status !== 'ok')) {
    (byPlayer[r.player] = byPlayer[r.player] || { team: r.team, rows: [] }).rows.push(r);
  }
  let md = '# Points verification — ' + (event.event ? event.event.name : (event.name || 'event')) + '\n\n';
  md += 'Reference: https://mfm.warhammer-community.com/en (cross-checked against fr/…), Munitorum Field Manual.\n\n';
  md += `## Result: **${s.verified} of ${s.total} rows verified** — ${rows.filter(r => r.status === 'ok' && r.note).length} verified with a folded cost · **${s.manual.length} need a look**\n\n`;
  md += 'Statuses: ok = a MFM tier price (optionally + the unit\'s own enhancement and/or its wargear options, all priced from the MFM); CHECK = no MFM arithmetic explains the figure; unmatched = the datasheet was not found on the faction pages; no-mfm-row = the MFM carries the name as a reference only.\n\n';
  md += '## Units to check manually\n\n';
  for (const [p, v] of Object.entries(byPlayer)) {
    md += `### ${p} [${v.team || '?'}]\n\n`;
    for (const r of v.rows) {
      md += `- **${r.ds}** x${r.size} — declared ${r.pts} pts`;
      md += r.status === 'CHECK' && r.mfmPts != null ? `, nearest MFM tier: ${r.mfmTier} model(s) = ${r.mfmPts} pts (Δ${r.delta > 0 ? '+' : ''}${r.delta})` : '';
      md += r.enhancements ? `; declares: ${r.enhancements}` : '';
      md += r.note ? `
  - ${r.note}` : '';
      md += '\n';
    }
  }
  return md;
}

async function main(argv) {
  const a = parseArgs(argv);
  const event = JSON.parse(fs.readFileSync(a.event, 'utf8'));
  const slugs = slugsFor(event);
  const { ref, scraped } = await ensureRef(a.refDir, slugs, a);
  if (!a.quiet && scraped.length) console.error('scraped ' + scraped.length + ' reference page(s): ' + scraped.join(', '));
  const rows = verifyEvent(event, ref);
  const s = summarize(rows);
  const rowsPath = a.rows || a.event.replace(/\.json$/, '') + '.verify-rows.json';
  fs.writeFileSync(rowsPath, JSON.stringify(rows, null, 1));
  const reportPath = a.report || a.event.replace(/\.json$/, '') + '.verify.md';
  fs.writeFileSync(reportPath, renderReport(event, rows));
  if (!a.quiet) {
    console.log(`${s.verified}/${s.total} unit rows verified against the MFM.`);
    console.log(`${s.manual.length} row(s) need a manual look - details in ${reportPath}`);
    for (const r of s.manual) console.log('  ' + r.player + ': ' + r.ds + ' x' + r.size + ' = ' + r.pts + ' pts [' + r.status + ']');
  }
  return s.manual.length ? 1 : 0;
}

// IS_MAIN mirrors parse.mjs: tests import the functions, the CLI runs main.
const IS_MAIN = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; }
  catch { return false; }
})();

export { parseMfmPage, parseEnhancements, verifyEvent, summarize, renderReport, scrapeRef, loadRef, ensureRef, slugsFor, FACTION_PAGES, ALIAS, NO_MFM_ROW };

if (IS_MAIN) {
  main(process.argv.slice(2)).then(code => process.exitCode = code).catch(e => {
    console.error('Error: ' + (e && e.message || e));
    process.exitCode = 2;
  });
}
