#!/usr/bin/env node
'use strict';
/**
 * FR/EN term translation, gated by Jev.
 *
 *   node src/translate-fr-en.mjs --term "INFANTRY"
 *   node src/translate-fr-en.mjs --demo
 *
 * The glossary next door holds only pairs read off a parallel source. This file
 * exists for the terms no parallel source publishes: keywords, stratagems and
 * rules-section names. It answers three questions per term, in order.
 *
 *   1. Is it a keyword? Keywords are a closed vocabulary with regular,
 *      consistent translations, so a lookup is exact, free and auditable. A
 *      model adds risk and no capability here.
 *   2. Is it a proper noun? AHRIMAN, ANGRON, ADRAX AGATONE are not translated,
 *      and a model asked to translate a list will invent French for them
 *      happily. Deciding "do not translate" is the most valuable thing the gate
 *      does, because that mistake is invisible - it produces plausible French
 *      that no book has ever printed.
 *   3. Otherwise it is a phrase, and that is the one case a model is genuinely
 *      needed for.
 *
 * What a model produces is a GUESS, not a translation. "Oath of Moment" might
 * come back as "Serment du Moment"; the official French term is whatever the
 * French codex prints, and nothing here can check that. So every entry carries
 * its provenance, and model output is marked verified:false. It is good enough
 * to expand a French question into English search terms - where a wrong guess
 * simply fails to match - and it is not good enough to show a reader as the
 * official term.
 *
 * That distinction is the whole design: sourced or mechanical translation for
 * anything displayed, model translation only where it is consumed by the
 * retriever and never quoted.
 */

import fs from 'node:fs';
import https from 'node:https';
import { printTable } from './glossary.mjs';
import { JEV_ENDPOINT, JEV_MODEL, MODEL, MODEL_ENDPOINT, credential, modelCredential } from './rules.mjs';

// --- the mechanical table ---------------------------------------------------
// Seeded from the parser's own dictionary, which was read off real French army
// lists, plus the Munitorum Field Manual's leader tags. It is a starting set,
// not a complete one, and every entry is marked curated rather than verified
// until a French rules publication confirms it.
export const KEYWORDS = {
  INFANTRY: 'INFANTERIE', MONSTER: 'MONSTRE', VEHICLE: 'VÉHICULE', CHARACTER: 'PERSONNAGE',
  BATTLELINE: 'LIGNE', MOUNTED: 'MONTÉ', BEASTS: 'BÊTES', SWARM: 'ESSAIM', WALKER: 'MARCHEUR',
  FLY: 'VOL', FLYING: 'VOLANT', TITANIC: 'TITANIQUE', TOWERING: 'DOMINANT', TRANSPORT: 'TRANSPORT',
  PSYKER: 'PSYKER', EPIC: 'ÉPIQUE', HERO: 'HÉROS', GRENADES: 'GRENADES', SMOKE: 'FUMIGÈNES',
  DEDICATED: 'DÉDIÉ', ALLIED: 'ALLIÉ', LEGENDS: 'LÉGENDES', IMPERIUM: 'IMPERIUM',
  CHAOS: 'CHAOS', XENOS: 'XENOS', AELDARI: 'AELDARI', ASTARTES: 'ASTARTES',
  LEADER: 'MENEUR', SUPPORT: 'APPUI', BODYGUARD: 'GARDES DU CORPS', CAPTURE: 'CAPTURE',
  PRECISION: 'PRÉCISION', DEVASTATING: 'DÉVASTATEUR', SUSTAINED: 'SALVE', LETHAL: 'LÉTAL',
  TWIN: 'JUMELÉ', BLAST: 'EXPLOSION', TORRENT: 'TORRENT', HAZARDOUS: 'DANGEREUX',
  INDIRECT: 'INDIRECT', ASSAULT: 'ASSAUT', RAPID: 'TIR RAPIDE', HEAVY: 'LOURDE',
  PISTOL: 'PISTOLET', MELEE: 'CORPS À CORPS', RANGED: 'TIR', EXTRA: 'ATTAQUES SUPPLÉMENTAIRES',
  FEEL: 'INSENSIBLE', INVULNERABLE: 'INVULNÉRABLE', WARDING: 'PROTECTION', SCOUTS: 'ÉCLAIREURS',
  DEEP: 'FRAPPE EN PROFONDEUR', STEALTH: 'FURTIF', LONE: 'SOLITAIRE', DEADLY: 'DÉMOLITION',
};

// The parallel-source glossary, indexed both ways. It is consulted before
// anything else: a pair read off the Munitorum Field Manual is sourced, and no
// table or model decision should be allowed to overrule it. Asking the gate
// first got AGGRESSOR SQUAD wrong - it read the term as a proper noun and kept
// it in English, when the glossary has held ESCOUADE AGGRESSOR all along.
let GLOSSARY_CACHE = null;
export function glossaryIndex() {
  if (GLOSSARY_CACHE) return GLOSSARY_CACHE;
  const enToFr = new Map();
  const frToEn = new Map();
  try {
    const g = JSON.parse(fs.readFileSync(new URL('./glossary-fr-en.json', import.meta.url), 'utf8'));
    for (const e of g.entries) {
      if (!e.en || !e.fr) continue;
      if (!enToFr.has(e.en.toUpperCase())) enToFr.set(e.en.toUpperCase(), e);
      if (!frToEn.has(e.fr.toUpperCase())) frToEn.set(e.fr.toUpperCase(), e);
    }
  } catch { /* the glossary is optional */ }
  GLOSSARY_CACHE = { enToFr, frToEn };
  return GLOSSARY_CACHE;
}

export function properNouns() {
  const set = new Set();
  const { enToFr } = glossaryIndex();
  for (const [en, e] of enToFr) if (e.category === 'datasheet' && e.en === e.fr && en.split(/\s+/).length <= 2) set.add(en);
  return set;
}

// --- the gate ---------------------------------------------------------------
// One Jev call, one decision per term, batched. Free, and the decision is a
// choice rather than a judgement, which is the shape Jev is built for.
export function gatePrompt(terms) {
  const q = {};
  terms.forEach((t, i) => {
    q['t' + i] = {
      type: 'choice',
      instructions: 'What kind of term is "' + t + '" for French translation of Warhammer 40,000 rules?',
      criteria: {
        keyword: 'a rulebook keyword or weapon ability, capitalised, with a standard French equivalent',
        name: 'a proper noun: a unit, character or place name that Games Workshop does not translate',
        phrase: 'a stratagem, ability or rules-section title written as a phrase',
      },
    };
  });
  return q;
}

export async function gateTerms(terms, key, opts) {
  if (!key || !terms.length) return {};
  const body = JSON.stringify({
    model: JEV_MODEL,
    state: 'Terms taken from Warhammer 40,000 11th edition English rules text. Some are keywords, some are proper nouns, some are titles of rules.',
    questions: gatePrompt(terms),
  });
  const res = await new Promise((resolve, reject) => {
    const u = new URL(JEV_ENDPOINT);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) } }, r => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('jev timed out'))); req.end(body);
  });
  if (!res || !res.answers) throw new Error('jev returned no answers');
  const out = {};
  terms.forEach((t, i) => {
    const a = res.answers['t' + i];
    out[t] = { route: (a && a.choice) || 'phrase', confidence: a && a.confidence };
  });
  return out;
}

// --- translation ------------------------------------------------------------
export async function senseTranslate(terms, senseKey, direction) {
  if (!senseKey || !terms.length) return {};
  const prompt = [
    'Translate these Warhammer 40,000 11th edition ' + (direction === 'fr-en' ? 'French' : 'English') + ' game terms into ' + (direction === 'fr-en' ? 'English' : 'French') + '.',
    'Use the official Games Workshop translation where you know it.',
    'If a term is a proper noun that Games Workshop does not translate, repeat it unchanged.',
    'Reply with JSON only: {"translations": {"<term>": "<translation>"}}',
    '',
    terms.join('\n'),
  ].join('\n');
  const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 2000 });
  const res = await new Promise((resolve, reject) => {
    const u = new URL(MODEL_ENDPOINT);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + senseKey, 'Content-Length': Buffer.byteLength(body) } }, r => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('error', reject); req.setTimeout(90000, () => req.destroy(new Error('the model timed out'))); req.end(body);
  });
  const msg = res && res.choices && res.choices[0] && res.choices[0].message;
  const raw = String((msg && msg.content) || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try { return (JSON.parse(raw.slice(start, end + 1)).translations) || {}; } catch { return {}; }
}

export async function translateTerms(terms, opts) {
  const o = opts || {};
  const jevKey = o.jevKey || credential('OPENCODE_GO_API_KEY');
  const senseKey = o.senseKey || modelCredential();
  const proper = properNouns();
  let gates = {};
  try { gates = await gateTerms(terms, jevKey); } catch { gates = {}; }

  const out = [];
  const toModel = [];
  for (const term of terms) {
    const key = term.toUpperCase().trim();
    const g0 = glossaryIndex(); const idx = o.direction === 'fr-en' ? g0.frToEn : g0.enToFr;
    const sourced = idx.get(key);
    if (sourced) {
      out.push({ term, translation: o.direction === 'fr-en' ? sourced.en : sourced.fr, route: 'glossary', source: 'mfm', verified: true, reason: 'read off the parallel Munitorum Field Manual' });
      continue;
    }
    if (KEYWORDS[key]) {
      out.push({ term, translation: KEYWORDS[key], route: 'mechanical', source: 'curated', verified: false, reason: 'keyword table' });
      continue;
    }
    if (proper.has(key) || proper.has(term.trim())) {
      out.push({ term, translation: term, route: 'keep', source: 'glossary', verified: true, reason: 'a name the parallel glossary shows is identical in both languages' });
      continue;
    }
    const g = gates[term] || {};
    if (g.route === 'keyword') {
      // The gate says keyword but the table does not know it: that is a gap in
      // the table, and a model is the only thing that can fill it for now.
      toModel.push({ term, note: 'keyword not in the table' });
      continue;
    }
    if (g.route === 'name') {
      out.push({ term, translation: term, route: 'keep', source: 'gate', verified: false, reason: 'the gate reads it as a proper noun' });
      continue;
    }
    toModel.push({ term, note: 'phrase' });
  }

  if (toModel.length) {
    const got = await senseTranslate(toModel.map(t => t.term), senseKey, o.direction);
    for (const t of toModel) {
      const tr = got[t.term];
      out.push({
        term: t.term,
        translation: tr || '',
        route: 'model',
        source: MODEL,
        verified: false,
        reason: tr ? t.note + ' - model translation, not checked against a French publication' : t.note + ' - no translation returned',
      });
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const term = value('--term');
  const demo = argv.indexOf('--demo') !== -1;
  const terms = demo
    ? ['INFANTRY', 'MONSTER', 'CHARACTER', 'AHRIMAN', 'AGGRESSOR SQUAD', 'Oath of Moment', 'Fall-back Move', 'SUSTAINED HITS']
    : (term ? [term] : []);
  if (!terms.length) { console.log('usage: node src/translate-fr-en.mjs --term "INFANTRY" | --demo'); return; }
  const out = await translateTerms(terms, { direction: 'en-fr' });
  printTable(out);
}

if (process.argv[1] && process.argv[1].endsWith('translate-fr-en.mjs')) {
  main().catch(e => { console.error(String((e && e.message) || e)); process.exitCode = 1; });
}

export default { translateTerms, gateTerms, KEYWORDS, properNouns };
