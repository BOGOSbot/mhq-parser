#!/usr/bin/env node
'use strict';
// Offline tests for verify-points.mjs: synthetic MFM tables, no network, no
// browser. Every verification rule is pinned here in miniature; the live
// corpus that shaped the rules is the bogos-team-6 event (see the tool header).

import fs from 'node:fs';
import { verifyEvent, summarize, parseMfmPage } from '../verify-points.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- the reference ------------------------------------------------------------
// One en table and one fr table, aligned by order (the alignment fallback
// relies on that), plus enhancement prices per page.
const tables = {
  // three datasheets, copy brackets and wargear exactly as the real render gives them
  'necrons': [
    { name: 'LOKHUST LORD', brackets: [{ label: 'YOUR UNIT COSTS', sizes: [{ n: 1, pts: 80, delta: null }] }], wargear: [] },
    { name: 'LOKHUST DESTROYERS', brackets: [
      { label: 'YOUR 1ST TO 2ND UNITS COST', sizes: [{ n: 6, pts: 190, delta: 15 }] },
      { label: 'YOUR 3RD + UNIT COSTS', sizes: [{ n: 6, pts: 220, delta: 15 }] },
    ], wargear: [{ per: 'Gauss cannon', pts: 5 }] },
    { name: 'SKORPEKH DESTROYERS', brackets: [
      { label: 'YOUR 1ST TO 2ND UNITS COST', sizes: [{ n: 3, pts: 85, delta: null }] },
      { label: 'YOUR 3RD + UNIT COSTS', sizes: [{ n: 3, pts: 95, delta: null }] },
    ], wargear: [] },
  ],
  // the GMNDK shape: one bracket per copy band, two wargear options - the
  // 250-pt row is 210 + 15 + 15 + 10 and needs MIXED wargear sums
  'grey-knights': [
    { name: 'GRAND MASTER IN NEMESIS DREADKNIGHT', brackets: [
      { label: 'YOUR 1ST UNIT COSTS', sizes: [{ n: 1, pts: 210, delta: null }] },
      { label: 'YOUR 3RD + UNIT COSTS', sizes: [{ n: 1, pts: 225, delta: null }] },
    ], wargear: [{ per: 'Sublimator', pts: 15 }, { per: 'Heavy psycannon', pts: 15 }] },
  ],
};
const enh = {
  'necrons': { DEEPENINGMADNESS: 20, MARKOFTHENEKROSOR: 20 },
  'grey-knights': { SIGILOFTHEHUNT: 10 },
};
const factionPages = faction => {
  const pages = [];
  for (const pg of (faction === 'Necrons' ? ['necrons'] : faction === "T'au Empire" ? ['tau-empire'] : ['grey-knights'])) {
    if (tables[pg]) pages.push(pg);
    if (tables[pg + '@fr']) pages.push(pg + '@fr');
  }
  return pages;
};
const ref = { tables, enh, factionPages };

// --- the event ----------------------------------------------------------------
const ev = players => ({ event: { name: 'test' }, players: players.map(p => ({ name: p[0], teamName: p[1], faction: p[2], units: p[3] })) });
const U = (model, points, extra) => ({ model, points, models: [], equipment: [], ...extra });

// --- exact tiers ----------------------------------------------------------------
let rows = verifyEvent(ev([
  ['A', 'Team1', 'Necrons', [
    U('Lokhust Lord (80 points)', 80, { models: [{ count: 1, name: 'Lokhust Lord' }] }),
    U('Lokhust Destroyers (190 points)', 190, { models: [{ count: 6, name: 'Lokhust Destroyer' }] }),
  ]],
]), ref);
t('exact tier, single bracket', rows[0].status, 'ok');
t('first copy reads the first bracket', rows[1].status + '/' + rows[1].tier + '/' + rows[1].bracket, 'ok/6/YOUR 1ST TO 2ND UNITS COST');

// --- copy bracket: the third copy pays the second bracket --------------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Necrons', [
    U('Lokhust Destroyers (190 points)', 190, { models: [{ count: 6, name: 'Lokhust Destroyer' }] }),
    U('Lokhust Destroyers (190 points)', 190, { models: [{ count: 6, name: 'Lokhust Destroyer' }] }),
    U('Lokhust Destroyers (220 points)', 220, { models: [{ count: 6, name: 'Lokhust Destroyer' }] }),
  ]],
]), ref);
t('third copy pays the 3rd+ bracket', rows[2].status + '/' + rows[2].bracket, 'ok/YOUR 3RD + UNIT COSTS');

// --- enhancement folded in -------------------------------------------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Necrons', [
    U('Lokhust Destroyers (210 points)', 210, { models: [{ count: 6, name: 'Lokhust Destroyer' }], enhancements: 'Enhancement: Deepening Madness' }),
  ]],
]), ref);
t('enhancement folded in verifies', rows[0].status + '/' + rows[0].note, 'ok/verified: 190 + Deepening Madness +20');

// --- wargear-only fold -----------------------------------------------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Necrons', [
    U('Lokhust Destroyers (200 points)', 200, { models: [{ count: 6, name: 'Lokhust Destroyer' }] }),
  ]],
]), ref);
t('wargear-only fold verifies without an enhancement', rows[0].status + '/' + rows[0].note, 'ok/verified: 190 + wargear +10');

// --- mixed wargear + enhancement: the shape that made the rule ---------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Imperium - Grey Knights', [
    U('Grand Master in Nemesis Dreadknight (250 points)', 250, {
      models: [{ count: 1, name: 'Grand Master' }],
      enhancements: 'Enhancement: Sigil of the Hunt (+10 pts)',
    }),
  ]],
]), ref);
t('mixed wargear + enhancement verifies', rows[0].status + '/' + rows[0].note, 'ok/verified: 210 + Sigil of the Hunt +10 + wargear +30');

// --- CHECK: nothing explains it ----------------------------------------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Necrons', [
    U('Lokhust Lord (95 points)', 95, { models: [{ count: 1, name: 'Lokhust Lord' }] }),
    U('Lokhust Destroyers (500 points)', 500, { models: [{ count: 6, name: 'Lokhust Destroyer' }], enhancements: 'Enhancement: Deepening Madness' }),
  ]],
]), ref);
t('unexplained figure is CHECK', rows[0].status, 'CHECK');
t('enhancement that does not explain is CHECK', rows[1].status === 'CHECK' && (rows[1].note || '').includes('Deepening Madness'), true);

// --- the preamble strike-force lines are never units -------------------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Necrons', [
    U('Strike Force (2000 points)', 2000, { models: [] }),
    U('Cursed Legion (3 Detachment Points)', 3, { models: [] }),
    U('Lokhust Lord (80 points)', 80, { models: [{ count: 1, name: 'Lokhust Lord' }] }),
  ]],
]), ref);
t('strike-force and detachment-point lines are not units', rows.length, 1);

// --- unmatched / reference-only ------------------------------------------------------
rows = verifyEvent(ev([
  ['A', 'T', 'Necrons', [
    U('Not A Datasheet (50 points)', 50, { models: [{ count: 3, name: 'Not A Datasheet' }] }),
    U('Dragon Knights (85 points)', 85, { models: [{ count: 3, name: 'Dragon Knight' }] }),
  ]],
]), ref);
t('unknown datasheet is unmatched', rows[0].status, 'unmatched');
t('reference-only datasheet is no-mfm-row', rows[1].status === 'no-mfm-row' && rows[1].note.includes('reference only'), true);

// --- numeric model names: "20 Boyz (170 pts)" ----------------------------------------
tables.orks = [
  { name: 'BOYZ', brackets: [{ label: 'YOUR UNIT COSTS', sizes: [{ n: 10, pts: 85, delta: null }, { n: 20, pts: 170, delta: null }] }], wargear: [] },
];
const refOrks = { tables, enh, factionPages: f => (f === 'Orks' ? ['orks'] : factionPages(f)) };
rows = verifyEvent(ev([
  ['A', 'T', 'Orks', [
    U('20 Boyz (170 points)', 170, { models: [{ count: 2, name: 'Nob' }, { count: 18, name: 'Boyz' }] }),
  ]],
]), refOrks);
t('numeric model name resolves the datasheet', rows[0].status + '/' + rows[0].refPage, 'ok/orks');
delete tables.orks;

// --- fr-only pricing: alias bridge ----------------------------------------------------
// The en render shows the datasheet as a bare reference; the fr page prices it.
// ALIAS maps the roster's name to the fr page's spelling.
delete tables['grey-knights'];
tables['space-wolves'] = [{ name: 'WOLF GUARD HEADTAKERS', brackets: [], wargear: [] }];
tables['space-wolves@fr'] = [{ name: 'PRENEURS DE TÊTES GARDES LOUPS', brackets: [
  { label: 'DE LA 1RE À LA 2E, VOS UNITÉS COÛTENT', sizes: [{ n: 3, pts: 85, delta: null }, { n: 6, pts: 170, delta: null }] },
], wargear: [] }];
const refSW = { tables, enh, factionPages: f => (f === 'Space Wolves' ? ['space-wolves', 'space-wolves@fr'] : factionPages(f)) };
rows = verifyEvent(ev([
  ['A', 'T', 'Imperium - Adeptus Astartes - Space Wolves', [
    U('- Wolf Guard Headtakers (170 points)', 170, { models: [{ count: 6, name: 'Wolf Guard Headtaker' }] }),
  ]],
]), refSW);
t('fr-only priced datasheet verifies through the alias', rows[0].status + '/' + rows[0].bracket, 'ok/DE LA 1RE À LA 2E, VOS UNITÉS COÛTENT');
delete tables['space-wolves'];
delete tables['space-wolves@fr'];

// --- summarize ------------------------------------------------------------------------
const s = summarize([{ status: 'ok' }, { status: 'ok' }, { status: 'CHECK' }]);
t('summarize counts and manual list', s.verified + '/' + s.total + '/' + s.manual.length, '2/3/1');

// --- the page parser: role labels never become names, wargear attaches right ----------
const page =
  'LOKHUST LORD\n' +
  'YOUR UNIT COSTS\n' +
  '1 model\n' +
  '80 pts\n' +
  'LEADER\n' +
  'LOKHUST DESTROYERS, LOKHUST HEAVY DESTROYERS\n' +
  'LOKHUST DESTROYERS\n' +
  'YOUR 1ST TO 2ND UNITS COST\n' +
  '6 models\n' +
  '\u25b2 (+15) 190 pts\n' +
  'YOUR 3RD + UNIT COSTS\n' +
  '6 models\n' +
  '220 pts\n' +
  'WARGEAR OPTIONS\n' +
  'per Gauss cannon\n' +
  '5 pts\n';
const parsed = parseMfmPage(page);
t('page: two units parsed', parsed.length, 2);
t('page: role list line did not become a name', parsed[0].name, 'LOKHUST LORD');
t('page: second unit named by its own line', parsed[1].name, 'LOKHUST DESTROYERS');
t('page: arrow-marked price parsed with delta', JSON.stringify(parsed[1].brackets[0].sizes), '[{"n":6,"pts":190,"delta":15}]');
t('page: wargear attached to the unit above', JSON.stringify(parsed[1].wargear), '[{"per":"Gauss cannon","pts":5}]');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
