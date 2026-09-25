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
// MHQ now canonicalises event pages to /details/ and 302s many /army-lists/
// URLs across to it. Both forms serve identical content, so accept both.
// Two URL shapes exist per event:
//   public : /tournaments/<type>/{army-lists|details}/<slug>
//   admin  : /tournaments/<type>/administrate/<slug>/{army-lists|details}
// The admin route is the organiser's view. Its lists show up there before they
// are published, so accept it as well.
// Each arm of the alternation requires its own slug, so a bare /army-lists
// (no event) is rejected rather than silently defaulting to an "output" dir.
const URL_RE = /^https:\/\/miniheadquarters\.com\/tournaments\/(?:team|individual|2v2|side-by-side)\/(?:administrate\/army-lists\/\d+|administrate\/[^[\/\?#]+\/(?:army-lists|details)(?:\/|$)|(?:army-lists|details)\/[^\/\?#]+\/?)(?:[?#].*)?$/;

// Admin routes need a logged-in session; public routes do not.
function isAdminUrl(url) { return /\/administrate\//.test(url); }

// /administrate/army-lists/<id> is a single submitted army. It sits directly
// under /administrate/, not under the event slug, so it gets its own arm of
// URL_RE rather than being treated as a slug-bearing route.
const ADMIN_LIST_RE = /\/administrate\/army-lists\/(\d+)/;

// Pull <event-slug> from either shape, for the default output directory.
function extractEventSlug(url) {
  let m = url.match(/\/(?:army-lists|details)\/([^\/\?#]+)/);
  if (m) return m[1];
  m = url.match(/\/administrate\/([^\/\?#]+)/);
  return m ? m[1] : null;
}

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
    cookie: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^https?:\/\//.test(arg)) a.url = arg;
    else if (arg === '--out-dir') a.outDir = argv[++i];
    else if (arg === '--json') a.jsonName = argv[++i];
    else if (arg === '--mini') a.miniName = argv[++i];
    else if (arg === '--cookie') a.cookie = argv[++i];
  }
  // A cookie can also come from the environment: handy when the value is long
  // or comes from a secret store rather than the command line.
  if (!a.cookie && process.env.MHQ_COOKIE) a.cookie = process.env.MHQ_COOKIE;
  if (!a.url) {
    throw new Error('provide a link to an MHQ army list\n' +
      '  Usage: node parse.mjs <army-lists-url> [--out-dir <dir>] [--json <name>] [--mini <name>] [--cookie <header>]\n' +
      '  Example: node parse.mjs https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>');
  }
  if (!URL_RE.test(a.url)) {
    throw new Error('provide a valid link\n' +
      '  Expected format: https://miniheadquarters.com/tournaments/<type>/(army-lists|details)/<event-slug>\n' +
      '  or the organiser admin form: https://miniheadquarters.com/tournaments/<type>/administrate/<event-slug>/(army-lists|details)\n' +
      '  or one submitted army: https://miniheadquarters.com/tournaments/<type>/administrate/army-lists/<id>\n' +
      '  Got: ' + a.url);
  }
  // Default output dir: <event-slug>/ relative to this script's directory.
  const eventSlug = extractEventSlug(a.url) || 'output';
  if (!a.outDir) a.outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), eventSlug);
  return a;
}

// ============================================================
// Fetch
// ============================================================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function httpRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', ...headers };
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// fetchOnce keeps its (url, cookie) signature for the many existing callers.
function fetchOnce(url, cookie) {
  return httpRequest('GET', url, cookie ? { headers: { Cookie: cookie } } : {});
}

// MHQ answers 302 for legacy /army-lists/ URLs, pointing at /details/. Follow
// those or the page comes back empty. Capped so a redirect loop cannot hang.
const MAX_REDIRECTS = 4;
// Second argument is an options bag { cookie, hops }; a bare number is still
// accepted as hops so existing callers keep working.
async function fetchHTML(url, opts) {
  const o = typeof opts === 'number' ? { hops: opts } : (opts || {});
  const hops = o.hops || 0;
  if (hops > MAX_REDIRECTS) throw new Error('too many redirects for ' + url);
  const r = await fetchOnce(url, o.cookie);
  if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
    return fetchHTML(new URL(r.headers.location, url).toString(), { cookie: o.cookie, hops: hops + 1 });
  }
  return r;
}

// ============================================================
// Auth wall
// ============================================================
// An authenticated-only route answers 200 with the login form instead of a
// 302 redirect, so a plain fetch looks successful and then finds zero armies.
// Without this check the caller is told "lists not published yet", which is
// the wrong diagnosis. Detect the login page explicitly.
function isLoginPage(html) {
  return /action="\/users\/login"/.test(html) && /name="csrfmiddlewaretoken"/.test(html);
}

function authError(url) {
  return [
    'authentication required - miniheadquarters.com returned the login page',
    '  for ' + url,
    '',
    '  The site is Django: it sets a csrftoken cookie on the first GET and',
    '  expects a sessionid cookie after POSTing csrfmiddlewaretoken +',
    '  username + password to /users/login.',
    '',
    '  Quickest way to unblock this without storing credentials:',
    '    1. Log in at https://miniheadquarters.com/users/login in a browser.',
    '    2. DevTools -> Network, reload, copy the Cookie request header',
    '       (or DevTools -> Application -> Cookies -> miniheadquarters.com).',
    '    3. Re-run with the session attached:',
    '       node parse.mjs <url> --cookie "sessionid=...; csrftoken=..."',
    '       or set MHQ_COOKIE in the environment.',
  ].join('\n');
}

// ============================================================
// Session login
// ============================================================
// The site is Django. GET /users/login sets a csrftoken cookie and renders a
// matching csrfmiddlewaretoken input. POSTing username + password + that token
// answers with a sessionid cookie on success, or re-renders the form with
// Django's stock "Please enter a correct username and password." error and no
// sessionid on failure. There is no anonymous route to an admin page, so this
// is the only way to obtain a session programmatically.
const LOGIN_URL = 'https://miniheadquarters.com/users/login';

// First Set-Cookie named <name>, or null. Node may report it as an array.
function setCookieOf(headers, name) {
  const sc = headers && headers['set-cookie'];
  if (!sc) return null;
  for (const c of Array.isArray(sc) ? sc : [sc]) {
    const m = c.match(new RegExp('^' + name + '=([^;]*)'));
    if (m) return m[1];
  }
  return null;
}

// The login box renders its error inside a red panel rather than as a
// <p class="error">, so match the panel by its background tint.
function loginFormError(html) {
  const m = html.match(/class="[^"]*text-red-[0-9]+[^"]*"[^>]*>([^<]{5,300})</i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

async function loginSession(username, password) {
  const g = await httpRequest('GET', LOGIN_URL);
  if (g.status !== 200) return { ok: false, error: 'login page answered HTTP ' + g.status };
  const tok = (g.html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
  const csrftoken = setCookieOf(g.headers, 'csrftoken') || '';
  if (!tok) return { ok: false, error: 'no CSRF token on the login page - the site has probably changed' };
  const body = 'csrfmiddlewaretoken=' + encodeURIComponent(tok)
    + '&username=' + encodeURIComponent(username || '')
    + '&password=' + encodeURIComponent(password || '');
  const p = await httpRequest('POST', LOGIN_URL, {
    headers: {
      'Cookie': 'csrftoken=' + csrftoken,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': LOGIN_URL,
      'Origin': 'https://miniheadquarters.com',
    },
    body,
  });
  const sessionid = setCookieOf(p.headers, 'sessionid');
  if (sessionid) {
    return {
      ok: true,
      cookie: 'sessionid=' + sessionid + '; csrftoken=' + (setCookieOf(p.headers, 'csrftoken') || csrftoken),
      redirect: p.headers.location || null,
    };
  }
  return {
    ok: false,
    status: p.status,
    error: loginFormError(p.html) || 'login failed - no session cookie was issued',
  };
}


// ============================================================
// Organiser / admin pages
// ============================================================
// The admin view is a completely different layout from the public one. The
// event page is a <table> of rows - one per submitted army - holding username,
// team, faction, dates, a status badge and a link. The list body is not on that
// page at all: it lives on a per-army page at
// /tournaments/<type>/administrate/army-lists/<id>, so each row costs a second
// fetch. The status is the badge text in the table ("Pending validation",
// "Accepted", "Rejected") and is carried onto the player for the UI.

// Fixed cell order in a row: subscription checkbox, username, team, faction,
// last modified, first submission, last review by, status, link.
function splitAdminRows(html) {
  const rows = [];
  let p = 0;
  while (true) {
    const s = html.indexOf("<tr class=\"transition hover:bg-white/5\">", p);
    if (s === -1) break;
    const e = html.indexOf("</tr>", s);
    if (e === -1) break;
    const row = html.substring(s, e + "</tr>".length);
    const cells = [];
    let c = 0;
    while (true) {
      const cs = row.indexOf("<td", c);
      if (cs === -1) break;
      const ce = row.indexOf("</td>", cs);
      if (ce === -1) break;
      cells.push(row.substring(cs, ce + "</td>".length));
      c = ce + 1;
    }
    if (cells.length >= 8) {
      const idM = row.match(/army-lists\/(\d+)/);
      if (idM) {
        const hrefM = cells[8].match(/href="([^"]+)"/);
        rows.push({
          id: idM[1],
          username: cellText(cells[1]),
          team: cellText(cells[2]),
          faction: cellText(cells[3]),
          lastModified: cellText(cells[4]),
          firstSubmission: cellText(cells[5]),
          lastReviewBy: cellText(cells[6]),
          status: cellText(cells[7]),
          url: hrefM ? "https://miniheadquarters.com" + hrefM[1] : null,
        });
      }
    }
    p = e + 1;
  }
  return rows;
}

// Plain text of a table cell: tags become spaces, entities decoded.
function cellText(cell) {
  if (!cell) return "";
  return decodeEntities(cell.replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

// The submitted list body: the single whitespace-pre-line paragraph on the
// per-army page, as HTML. It is handed to buildPlayers unchanged.
function adminListContent(html) {
  const m = html.match(/<p class="whitespace-pre-line[^"]*">([\s\S]*?)<\/p>/);
  return m ? m[1] : null;
}

// The per-army page repeats the status in a "Status:" info block. It is the
// short form ("Pending") rather than the table badge ("Pending validation"),
// so it is a fallback for a URL pasted on its own.
function adminStatusOf(html) {
  const m = html.match(/Status:[\s\S]{0,500}?text-white">\s*([^<]+?)\s*</);
  return m ? decodeEntities(m[1]).trim() : null;
}

// A submitted army as an article for buildPlayers. The name and faction come
// from the table row; buildPlayers reads them out of an <h2> "Name : Faction".
function adminArticle(row, body) {
  return {
    html: "<h2>" + escapeHtml(row.username || "(unnamed)") + " : " + escapeHtml(row.faction || "") + "</h2>" + (body || ""),
    teamName: row.team || null,
    playerName: null,
    admin: {
      id: row.id,
      url: row.url || null,
      status: row.status || null,
      lastModified: row.lastModified || null,
      firstSubmission: row.firstSubmission || null,
      lastReviewBy: row.lastReviewBy || null,
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Fetch a per-army page, or null. Never throws: one bad list must not kill the
// whole event, and an empty submission is a legitimate state.
async function fetchAdminList(url, { cookie = null, log = false } = {}) {
  if (!url) return null;
  try {
    const { status, html } = await fetchHTML(url, { cookie });
    if (status !== 200 || isLoginPage(html)) {
      if (log) console.error("  " + url + ": HTTP " + status);
      return null;
    }
    return adminListContent(html);
  } catch (e) {
    if (log) console.error("  " + url + ": " + e.message);
    return null;
  }
}

// An <id> in the URL means a single submitted army, not an event index.
function oneAdminArticle(id, html) {
  const nameM = html.match(/\+\s*PLAYER\s*NAME\s*:\s*(.+)/i);
  const facM = html.match(/\+\s*FACTION\s*KEYWORD\s*:\s*(.+)/i);
  const teamM = html.match(/\+\s*TEAM\s*NAME\s*:\s*(.+)/i);
  return adminArticle({
    id: id,
    username: nameM ? nameM[1].trim() : "(unnamed)",
    faction: facM ? facM[1].trim() : "",
    team: teamM ? teamM[1].trim() : "",
    status: adminStatusOf(html),
  }, adminListContent(html) || "");
}

async function parseAdmin(url, { log = false, cookie = null } = {}) {
  const idM = url.match(ADMIN_LIST_RE);
  const { status, html } = await fetchHTML(url, { cookie });
  if (status !== 200) throw new Error("HTTP " + status + " fetching " + url);
  if (isLoginPage(html)) throw new Error(authError(url));
  if (log) console.error("Fetched " + html.length + " bytes");

  let articles;
  if (idM) {
    // A single army: the event name comes from the page <title>.
    articles = [oneAdminArticle(idM[1], html)];
  } else {
    const rows = splitAdminRows(html);
    if (log) console.error("Found " + rows.length + " submitted armies");
    if (!rows.length) {
      throw new Error("no army lists found - this event has probably not published its lists yet");
    }
    articles = [];
    for (const row of rows) articles.push(adminArticle(row, await fetchAdminList(row.url, { cookie, log })));
  }

  const players = buildPlayers(articles);
  players.forEach((p, i) => {
    const a = articles[i] && articles[i].admin;
    if (!a) return;
    p.status = a.status || null;
    p.adminId = a.id;
    p.adminUrl = a.url || null;
    p.lastModified = a.lastModified || null;
    p.firstSubmission = a.firstSubmission || null;
    p.lastReviewBy = a.lastReviewBy || null;
  });
  const output = { event: extractEvent(url, html), count: players.length, players };
  return { output, miniText: renderMini(output) };
}
// ============================================================
// HTML decoding & article splitting
// ============================================================
function decodeEntities(s) {
  // The site emits a literal non-breaking space (U+00A0) where it means an
  // ordinary one; left alone it would break search for "Houndpack Lance".
  return s.replace(/\u00a0/g, ' ')
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
    // Any unit declaration, not just CharN-prefixed ones. Without this a
    // preamble immediately followed by a unit line swallows that unit into
    // the stripped preamble. A bare "(N pts)" is not enough: freeform
    // headers carry detachment and force-disposition lines that look
    // similar, so require the "1x Name" or "CharN: Name" shape.
    if (/^(?:\d+x|Char\d+:)\s*\S.*\(\s*\d+\s*(?:pts?|points?)\s*\)/i.test(t)) { end = i; break; }
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
    const bodyText = stripTags(afterH2).replace(/^[\s\S]*?(?=[\S])/, '').split('\n').map(l => l.trim()).join('\n');
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
  // The admin index URL puts the event slug BEFORE /army-lists, so popping
  // the last segment would yield the view name rather than the slug.
  const slug = extractEventSlug(url) || '';
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
      out.push('### ' + p.name + ' — ' + p.faction + (p.status ? ' [' + p.status + ']' : ''));
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

async function parseUrl(url, { log = false, cookie = null } = {}) {
  const { status, html } = await fetchHTML(url, { cookie });
  if (status !== 200) throw new Error('HTTP ' + status + ' fetching ' + url);
  // An authenticated-only route returns the login form with HTTP 200.
  // Admin views use a different layout and fetch one page per army, so they go
  // through their own path.
  if (isAdminUrl(url)) return parseAdmin(url, { log, cookie });
  if (log) console.error('Fetched ' + html.length + ' bytes');
  const articles = splitArticles(html);
  if (log) console.error('Found ' + articles.length + ' articles');
  const players = buildPlayers(articles);
  if (log) console.error('Parsed ' + players.length + ' players');
  // A tournament page with no armies means the lists are not out yet: either the
  // URL was a /details/ info page, or the /army-lists/ URL redirected to one.
  // Say so instead of handing back an empty result.
  if (players.length === 0) {
    throw new Error('no army lists found - this event has probably not published its lists yet');
  }
  const output = { event: extractEvent(url, html), count: players.length, players };
  return { output, miniText: renderMini(output) };
}

// ============================================================
// Main
// ============================================================
async function main() {
  const { output, miniText } = await parseUrl(args.url, { log: true, cookie: args.cookie });
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, args.jsonName);
  const miniPath = path.join(args.outDir, args.miniName);
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.error('Wrote ' + jsonPath);
  fs.writeFileSync(miniPath, miniText);
  console.error('Wrote ' + miniPath + ' (' + miniText.length + ' bytes)');
}

// Load the sitemap cache (if needed) and return every event, not just a page.
async function getAllEvents() {
  await listEvents({ limit: 1 });
  return eventCache.list;
}

// Check whether a tournament is Warhammer 40,000 and whether its army lists are
// published. The details page carries both facts: a "Game" label in the quick
// info grid, and an "Army lists" section that says either "Click to see army
// lists" or "Army lists are not available at this time."
async function checkEvent(detailsUrl) {
  const r = await fetchHTML(detailsUrl);
  if (r.status !== 200) return { game: null, hasLists: false, listCount: 0 };
  const h = r.html;
  const gm = h.match(/text-xs uppercase tracking-wide text-slate-400">\s*Game\s*<\/div>\s*<div class="text-sm text-white">\s*([^<]+)<\/div>/i);
  const game = gm ? gm[1].trim() : null;
  const am = h.match(/Army lists\s*<\/h2>\s*<div[^>]*>\s*<p>([^<]{0,150})/i);
  let hasLists = !!am && !/not available/i.test(am[1]);
  let listCount = 0;
  if (hasLists) {
    const listsUrl = detailsUrl.replace(/\/details\//, '/army-lists/');
    const lr = await fetchHTML(listsUrl);
    if (lr.status === 200) {
      listCount = (lr.html.match(/data-accordion-button/g) || []).length;
      // Some events say "Click to see army lists" but the lists page is empty
      if (listCount === 0 && /No lists/i.test(lr.html)) hasLists = false;
    }
  }
  return { game, hasLists, listCount };
}

export { URL_RE, parseArgs, isAdminUrl, ADMIN_LIST_RE, extractEventSlug, totals, getMeta, playerWarnings, renderMini, parseUrl, fetchHTML, httpRequest, fetchOnce, setCookieOf, loginSession, loginFormError, LOGIN_URL, splitArticles, buildPlayers, listEvents, getAllEvents, checkEvent, detectFormat, isLoginPage, authError, splitAdminRows, adminListContent, adminStatusOf, adminArticle, parseAdmin, formatDateOf, typeToFormat, parseOrganizedRows, listOrganizedTournaments };

// ============================================================
// Event discovery. MHQ publishes its whole catalogue in sitemap.xml, which is
// the only real index the site offers - the homepage and /tournaments/ both
// return nothing usable. The sitemap carries <lastmod> dates, so events can be
// sorted newest-first. Every entry there uses the canonical /details/ form.
// ============================================================
const SITEMAP_URL = 'https://miniheadquarters.com/sitemap.xml';
const EVENT_TTL_MS = 6 * 60 * 60 * 1000;
let eventCache = null;

function daysFromToday(d) {
  if (!d) return 1e9;
  return Math.abs(Math.round((Date.now() - new Date(d + 'T00:00:00Z')) / 86400000));
}

function prettify(slug) {
  const noDate = slug.replace(/\d{4}-\d{2}-\d{2}(?:-.*)?$/, '');
  return noDate.replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || slug;
}

function detectFormat(slug, type) {
  const s = slug.toLowerCase();
  if (type === 'team' || /\bteams?\b/.test(s)) return 'teams';
  if (/2v2|side[-\s]?by[-\s]?side/.test(s)) return '2v2 (side-by-side)';
  if (/1v1|1vs1|\bsolo\b/.test(s)) return '1v1';
  if (type === 'individual') return '1v1';
  return 'unknown';
}

async function listEvents(opts) {
  opts = opts || {};
  const limit = Math.min(Math.max(opts.limit || 80, 1), 400);
  const only = opts.type || null;
  const fresh = eventCache && (Date.now() - eventCache.at) < EVENT_TTL_MS;
  if (!fresh) {
    const r = await fetchOnce(SITEMAP_URL);
    if (r.status !== 200) throw new Error('sitemap returned HTTP ' + r.status);
    const out = [];
    const seen = new Set();
    let m;
    const re = new RegExp('<loc>([^<]*\/tournaments\/[^<]*)</loc>', 'g');
    while ((m = re.exec(r.html)) !== null) {
      // The sitemap gives the /details/ info page, which never carries list data.
      // The /army-lists/ form does - and 302s back to /details/ when not yet out.
      const detailsUrl = m[1];
      const url = detailsUrl.replace(/\/(details)\//, '/army-lists/');
      // The sitemap repeats some entries; keep one of each.
      if (seen.has(url)) continue;
      seen.add(url);
      const parts = url.split('/');
      const i = parts.indexOf('tournaments');
      if (i < 0) continue;
      const type = parts[i + 1] || '';
      const slug = parts[parts.length - 1] || '';
      if (!slug) continue;
      let date = null;
      const dm = slug.match(/(\d{4}-\d{2}-\d{2})(?:-.*)?$/);
      if (dm) date = dm[1];
      const j = r.html.indexOf(m[1]);
      const k = j >= 0 ? r.html.indexOf('<lastmod>', j) : -1;
      const lastmod = k >= 0 ? r.html.slice(k + 9, k + 19) || null : null;
      out.push({
        slug,
        type,
        url,
        detailsUrl,
        date: date || lastmod,
        lastmod,
        future: !!date && date > new Date().toISOString().slice(0, 10),
        name: prettify(slug),
        format: detectFormat(slug, type),
      });
    }
    // Newest dates first would bury recent, parseable events under next-year
    // league registrations. Sort by distance from today instead: tournaments
    // around now are the ones whose lists are actually published.
    out.sort((a, b) => daysFromToday(a.date) - daysFromToday(b.date));
    eventCache = { list: out, at: Date.now() };
  }
  const all = only ? eventCache.list.filter(e => e.type === only) : eventCache.list;
  return {
    events: all.slice(0, limit),
    count: all.length,
    total: eventCache.list.length,
    cached: !!fresh,
    fetchedAt: new Date(eventCache.at).toISOString(),
  };
}


// ============================================================
// Organiser events. The sitemap only ever carries the public catalogue, so an
// organiser's own events are invisible there when they are private, unlisted,
// or not yet published. /users/my-organized-tournaments is the authenticated
// list of tournaments the caller organises, and it is the only place MHQ
// exposes it. The admin army-lists path is rebuilt from <type> and <slug> -
// the same trick the UI applies to sitemap entries.
// ============================================================
const ORGANIZED_URL = 'https://miniheadquarters.com/users/my-organized-tournaments';

const MONTH_ABBR = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// "Oct. 10, 2026" / "October 10, 2026" -> "2026-10-10", null when not a date.
// The row uses the site's display form, not ISO, so it needs translating to
// match the dates listEvents extracts out of slugs.
function formatDateOf(s) {
  const m = String(s || '').trim().match(/^([A-Za-z.]+)\.?\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTH_ABBR[m[1].toLowerCase().replace(/\./g, '')];
  if (!mo) return null;
  return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
}

function typeToFormat(type, slug) {
  if (type === 'team') return 'teams';
  if (type === 'side-by-side') return '2v2 (side-by-side)';
  return detectFormat(slug, type);
}

// One <tr> per row. Finished events get Tailwind's opacity-60 on the <tr>,
// which is the only signal the site gives for a past tournament.
function parseOrganizedRows(html) {
  const out = [];
  for (const row of html.match(/<tr class="transition[^"]*">[\s\S]*?<\/tr>/g) || []) {
    const href = row.match(/href="\/tournaments\/([a-z-]+)\/details\/([^"?#\/\s]+)/);
    if (!href) continue;
    const type = href[1];
    const slug = href[2];
    // The row also contains a <td> with a class, so the two <div>s must be
    // picked out of the anchor alone, not the whole row: the first match in the
    // row would otherwise pair the <td> with the name div and drop the date.
    const a = row.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    const dv = a ? a[1].match(/<div[^>]*>([^<]*?)<\/div>\s*<div[^>]*>([^<]*?)<\/div>/) : null;
    const date = formatDateOf(dv ? dv[2] : '');
    out.push({
      slug,
      type,
      name: dv ? dv[1].trim() : prettify(slug),
      date,
      future: !!date && date > new Date().toISOString().slice(0, 10),
      past: /opacity-60/.test(row),
      url: 'https://miniheadquarters.com/tournaments/' + type + '/administrate/' + slug + '/army-lists',
      detailsUrl: 'https://miniheadquarters.com/tournaments/' + type + '/details/' + slug,
      format: typeToFormat(type, slug),
      // Unknown here: whether lists are out is only knowable from the lists
      // page itself, which the UI fetches on parse.
      listCount: null,
    });
  }
  return out;
}

async function listOrganizedTournaments(cookie) {
  const { status, html } = await fetchHTML(ORGANIZED_URL, { cookie });
  if (status !== 200) return { ok: false, status, organized: [] };
  if (isLoginPage(html)) return { ok: false, auth: true, organized: [] };
  return { ok: true, organized: parseOrganizedRows(html) };
}

if (IS_MAIN) {
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
  main().catch(e => { console.error(e); process.exit(1); });
}

