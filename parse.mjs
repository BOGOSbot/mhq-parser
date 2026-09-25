#!/usr/bin/env node
'use strict';
/**
 * MHQ Army Lists Parser
 *
 * Fetches a MiniHeadQuarters army-lists page and extracts structured army
 * data as JSON + a compact one-line-per-unit "mini" view.
 *
 * Usage:
 *   node parse.mjs <army-lists-url> [--out-dir <dir>] [--json <name>] [--mini <name>]
 *
 * The URL must match: https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>
 * Default output dir: <event-slug>/ (relative to this script)
 * Default filenames:  mhq_army_lists.json, mhq_army_lists.mini.md
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ============================================================
// CLI wiring (skipped when this file is imported as a module)
// ============================================================
const URL_RE = /^https:\/\/miniheadquarters\.com\/tournaments\/(?:team|individual|2v2|side-by-side)\/army-lists\/.+/;

// True only when run as the main script: node parse.mjs <url> [options].
const IS_MAIN = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; }
  catch { return false; }
})();

let args = null;

// Parse + validate the CLI args. Throws on bad input; the caller prints it.
function parseArgs(argv) {
  const a = {
    url: null,
    outDir: null,
    jsonName: 'mhq_army_lists.json',
    miniName: 'mhq_army_lists.mini.md',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^https?:\/\//.test(arg)) a.url = arg;
    else if (arg === '--out-dir') a.outDir = argv[++i];
    else if (arg === '--json') a.jsonName = argv[++i];
    else if (arg === '--mini') a.miniName = argv[++i];
  }
  if (!a.url) {
    throw new Error('provide a link to an MHQ army list\n' +
      '  Usage: node parse.mjs <army-lists-url> [--out-dir <dir>] [--json <name>] [--mini <name>]\n' +
      '  Example: node parse.mjs https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>');
  }
  if (!URL_RE.test(a.url)) {
    throw new Error('provide a valid link\n' +
      '  Expected format: https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>\n' +
      '  Got: ' + a.url);
  }
  // Default output dir: <event-slug>/ relative to this script's directory.
  const slugMatch = a.url.match(/\/army-lists\/(.+)$/);
  const eventSlug = slugMatch ? slugMatch[1] : 'output';
  if (!a.outDir) a.outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), eventSlug);
  return a;
}

// ============================================================
// Fetch
// ============================================================
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, r => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => resolve({ status: r.statusCode, html: d }));
    }).on('error', reject);
  });
}

// ============================================================
// HTML decoding & article splitting
// ============================================================
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/g, ' ');
}

// The page nests <article> elements:
//   <article class="overflow-hidden ...">   <-- team card
//     <button><span>TeamName</span></button>
//     <div role="region">
//       <article class="rounded-2xl ...">   <-- player's army
//         <h2>PlayerName : Faction</h2>
//         <div>...list body...</div>
//       </article>
//     </div>
//   </article>
// Split on inner articles only, and look backwards for the enclosing
// outer card to grab the team name.
function splitArticles(html) {
  const articles = [];
  // Try team format first: inner <article class="rounded-2xl"> elements
  if (html.includes('<article class="rounded-2xl')) {
    let p = 0;
    while (true) {
      const a = html.indexOf('<article class="rounded-2xl', p);
      if (a === -1) break;
      const end = html.indexOf('</article>', a);
      if (end === -1) break;
      const articleHtml = html.substring(a, end + '</article>'.length);
      // Walk back to find the enclosing outer (team) card.
      let teamName = null;
      const back = html.substring(0, a);
      const outerIdx = back.lastIndexOf('<article class="overflow-hidden');
      if (outerIdx !== -1) {
        const outerChunk = back.substring(outerIdx, a);
        const btnM = outerChunk.match(/<button[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/);
        if (btnM) teamName = decodeEntities(btnM[1]).replace(/\s+/g, ' ').trim();
      }
      articles.push({ html: articleHtml, teamName });
      p = end + 1;
    }
  } else {
    // Individual format: outer <article class="overflow-hidden"> contains the player directly
    let p = 0;
    while (true) {
      const a = html.indexOf('<article class="overflow-hidden', p);
      if (a === -1) break;
      const end = html.indexOf('</article>', a);
      if (end === -1) break;
      const articleHtml = html.substring(a, end + '</article>'.length);
      // Extract player name from the button span
      const btnM = articleHtml.match(/<button[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/);
      const playerName = btnM ? decodeEntities(btnM[1]).replace(/\s+/g, ' ').trim() : null;
      articles.push({ html: articleHtml, playerName, teamName: null });
      p = end + 1;
    }
  }
  return articles;
}

function stripTags(s) {
  return decodeEntities(s.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\r/g, '');
}

// ============================================================
// Header parsing (+++ delimited key-value block)
// ============================================================
function findPlusBlock(lines) {
  const DELIM_RE = /^\s*\++\s*$/;
  const DELIM_MIN = 20;
  const isDelim = s => DELIM_RE.test(s) && s.trim().length >= DELIM_MIN;
  const isUnitContent = s => {
    const t = s.trim();
    return /\(\s*\d+\s*(?:pts?|points?)\s*\)/.test(t)
      || /\[\s*\d+\s*pts?\s*\]/.test(t)
      || /^Char\d+:/.test(t)
      || /^[.•◦]/.test(t)
      || /^\|/.test(t);
  };

  const delimIdx = lines.findIndex(isDelim);
  if (delimIdx !== -1) {
    // Delimiter found. Scan forward for a closing delimiter or unit-content break.
    let closeDelim = -1;
    let firstUnitIdx = -1;
    for (let i = delimIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (isDelim(lines[i])) { closeDelim = i; break; }
      if (/^\+/.test(t)) continue; // KEY lines are header content
      if (isUnitContent(lines[i])) { firstUnitIdx = i; break; }
    }
    if (closeDelim !== -1) {
      // Second delimiter: header is [delimIdx, closeDelim]
      return { openIdx: delimIdx, closeIdx: closeDelim };
    }
    if (firstUnitIdx !== -1) {
      // No closing delimiter but unit content found. If metadata lines (+ KEY) exist
      // before the delimiter, the header is [firstPlusLine, delimIdx]; otherwise
      // treat the delimiter as opening-only and the header extends to firstUnitIdx.
      const firstPlusLine = lines.findIndex(l => /^\+\s*[A-ZÉÈÀÂÇÛÖÜ]/i.test(l.trim()));
      if (firstPlusLine !== -1 && firstPlusLine < delimIdx) {
        return { openIdx: firstPlusLine, closeIdx: delimIdx };
      }
      return { openIdx: delimIdx, closeIdx: firstUnitIdx };
    }
    // Only one delimiter, no unit content after — it must be closing-only:
    // header is metadata before the delimiter.
    const firstPlusLine = lines.findIndex(l => /^\+\s*[A-ZÉÈÀÂÇÛÖÜ]/i.test(l.trim()));
    if (firstPlusLine !== -1 && firstPlusLine < delimIdx) {
      return { openIdx: firstPlusLine, closeIdx: delimIdx };
    }
    // No metadata before either — the single delimiter is opening-only
    return { openIdx: delimIdx, closeIdx: lines.length };
  }

  // No delimiter anywhere — look for a block of + KEY: VALUE lines.
  const firstPlusLine = lines.findIndex(l => /^\+\s*[A-ZÉÈÀÂÇÛÖÜ]/i.test(l.trim()));
  if (firstPlusLine === -1) return null;
  let closeIdx = -1;
  for (let i = firstPlusLine; i < lines.length; i++) {
    if (isDelim(lines[i])) { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  return { openIdx: firstPlusLine, closeIdx };
}

const HEADER_ALIAS = {
  'PLAYER NAME': 'playerName',
  'NOM DU JOUEUR': 'playerName',
  'TEAM NAME': 'teamName',
  "NOM DE L'ÉQUIPE": 'teamName',
  'FACTION KEYWORD': 'factionKeyword',
  'FACTIONS UTILISÉES': 'factionKeyword',
  'DETACHMENT': 'detachment',
  'DETACHMENT USED': 'detachment',
  'DETACHMENT RULES': 'detachment',
  'REGLE DE DETACHEMENT': 'detachment',
  'REGLES DE DETACHEMENT': 'detachment',
  'RÈGLE DE DÉTACHEMENT': 'detachment',
  'RÈGLES DE DÉTACHEMENT': 'detachment',
  'DISPOSITION': 'forceDisposition',
  'FORCE DISPOSITION': 'forceDisposition',
  'TOTAL ARMY POINTS': 'totalPoints',
  "POINTS D'ARMÉE": 'totalPoints',
  "TOTAL DE POINTS D'ARME": 'totalPoints',
  "TOTAL DE POINTS D'ARMÉE": 'totalPoints',
  'WARLORD': 'warlord',
  'SEIGNEUR DE GUERRE': 'warlord',
  'NUMBER OF UNITS': 'unitCount',
  "NOMBRE D'UNITÉS": 'unitCount',
  'SECONDARY': 'secondary',
  'ENHANCEMENT': 'enhancements',
  "AMÉLIORATIONS D'ARMÉE": 'enhancements',
};

function parseHeaderLines(lines) {
  const out = {};
  let lastKey = null;
  for (const raw of lines) {
    const line = raw.trim().replace(/^\+\s*/, '');
    if (!line) continue;
    // continuation: line starts with "& " (multi-tweak warlord)
    if (/^&\s+/i.test(line) && lastKey) {
      // Enhancements are a list: keep one per line. Other keys keep " & ".
      const sep = lastKey === 'enhancements' ? '\n' : ' & ';
      out[lastKey] = [out[lastKey], line.replace(/^&\s*/, '')].filter(Boolean).join(sep);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toUpperCase();
    const val = line.slice(colon + 1).trim();
    const mapped = HEADER_ALIAS[key] || key.replace(/\s+/g, '').toLowerCase();
    if (mapped === 'enhancements') {
      out.enhancements = [out.enhancements, val].filter(Boolean).join('\n');
    } else {
      out[mapped] = val;
    }
    lastKey = mapped;
  }
  return out;
}

// ============================================================
// newrecruit.eu format parser
// ============================================================
function parseNewRecruit(text) {
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  const units = [];
  let lastIdx = -1;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = raw.trim();
    if (/^(?:\(?\s*(?:Seigneur de Guerre|Warlord|Lord)\s*\)?\s*)$/i.test(line)) {
      if (lastIdx >= 0) units[lastIdx].isWarlord = true;
      continue;
    }
    if (/^[-–—|]*\s*---\s*(Optimisations?|Enhancements?)\s*:/i.test(line)) {
      const m = line.match(/^[-–—|]*\s*---\s*(?:Optimisations?|Enhancements?)\s*:\s*(.+)$/i);
      if (m && lastIdx >= 0) {
        units[lastIdx].enhancements = (units[lastIdx].enhancements ? units[lastIdx].enhancements + ', ' : '') + m[1];
      }
      continue;
    }
    const m = line.match(/^(.*?)\s+(\d+)?\s*:\s*(?:\[(\w+)\]\s*)?(?:([\d]+x\s+)?)(.+?)\s*\[\s*(\d+)\s*pts?\s*\]\s*(.*)$/i);
    if (m) {
      units.push({
        category: m[1].trim(),
        slot: m[2] ? +m[2] : null,
        role: m[3],
        attached: /^\|/.test(line),
        model: (m[5] || '').trim(),
        points: +m[6],
        equipment: m[7] ? m[7].split(',').map(s => s.trim()).filter(Boolean) : [],
      });
      lastIdx = units.length - 1;
    }
  }
  return units;
}

// ============================================================
// Bullet-style parser
// ============================================================
const CAT_HDR = /^(?:PERSONNAGES?|CHARACTERS?|CHARACTER|LIGNE|LINE|BATTLELINE|OTHER DATASHEETS|OTHERS?|OTHER|AUTRES FICHES TECHNIQUES|VEHICULES?|VEHICLES?|TERRAIN|INDUSTRIALS?|BUILDINGS?|UNIQUE|ATTACHED UNITS|UNITÉS? ATTACH|HÉROS? ÉPIQUES?|HEROICS? EPICS?|BÊTES?|BEASTS?|MONTÉS?|MONTEES?|MONTER?|MONTEES?|INFANTERIE|FOOT|ELECTROMECANIQUE|ELECTROMECHANICAL|TERRAIN|AUTRES? FICHES TECHNIQUES)/i;
const ATTACHED_RE = /^(?:UNIT|UNITÉS?)\s*(?:ATTACHED|ATTACHÉ(?:E)?S?)\s*\d*|(?:ATTACHED|ATTACHÉ)\s+UNIT|UNIT\s+\d+\s+ATTACHED|UNITÉ\s+\d+\s+ATTACHÉ|UNITÉ\s+ATTACHÉ(?:E)?\s*\d*/i;
const ENHANCEMENT_RE = /^(?:Enhancement|Optimisation|Aggressive Deployment|Murderous Onslaught|Unleash Hell|Fade to Darkness|Sorrowsyphon|Rejuvenating Swarm|Murdermind|Psychic Celerity|Admonimortis|Fierce Conqueror|Lien dermique|Voile des Ténèbres|Deepening Madness|Mark of the Nekrosor|Lame Rapace|Tueuse Acculeuse|Leaping Shadows|Gene-tailored Toxins|Supa-snazz Dakka|Dreadherder|Targetin' Gizmos|Recon Hunter|Nightforged Battery|Intoxicating Elixir|Intoxicating|Intoxicating)/i;

function parseBullets(text) {
  // Some players put the unit name on one line and "(N pts)" on the next.
  // Merge them: "3x Name" + "(100 pts)" -> "3x Name (100 pts)".
  const rawLines = text.split('\n');
  const preMerged = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    // If this line has no "(N pts)" and the next non-blank line has "(N pts)", merge.
    if (line && !/\(\s*\d+\s*(?:pts?|points?)\s*\)/i.test(line)) {
      for (let j = i + 1; j < Math.min(i + 3, rawLines.length); j++) {
        const next = rawLines[j];
        if (next && /^\(\s*\d+\s*(?:pts?|points?)\s*\)\s*$/i.test(next.trim())) {
          line = line + ' ' + next.trim();
          // Skip the points line
          i = j;
          break;
        }
        if (next && next.trim()) break; // non-blank, non-points line, stop
      }
    }
    preMerged.push(line);
  }
  // Split inline bullets: "A • B • C" -> "A\n• B\n• C"
  const lines = preMerged.flatMap(raw => {
    const pieces = raw.split(/(?<!^)\s+•\s+(?!$)/);
    return pieces.map((p, i) => i === 0 ? p : '• ' + p);
  });
  const sections = [];
  let current = null, currentCategory = null, currentAttachedUnit = null;
  const push = () => {
    if (current) {
      if (!current.attachedUnit) current.attachedUnit = currentAttachedUnit;
      current.category = currentCategory;
      sections.push(current);
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isUnitLine = /\(\s*\d+\s*(?:pts?|points?)\s*\)/i.test(trimmed) || /\[\s*\d+\s*pts?\s*\]/.test(trimmed);
    const isBullet = /^•/.test(trimmed) || /^◦/.test(trimmed);
    // Attached header (check BEFORE category — "Unités Attachées" starts with "Unités")
    if (!isBullet && !isUnitLine && ATTACHED_RE.test(trimmed)) {
      push(); current = null;
      const m = trimmed.match(/(\d+)/);
      currentAttachedUnit = m ? 'Attached Unit ' + m[1] : null;
      continue;
    }
    if (!isBullet && !isUnitLine && /^[A-Za-zÉÈÀÂÇÛÖÜ][\w\s'ÉÈÀÂÇÛÖÜ-]*$/i.test(trimmed) && CAT_HDR.test(trimmed)) {
      push(); current = null;
      currentCategory = trimmed.toUpperCase();
      currentAttachedUnit = null;
      continue;
    }
    // Enhancement lines that look like units (e.g. "Enhancement: Name (10 pts)")
    if (!isBullet && ENHANCEMENT_RE.test(trimmed) && current) {
      current.enhancements = (current.enhancements ? current.enhancements + ', ' : '') + trimmed;
      continue;
    }
    // Attachment patterns: "Leading Name" and "Attached to Name"
    if (!isBullet && current && /^Leading\s+(.+?)(?:\[\d+\])?\s*$/i.test(trimmed)) {
      const m = trimmed.match(/^Leading\s+(.+?)(?:\[\d+\])?\s*$/i);
      if (m) current.attachedUnit = m[1].trim();
      continue;
    }
    if (!isBullet && current && /^Attached to\s+(.+?)(?:\[\d+\])?\s*$/i.test(trimmed)) {
      const m = trimmed.match(/^Attached to\s+(.+?)(?:\[\d+\])?\s*$/i);
      if (m) current.attachedUnit = m[1].trim();
      continue;
    }
    // Markdown headers (##/###) as section separators (fixes Alvi)
    if (/^#{1,6}\s/.test(trimmed) && !isBullet) {
      push(); current = null;
      currentCategory = trimmed.replace(/^#+\s*/, '').trim().toUpperCase();
      currentAttachedUnit = null;
      continue;
    }
    // French-style tabbed section separators (\t--- Section ---) (fixes Taal, terra-nid cluster)
    if (/^\t?---.*---/.test(trimmed) && !isBullet) {
      push(); current = null;
      currentCategory = trimmed.replace(/^\t?---\s*(.+?)\s*---/, '$1').trim().toUpperCase();
      currentAttachedUnit = null;
      continue;
    }
    // French-style "Unit Name : N pts" format (fixes Taal, terra-nid cluster)
    const frenchUnitM = trimmed.match(/^(.+?)\s*:\s*(\d+)\s*(?:pts?|points?)\s*$/i);
    if (frenchUnitM && !isBullet && !isUnitLine) {
      push();
      current = {
        model: frenchUnitM[1].trim(),
        points: +frenchUnitM[2],
        equipment: [],
        models: [],
      };
      continue;
    }
    // Simple "1x Unit Name N pts" format without parentheses (fixes yomgui21)
    // Allows additional text after points (e.g. "warlord")
    const simpleUnitM = trimmed.match(/^(\d+)\s+(.+?)\s+(\d+)\s*(?:pts?|points?)(?:\s+(.+))?$/i);
    if (simpleUnitM && !isBullet && !isUnitLine) {
      push();
      current = {
        model: simpleUnitM[2].trim(),
        points: +simpleUnitM[3],
        equipment: [],
        models: [{ count: +simpleUnitM[1], name: simpleUnitM[2].trim(), subs: [] }],
        isWarlord: simpleUnitM[4] && /^warlord/i.test(simpleUnitM[4]),
      };
      continue;
    }
    // Equipment line detection: if a line has multiple "Nx" patterns with commas,
    // it's equipment for the current unit, not a new unit (fixes Revvvenge)
    // Must NOT match unit declaration patterns (CharN:, N+x, (N pts), [Npts])
    const isEquipmentLine = /\b\d+x[^,]*,.*\b\d+x/i.test(trimmed) && !isBullet &&
      !isUnitLine && !/^(Char\d+\s*:\s*)/.test(trimmed);
    if (isEquipmentLine && current && !current._awaitPoints) {
      current.equipment.push(trimmed);
      continue;
    }
    // "+ UNIT NAME (count)" pattern (fixes Looping): unit name with count, points on next line
    const plusUnitM = trimmed.match(/^\+\s*(.+?)\s*\(.*?\d+.*?\)\s*$/i);
    if (plusUnitM && !isBullet) {
      push();
      current = {
        model: plusUnitM[1].trim(),
        points: 0,
        equipment: [],
        models: [],
        _awaitPoints: true,
      };
      continue;
    }
    // After a "+ UNIT" declaration, the next line is equipment with points (fixes Looping)
    if (current && current._awaitPoints && !isBullet) {
      const ptsM = trimmed.match(/\(\s*(\d+)\s*(?:pts?|points?)\s*\)/i);
      if (ptsM) {
        current.points = +ptsM[1];
        // The rest is equipment
        const before = trimmed.substring(0, ptsM.index).trim();
        if (before) current.equipment.push(before);
        delete current._awaitPoints;
        continue;
      }
    }
    const unitM = trimmed.match(/^(Char\d+\s*:\s*)?(?:\d+x\s+)?(.+?)\s*[\(\[]\s*(\d+)\s*(?:pts?|points?)\s*[\)\]]/i);
    if (unitM && !isBullet) {
      push();
      const after = trimmed.slice(unitM[0].length).trim();
      const equipment = [];
      if (after.startsWith(':')) equipment.push(...after.slice(1).split(',').map(s => s.trim()).filter(Boolean));
      current = {
        label: unitM[1] ? unitM[1].replace(/\s*:\s*/, '').trim() : null,
        model: unitM[2].trim(),
        points: +unitM[3],
        equipment,
        models: [],
      };
      continue;
    }
    if (isBullet) {
      const t = trimmed.replace(/^•\s*/, '').replace(/^◦\s*/, '').trim();
      // Bullet with points on same line (e.g. "• 1x Unit (130 pts)") — treat as unit declaration
      const bulletUnitM = t.match(/^(\d+)x\s+(.+?)\s*\(\s*(\d+)\s*(?:pts?|points?)\s*\)/i);
      if (bulletUnitM) {
        push();
        current = {
          model: bulletUnitM[2].trim(),
          points: +bulletUnitM[3],
          equipment: [],
          models: [{ count: +bulletUnitM[1], name: bulletUnitM[2].trim(), subs: [] }],
        };
        continue;
      }
      if (!current) current = { model: '(unknown)', equipment: [], models: [] };
      const cleaned = t.split(':').slice(0, 1)[0].trim();
      const mm = cleaned.match(/^(\d+)\s*x\s+(.+)$/i);
      if (mm) {
        current.models.push({ count: +mm[1], name: mm[2].trim(), subs: [] });
      } else if (/^(Attached as|Attachée en tant que)\s*:\s*/i.test(t)) {
        current.role = t.replace(/^(Attached as|Attachée en tant que)\s*:\s*/i, '').trim();
      } else if (/^Warlord$/i.test(t) || /^Seigneur de Guerre$/i.test(t)) {
        current.isWarlord = true;
      } else if (ENHANCEMENT_RE.test(t)) {
        current.enhancements = (current.enhancements ? current.enhancements + ', ' : '') + t;
      } else if (current.models.length) {
        const lm = current.models[current.models.length - 1];
        (lm.subs = lm.subs || []).push(t);
      } else {
        current.equipment.push(t);
      }
    }
  }
  push();
  // Merge "(unknown)" units back into the previous one (empty-line artifact fix)
  const merged = [];
  for (const u of sections) {
    if (u.model === '(unknown)' && merged.length) {
      const prev = merged[merged.length - 1];
      if (prev.attachedUnit === u.attachedUnit && prev.category === u.category) {
        prev.models = [...(prev.models || []), ...(u.models || [])];
        if (u.enhancements) prev.enhancements = (prev.enhancements ? prev.enhancements + ', ' : '') + u.enhancements;
        if (u.role && !prev.role) prev.role = u.role;
        if (u.isWarlord) prev.isWarlord = true;
        continue;
      }
    }
    merged.push(u);
  }
  // Filter out "(unknown)" units with no points — transfer models to next unit
  const filtered = [];
  for (let i = 0; i < merged.length; i++) {
    const u = merged[i];
    if (u.model === '(unknown)' && !u.points) {
      // Transfer models to next unit if any
      if (i + 1 < merged.length && u.models?.length) {
        merged[i + 1].models = [...u.models, ...(merged[i + 1].models || [])];
      }
      continue;
    }
    filtered.push(u);
  }
  return filtered;
}

// ============================================================
// Preamble parser (for lists without a +++ header)
// ============================================================
const FORCE_RE = /^(?:Reconnaissance|Take and Hold|Prendre et Tenir|Priority Assets|Atouts Prioritaires|Purge the Foe|Prey in Ambush|Disruption|Perturbation)\s*$/im;
const DET_PATTERNS = [
  [/^(.+?)\s*\(\s*\d+\s*Points\s+de\s+Détachement\s*\)/im, m => m[1]],
  [/^(.+?)\s*\(\s*\d+\s+Detachment\s+Points?\s*\)/im, m => m[1]],
  [/^(?:Détachements?|Detachments?)\s*:\s*(.+)$/im, m => m[1]],
  [/^(.+?)\s*\(\s*\d+\s*Points\s+de\s+Detachement\s*\)/im, m => m[1]],
  // Labeled form "DETACHMENT : X" — may appear in a freeform header without
  // a surrounding + delimiter block (e.g. kuwanan's + DETACHMENT : ...)
  [/^\+?\s*DETACHMENT\s*:?\s*(.+)$/im, m => m[1]],
];

function findPreambleEnd(lines) {
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (CAT_HDR.test(t)) { end = i; break; }
    if (/^•/.test(t) || /^◦/.test(t)) { end = i; break; }
    if (/^Char\d+:/i.test(t)) { end = i; break; }

  }
  return end;
}
function parsePreamble(bodyText) {
  const lines = bodyText.split('\n');
  const end = findPreambleEnd(lines);
  const preamble = lines.slice(0, end).join('\n');
  let detachment = null;
  for (const [re, fn] of DET_PATTERNS) {
    const m = preamble.match(re);
    if (m) { detachment = fn(m).trim(); break; }
  }
  const dispM = preamble.match(FORCE_RE);
  return { detachment, forceDisposition: dispM ? dispM[0] : null };
}

// ============================================================
// Known factions (used as a fallback when the h2 title doesn't yield one)
// ============================================================
// These are the 40k edition 40K factions. When the h2 title doesn't contain
// " : Faction", we scan the body text line-by-line for an exact match against
// this list. Sorted longest-first so "Chaos Space Marines" wins over "Space Marines".
const KNOWN_FACTIONS = [
  'Adeptus Astartes',
  'Adeptus Mechanicus',
  'Adeptus Titanicus',
  'Astra Militarum',
  'Chaos Daemons',
  'Chaos Knights',
  'Chaos Space Marines',
  'Imperial Knights',
  'Imperial Agents',
  'Leagues of Votann',
  'Adepta Sororitas',
  'Adeptus Custodes',
  'Space Marines',
  'Genestealer Cults',
  'Emperor\u2019s Children',
  'Thousand Sons',
  'World Eaters',
  'Death Guard',
  'Grey Knights',
  'Aeldari',
  'Drukhari',
  'Necrons',
  'Orks',
  'Tyranids',
  'T\u2019au Empire',
].sort((a, b) => b.length - a.length);

// Scan body text for a known faction as a whole line. Faction info lives in
// the top ~6 lines of the preamble; scanning further risks matching unit
// names that happen to equal a faction keyword. We also skip over a banner
// line ("<Name> (N points)") before scanning, since freeform headers often
// put the army name on line 0.
function scanFaction(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && i < 10; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const tl = t.toLowerCase();
    for (const f of KNOWN_FACTIONS) {
      if (tl === f.toLowerCase() || tl === f.toLowerCase() + 's') return f;
    }
    // A single "(N points)" line is likely a team/army banner, not a unit.
    // Skip it and keep scanning so a faction line that follows is still
    // picked up. Multiple unit-like lines in a row mark the real unit list.
    const unitLike = /^.+\(\s*\d+\s*(?:pts?|points?)\s*\)$/.test(t);
    if (unitLike && i > 0 && lines[i + 1] && /^.+\(\s*\d+\s*(?:pts?|points?)\s*\)$/.test(lines[i + 1].trim())) break;
  }
  return null;
}

// ============================================================
// Build
// ============================================================
function buildPlayers(articles) {
  const players = [];
  for (const article of articles) {
    const a = article.html;
    const h2m = a.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2m && !article.playerName) continue;
    let name, faction, title;
    if (h2m) {
      title = decodeEntities(h2m[1]).replace(/\s+/g, ' ').trim();
      const parts = title.split(' : ');
      name = parts[0] || title;
      faction = parts.slice(1).join(' : ') || null;
    } else {
      // Individual format: player name is in the button span, format is "PlayerName - Faction"
      title = article.playerName;
      const parts = title.split(' - ');
      name = parts[0].trim();
      faction = parts.slice(1).join(' - ').trim() || null;
    }
    const player = {
      name,
      faction,
      teamName: article.teamName || null,
    };
    // Team events have <h2>; individual events use <div class="whitespace-pre-line"> for the body.
    const afterH2 = a.includes('</h2>')
      ? a.slice(a.indexOf('</h2>') + 6)
      : a.slice(a.indexOf('>', a.indexOf('whitespace-pre-line')) + 1);
    const bodyText = stripTags(afterH2).split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    // Preserve the full body text so parsePreamble (called from getMeta) can find
    // the detachment / force disposition lines that live in the preamble section,
    // which is otherwise discarded once the header block is stripped.
    player.bodyText = bodyText;
    // Fallback for faction: freeform headers often omit the " : Faction" suffix
    // in the h2 but still include the faction as a standalone line in the preamble.
    if (!player.faction) player.faction = scanFaction(bodyText);
    const lines = bodyText.split('\n');
    const block = findPlusBlock(lines);
    if (block) {
      let header = parseHeaderLines(lines.slice(block.openIdx + 1, block.closeIdx));
      let cursor = block.closeIdx + 1;
      // Check for a second header block starting within the next few lines
      const remaining = lines.slice(cursor);
      const block2 = findPlusBlock(remaining);
      if (block2 && block2.openIdx <= 2) {
        // Merge second block into header
        const header2 = parseHeaderLines(lines.slice(cursor + block2.openIdx + 1, cursor + block2.closeIdx));
        header = { ...header, ...header2 };
        cursor += block2.closeIdx + 1;
      }
      player.header = header;
      const remainingLines = lines.slice(cursor);
      const preambleEnd = findPreambleEnd(remainingLines);
      // Only strip preamble if a stop condition was found; otherwise keep all remaining text
      const bodyRest = (preambleEnd < remainingLines.length)
        ? remainingLines.slice(preambleEnd).join('\n').trim()
        : remainingLines.join('\n').trim();
      // Hybrid format detection: if body has both [Npts] and bullets, use parseBullets
      // (fixes Alvi which uses [N pts] with • bullets and ## headers)
      const hasNewRecruit = /\[\s*\d+\s*pts?\s*\]/.test(bodyRest);
      const hasBullets = /•|◦/.test(bodyRest);
      const hasMarkdownHeaders = /^#{1,6}\s/m.test(bodyRest);
      if (hasNewRecruit && (hasBullets || hasMarkdownHeaders)) {
        player.units = parseBullets(bodyRest);
        player.format = 'bullets';
      } else if (hasNewRecruit) {
        player.units = parseNewRecruit(bodyRest);
        player.format = 'newrecruit';
      } else {
        player.units = parseBullets(bodyRest);
        player.format = 'bullets';
      }
      player.bodyRest = bodyRest;
    } else {
      player.header = null;
      const preambleEnd = findPreambleEnd(lines);
      const bodyRest = (preambleEnd < lines.length)
        ? lines.slice(preambleEnd).join('\n').trim()
        : lines.join('\n').trim();
      // Hybrid format detection: if body has both [Npts] and bullets, use parseBullets
      // (fixes Alvi which uses [N pts] with • bullets and ## headers)
      const hasNewRecruit = /\[\s*\d+\s*pts?\s*\]/.test(bodyRest);
      const hasBullets = /•|◦/.test(bodyRest);
      const hasMarkdownHeaders = /^#{1,6}\s/m.test(bodyRest);
      if (hasNewRecruit && (hasBullets || hasMarkdownHeaders)) {
        player.units = parseBullets(bodyRest);
        player.format = 'bullets';
      } else if (hasNewRecruit) {
        player.units = parseNewRecruit(bodyRest);
        player.format = 'newrecruit';
      } else {
        player.units = parseBullets(bodyRest);
        player.format = 'bullets';
      }
      player.bodyRest = bodyRest;
    }
    player.title = title;
    players.push(player);
  }
  return players;
}

// ============================================================
// Mini formatter
// ============================================================
function isPreamble(u) {
  if (!u) return true;
  if (u.points && u.points >= 1000) return true;
  const n = (u.model || '').toLowerCase();
  if (/^(strike force|force de frappe|force of|reconnaissance|purge the foe|take and hold|priority assets|atouts prioritaires|disruption|perturbation|prise et maintien|prendre et tenir)\b/i.test(n)) return true;
  return false;
}
function bulletCount(u) {
  if (!u.models || !u.models.length) return 1;
  const counts = u.models.map(m => m.count).filter(c => c && c > 0);
  return counts.length ? Math.max(...counts) : 1;
}
function isCharacter(u) {
  if (u.role && /leader|meneur|appui|support|character|personnage/i.test(u.role)) return true;
  if (u.label && /^char\d+$/i.test(u.label)) return true;
  if (!u.models || u.models.length === 0) return true;
  if (u.models.length === 1 && u.models[0].count === 1) return true;
  return false;
}
function shortName(u) {
  const name = u.model || '(?)';
  const mc = bulletCount(u);
  if (isCharacter(u) || mc <= 1) return name;
  return `${mc} ${name}`;
}
function cleanEnhancement(s) {
  return s
    .replace(/^(?:Enhancements?|Optimisations?)\s*:\s*/i, '')
    .replace(/\s*\(\s*\+\s*\d+\s*pts?\s*\)/i, '')
    .replace(/\s*\(\s*\d+\s*pts?\s*\)/i, '')
    .replace(/\s*\(\s*\d+\s*\)/g, '')
    .replace(/\s*\((?:upgrade|amélioration|amelioration)\)\s*/i, '')
    .trim();
}
function enhancementTag(u) {
  if (!u.enhancements) return '';
  const parts = u.enhancements.split(/&|,|;/i).map(cleanEnhancement).filter(Boolean);
  if (!parts.length) return '';
  const seen = new Set();
  return ` [${parts.filter(p => !seen.has(p) && seen.add(p)).join(', ')}]`;
}
function newRecruitMini(u) {
  let m = u.model || '(?)';
  let count = 1;
  m = m.replace(/^\d+x\s+/i, '');
  const cm = m.match(/^(\d+)\s+(.+)$/);
  if (cm) { count = +cm[1]; m = cm[2]; }
  const core = count > 1 ? `${count} ${m}` : m;
  return core + enhancementTag(u);
}
function renderBullet(player) {
  const units = (player.units || []).filter(u => !isPreamble(u));
  const lines = [];
  let buffer = [];
  let cur = null;
  const flush = () => { if (buffer.length) { lines.push(buffer.join(' + ')); buffer = []; } };
  for (const u of units) {
    const s = shortName(u) + enhancementTag(u);
    if (!s) continue;
    if (u.attachedUnit) {
      if (cur !== u.attachedUnit) { flush(); cur = u.attachedUnit; }
      buffer.push(s);
    } else {
      flush();
      cur = null;
      lines.push(s);
    }
  }
  flush();
  return lines;
}
function renderNewRecruit(player) {
  const units = (player.units || []).filter(u => !isPreamble(u));
  const lines = [];
  let i = 0;
  while (i < units.length) {
    const parent = units[i];
    const s = newRecruitMini(parent);
    const attach = [];
    let j = i + 1;
    while (j < units.length && units[j].attached) { attach.push(newRecruitMini(units[j])); j++; }
    lines.push([s, ...attach].filter(Boolean).join(' + '));
    i = j;
  }
  return lines;
}
function collapseDups(lines) {
  const out = [];
  let prev = null, n = 0;
  const flush = () => { if (prev) out.push(n > 1 ? `${n}x ${prev}` : prev); };
  for (const l of lines) {
    if (l === prev) n++;
    else { flush(); prev = l; n = 1; }
  }
  flush();
  return out;
}
function renderPlayer(player) {
  return collapseDups(player.format === 'newrecruit' ? renderNewRecruit(player) : renderBullet(player));
}
function cleanDetachment(s) {
  if (!s) return null;
  return s
    .replace(/\s*\(\s*\d+\s+Detachment\s+Points?\s*\)/ig, '')
    .replace(/\s*\(\s*\d+\s*Points\s+de\s+Détachement\s*\)/ig, '')
    .trim() || null;
}
// Extract the team name. Priority order:
//   1. The outer <article> card's <button><span> — the canonical team
//      name shown on the MHQ page (always present for team tournaments).
//   2. The +++ header's TEAM NAME key (may differ slightly from the card,
//      e.g. "Cartel de Trolls" vs. "Cartel de Trollito").
//   3. The first line of the preamble when there's no +++ header — the
//      army banner "<Name> (N points)" with N around the army total.
function getTeamName(player) {
  if (player.teamName) return player.teamName;
  if (player.header && player.header.teamName) return player.header.teamName.trim();
  const body = player.bodyRest || '';
  // Walk the preamble lines until we hit a unit declaration or bullet.
  const lines = body.split('\n');
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(?:PERSONNAGES?|CHARACTERS?|CHARACTER|LIGNE|LINE|BATTLELINE|OTHER|AUTRES|VEHICULES?|VEHICLES?|TERRAIN|INDUSTRIALS?|BUILDINGS?|UNIQUE|ATTACHED UNITS|UNITÉS? ATTACH|TRANSFERTS?|TRANSPORTS?|TRANSFERTS? ASSIGNÉ|TRANSFERTS? ASSIGNEE|TRANSFERTS? ASSIGN|CHAR\d+:|Char\d+:|Unit\s+\d|UNIT\s+\d)/i.test(t)) break;
    if (/^•/.test(t) || /^◦/.test(t) || /^\|/.test(t)) break;
    // Army banner: "<Name> (N points)" where N is roughly the army total.
    const m = t.match(/^(.+?)\s*\(\s*(\d+)\s*points?\s*\)$/i);
    if (m && +m[2] >= 1500 && +m[2] <= 2500) return m[1].trim();
    // If the first non-empty line has no "(N points)" pattern, it's likely a
    // player name or a unit line — not a team banner. Stop looking.
    break;
  }
  return null;
}

function getMeta(player) {
  const teamName = getTeamName(player);
  let detachment = player.header && player.header.detachment ? cleanDetachment(player.header.detachment) : null;
  let forceDisposition = (player.header && player.header.forceDisposition) || null;
  if (!detachment || !forceDisposition) {
    // Preamble parsing needs the full body text so it can find detachment /
    // disposition lines that live in the preamble section (before the first
    // category header). bodyRest only holds what comes AFTER the preamble,
    // so using it here would silently drop the info.
    const p = parsePreamble(player.bodyText || player.bodyRest || '');
    if (!detachment) detachment = p.detachment;
    if (!forceDisposition) forceDisposition = p.forceDisposition;
  }
  return { teamName, detachment, forceDisposition };
}

// ============================================================
// Programmatic entry points (used by server.mjs)
// ============================================================
function extractEvent(url, html) {
  // Prefer the page <title> for the canonical event name; fall back to the URL slug.
  const titleM = html.match(/<title>([^<]+)<\/title>/);
  let eventName = null;
  if (titleM) {
    // "La Croisade des Canuts 2 | MiniHeadQuarters" -> "La Croisade des Canuts 2"
    // The <title> is not entity-decoded elsewhere, so an apostrophe lands as &#x27;.
    eventName = decodeEntities(titleM[1].split('|')[0].trim());
  }
  const urlPath = new URL(url).pathname;
  const slug = urlPath.split('/').filter(Boolean).pop();
  const m = slug.match(/^(.*)-(\d{4})-(\d{2})-(\d{2})$/);
  if (!eventName) eventName = m ? m[1].replace(/-/g, ' ') : slug;
  const eventDate = m ? m[2] + '-' + m[3] + '-' + m[4] : null;
  return { name: eventName, date: eventDate, url };
}

// Sum of real unit points and the total the list declares. declaredPts is
// null when no readable total exists. "Real" excludes the Strike Force /
// Force de Frappe summary lines, which are not units.
function totals(player) {
  const realUnits = (player.units || []).filter(u => u.points && u.points < 1000 &&
    !/^(?:Strike Force|Force de Frappe|Force of|DA Recon)/i.test(u.model || ''));
  const parsedPts = realUnits.reduce((s, u) => s + (u.points || 0), 0);
  let declaredPts = null;
  if (player.header && player.header.totalPoints) {
    declaredPts = parseInt(player.header.totalPoints);
  } else {
    // Header is null or lacks totalPoints -- try to extract from bodyRest.
    // Prefer an explicit total label ("Strike Force (N points)", "TOTAL ARMY POINTS : Npts")
    // over a bare "(N pts)" unit-style match, which can pick up a unit cost.
    const text = player.bodyRest || '';
    const labeled = text.match(/(?:Strike\s+Force|Force\s+de\s+Frappe|TOTAL\s+ARMY\s+POINTS|Total\s+de\s+Points)[^\n]*?\(?\s*(\d{3,5})\s*(?:pts?|points?)\s*\)?/i);
    if (labeled) declaredPts = parseInt(labeled[1]);
    else {
      const m = text.match(/(\d{3,5})\s*pts?\)/);
      if (m) declaredPts = parseInt(m[1]);
    }
  }
  // A NaN total means the header had a totalPoints key that could not be read as
  // a number; treat that as missing rather than emitting "declared NaN".
  if (declaredPts == null || Number.isNaN(declaredPts)) declaredPts = null;
  return { parsedPts: parsedPts, declaredPts: declaredPts };
}

// Warnings the mini formatter emits for one army, in mini order
// (points first, then detachment, then force disposition).
function playerWarnings(player, meta) {
  const warnings = [];
  const t = totals(player);
  if (t.declaredPts == null) {
    warnings.push({ type: 'missing-total', text: '> ⚠ missing total points' });
  } else if (t.parsedPts !== t.declaredPts) {
    const diff = t.parsedPts - t.declaredPts;
    warnings.push({ type: 'mismatch', text: '> ⚠ points mismatch: declared ' + t.declaredPts + ', parsed ' + t.parsedPts + ' (' + (diff > 0 ? '+' : '') + diff + ')' });
  }
  if (!meta.detachment) warnings.push({ type: 'detachment', text: '> ⚠ detachment not found' });
  if (!meta.forceDisposition) warnings.push({ type: 'disposition', text: '> ⚠ force disposition not found' });
  return warnings;
}

function renderMini(output) {
  const { event, count, players } = output;
  // Group players by team
  const teams = new Map();
  for (const p of players) {
    const teamName = p.teamName || 'Unknown';
    if (!teams.has(teamName)) teams.set(teamName, []);
    teams.get(teamName).push(p);
  }
  const out = [];
  out.push('# ' + event.name + ' — ' + (event.date || ''));
  out.push('');
  out.push(teams.size + ' teams, ' + count + ' armies');
  out.push('');
  for (const [teamName, teamPlayers] of teams) {
    out.push('## ' + teamName);
    out.push('');
    for (const p of teamPlayers) {
      const meta = getMeta(p);
      out.push('### ' + p.name + ' — ' + p.faction);
      if (meta.detachment) out.push('- ' + meta.detachment);
      if (meta.forceDisposition) out.push('- ' + meta.forceDisposition);
      // Emit warnings under the header
      for (const w of playerWarnings(p, meta)) out.push(w.text);
      out.push('');
      out.push(...renderPlayer(p));
      out.push('');
    }
  }
  return out.join('\n');
}

async function parseUrl(url, { log = false } = {}) {
  const { status, html } = await fetchHTML(url);
  if (status !== 200) throw new Error('HTTP ' + status + ' fetching ' + url);
  if (log) console.error('Fetched ' + html.length + ' bytes');
  const articles = splitArticles(html);
  if (log) console.error('Found ' + articles.length + ' articles');
  const players = buildPlayers(articles);
  if (log) console.error('Parsed ' + players.length + ' players');
  const output = { event: extractEvent(url, html), count: players.length, players };
  return { output, miniText: renderMini(output) };
}

// ============================================================
// Main
// ============================================================
async function main() {
  const { output, miniText } = await parseUrl(args.url, { log: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, args.jsonName);
  const miniPath = path.join(args.outDir, args.miniName);
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.error('Wrote ' + jsonPath);
  fs.writeFileSync(miniPath, miniText);
  console.error('Wrote ' + miniPath + ' (' + miniText.length + ' bytes)');
}

export { URL_RE, parseArgs, totals, getMeta, playerWarnings, renderMini, parseUrl, fetchHTML, splitArticles, buildPlayers };

if (IS_MAIN) {
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
  main().catch(e => { console.error(e); process.exit(1); });
}

