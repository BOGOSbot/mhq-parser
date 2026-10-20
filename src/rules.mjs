#!/usr/bin/env node
'use strict';
/**
 * The rules question page's shared foundations.
 *
 * This module used to hold the whole answer pipeline: it searched Wahapedia
 * with TinyFish, fetched the pages, cut them into sections, ranked them with
 * Jev and wrote the answer with a small model - per request. The page does not work
 * that way any more. The rules are read and embedded ahead of time into a
 * vector index, and rules-corpus.mjs answers from that. The crawl is gone, and
 * with it the page cache, the ranker and the writer that only this module used.
 *
 * What is left is what other modules still import:
 *
 *   - which edition is current, and how to say it in a citation;
 *   - where the keys come from, and which of them this machine can actually
 *     use (the page and /health report that);
 *   - how a heading becomes an anchor, because a citation is built from the
 *     heading the passage came from and never from anything a model wrote.
 *
 *   RULES_EDITION        which edition the corpus holds, and what the page answers for
 *   RULES_*_ENDPOINT     the gateways, for pointing a deployment elsewhere
 *   OPENCODE_GO_API_KEY  Jev, free
 *   MISTRAL_API_KEY      the translation, the judge and the prose (RULES_MODEL_*)
 *   TINYFISH_API_KEY     no longer read here; kept in keyState so an existing
 *                        deployment's /health does not change shape under it
 *
 * Standard library only, like the rest of the project.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// --- the two inference routes -----------------------------------------------
// The halves of the pipeline fail differently, so they are two routes.
//
// The WRITER has to engage with a rule it has only half found, and to write the
// answer the reader sees. A small fast model is worst exactly here: on the real
// question bank ministral-8b refused 54 of 65 answers the judge had accepted
// (22% accuracy against the community's rulings) and on the six French
// questions it answered fluently and wrongly (0%). So the writer is SenseNova,
// which engages, is right about half to three quarters of the time, and is
// free. RULES_MODEL_* moves it.
//
// The MECHANICAL half - the translation, the search terms, the judge - only
// decides and rewrites, and the judge is what makes a question slow (median 17s,
// mean 35s over that same bank). A small fast model belongs here.
// RULES_FAST_ENDPOINT / RULES_FAST_MODEL / RULES_FAST_KEY point at one - any
// OpenAI-compatible endpoint, including a box on this machine - and with none
// of them set the fast route IS the writer's route, which is the easy default.
// A custom endpoint is taken at its word about authentication: a box on this
// machine may want no key at all.
const SENSENOVA = 'https://token.sensenova.ai/v1/chat/completions';
const SENSENOVA_MODEL = 'sensenova-6.8-flash-lite';

export const MODEL_ENDPOINT = process.env.RULES_MODEL_ENDPOINT || SENSENOVA;
export const MODEL = process.env.RULES_MODEL || SENSENOVA_MODEL;
export function modelKeyName() {
  if (process.env.RULES_MODEL_KEY) return process.env.RULES_MODEL_KEY;
  return process.env.RULES_MODEL_ENDPOINT ? '' : 'SENSENOVA_API_KEY';
}
export function modelCredential() { const n = modelKeyName(); return n ? credential(n) : ''; }
export function modelReady() { return !!(process.env.RULES_MODEL_ENDPOINT || modelCredential()); }

export const FAST_ENDPOINT = process.env.RULES_FAST_ENDPOINT || MODEL_ENDPOINT;
export const FAST_MODEL = process.env.RULES_FAST_MODEL || MODEL;
export function fastKeyName() {
  if (process.env.RULES_FAST_KEY) return process.env.RULES_FAST_KEY;
  if (process.env.RULES_FAST_ENDPOINT) return '';
  return modelKeyName();
}
export function fastCredential() { const n = fastKeyName(); return n ? credential(n) : ''; }
export function fastReady() { return !!(process.env.RULES_FAST_ENDPOINT || fastCredential()); }

// Reasoning is the upfront wait. On a real judge prompt (6.5k characters, six
// passages) SenseNova spends 187 reasoning tokens and 4.1s at its default, and
// 0 tokens and 2.1s with reasoning off - and the real bank's judge prompts are
// ten times that, which is why the wait is where it is. The judge, the
// translation and the search terms only decide and rewrite, so the fast route
// runs with reasoning off by default, and so does the writer (measured; see
// MODEL_REASONING below).
//
// The field is reasoning_effort, and it is only sent where it was chosen: a
// route pointed at another gateway gets it when RULES_MODEL_REASONING or
// RULES_FAST_REASONING asks, and nothing when they are silent, because another
// gateway may not know the field.
//
// The judge keeps its thinking. Measured on the same 17 questions, a judge
// without it scored 61.8% where the same judge thinking scored 79.4% - it
// accepts findings that do not answer and the writer then writes from them -
// and the seconds it saves are not worth that. 'medium' is the default because
// it is the setting that behaves: on a real judge prompt it spent ~375
// reasoning tokens on both samples, where the model's own default wandered
// between 80 and 367. RULES_FAST_REASONING=none buys back the seconds.
// The writer does NOT keep its thinking, measured: on the 25-question bank, the
// writer with reasoning off scored 60.0% against the default's 60.4% - the same
// within the noise - with zero empty or timed-out writer responses against one,
// and a mean answer time of 17.1s against 102.2s. The reasoning was buying six
// times the wall clock and the failures, not the answer. The judge is the one
// that needs it (79.4% against 61.8%); the writer does not.
// RULES_MODEL_REASONING=medium restores the old behaviour.
export const MODEL_REASONING = process.env.RULES_MODEL_REASONING || 'none';
export const FAST_REASONING = process.env.RULES_FAST_REASONING || (process.env.RULES_FAST_ENDPOINT ? '' : 'medium');

// How long one call may take. The thinking judge is the slow step and 90s was
// cutting real questions off - seven of twenty-five in the measured run, which
// is a lost answer where a slow one would have done. A question is allowed to
// take three minutes; RULES_MODEL_TIMEOUT_MS / RULES_FAST_TIMEOUT_MS move it.
export const MODEL_TIMEOUT_MS = Number(process.env.RULES_MODEL_TIMEOUT_MS) || 180000;
export const FAST_TIMEOUT_MS = Number(process.env.RULES_FAST_TIMEOUT_MS) || MODEL_TIMEOUT_MS;
// task-31: a reasoning call is unbounded in practice on the fast model. Measured
// against token.sensenova.ai on a deep-shaped judge prompt (18,645 characters, 10
// passages, max_tokens 4000): reasoning_effort medium returned 200 in 27.6s where
// 'none' returned 200 in 3.6s, and the same model on the Box's own deep list never
// came back inside the 180s model timeout - the run then died as an error event.
// The reasoning attempt gets its own bound; when it is not back by then the judge
// is asked again without reasoning, so a deep run answers instead of dying.
export const JUDGE_REASONING_TIMEOUT_MS = Number(process.env.RULES_JUDGE_REASONING_TIMEOUT_MS) || 45000;

// Two gateways speak the System One decisions protocol - same request and
// answers shape, different key refs. The free OpenCode Zen tier rate-limited
// the ranker (HTTP 429) on the /rules page, which is why OpenRouter's paid
// decisions endpoint was the default for a while; on 2026-10-12 the free tier
// took twelve ranker calls in a burst with no failure, so it is the default
// again and the paid route is the fallback (RULES_JEV_GATEWAY=openrouter, where
// "~typesafe/jev-latest" resolves to whichever Jev snapshot TypeSafe has
// published). Explicit RULES_JEV_ENDPOINT / RULES_JEV_MODEL still win over the
// gateway choice, but the key follows the gateway, not the endpoint override.
const JEV_GATEWAYS = {
  opencode: { name: 'opencode', free: true, endpoint: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', keyName: 'OPENCODE_GO_API_KEY' },
  openrouter: { name: 'openrouter', free: false, endpoint: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest', keyName: 'OPENROUTER_API_KEY' },
};
const JEV_GATEWAY = JEV_GATEWAYS[String(process.env.RULES_JEV_GATEWAY || 'opencode').toLowerCase()] || JEV_GATEWAYS.opencode;
export const JEV_ENDPOINT = process.env.RULES_JEV_ENDPOINT || JEV_GATEWAY.endpoint;
export const JEV_MODEL = process.env.RULES_JEV_MODEL || JEV_GATEWAY.model;

// The active gateway's credential name, so key reads follow the route instead
// of assuming the free tier's key.
export function jevKeyName() { return JEV_GATEWAY.keyName; }

// --- the gateway chain (task-45) --------------------------------------------
// Mandal: 'The free should be default, but we should auto fallback to paid.'
// The free tier is a rolling quota window whose retry-afters have measured from
// 69 s to 85,923 s, and a reader who hits it gets a degraded answer with no
// explanation - worse than paying a fraction of a cent. So a request walks this
// chain, in order, and a QUOTA answer (429 / FreeUsageLimitError) moves it to the
// next gateway. The paid route is never tried first, and never when the free one
// answered.
//
// RULES_JEV_GATEWAY still pins one gateway by name, and it is the ONLY way to get
// the paid route alone (the fallback would otherwise re-add the free one in front
// of it). Explicit RULES_JEV_ENDPOINT/RULES_JEV_MODEL still replace the first
// entry's transport, because a harness points those at a stub.
const JEV_PINNED = String(process.env.RULES_JEV_GATEWAY || '').toLowerCase();
export function jevChain() {
  const pinned = JEV_GATEWAYS[JEV_PINNED];
  if (pinned) {
    const first = process.env.RULES_JEV_ENDPOINT || process.env.RULES_JEV_MODEL
      ? Object.assign({}, pinned, { endpoint: process.env.RULES_JEV_ENDPOINT || pinned.endpoint, model: process.env.RULES_JEV_MODEL || pinned.model })
      : pinned;
    return [first];
  }
  const first = Object.assign({}, JEV_GATEWAYS.opencode, {
    endpoint: process.env.RULES_JEV_ENDPOINT || JEV_GATEWAYS.opencode.endpoint,
    model: process.env.RULES_JEV_MODEL || JEV_GATEWAYS.opencode.model,
  });
  return [first, JEV_GATEWAYS.openrouter];
}

// A gateway is 'quota' when it is telling us we have used our allowance, not when
// it is broken. Only a quota answer moves down the chain: a timeout has already
// spent its wall-clock budget and retrying it on a second gateway would double the
// reader's wait for the same silence, and a 5xx or a malformed answer is a real
// fault that a second gateway does not fix - those are reported as failures, which
// is what the caller's no-rerank fallback is for.
export function gatewayVerdict(status, body) {
  const s = Number(status) || 0;
  if (s === 429) return 'quota';
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  if (/FreeUsageLimit|free usage limit|rate.?limit/i.test(text)) return 'quota';
  if (s >= 500) return 'error';
  if (s === 0) return 'timeout';
  if (s >= 400) return 'error';
  return 'ok';
}

// What the paid fallback costs, and the ceiling on it. Measured price: about
// $0.20 for 486 calls, roughly $0.0004 a call; one question's rerank is a handful
// of calls. The cap is a DAILY one (RULES_JEV_DAILY_CAP_USD, default $1.00): when
// it is reached the paid route is not tried, the rerank degrades to no-rerank, and
// the caller says so rather than failing the answer.
export const JEV_PRICE_PER_CALL = Number(process.env.RULES_JEV_PRICE_PER_CALL || '0.0004');
export const JEV_DAILY_CAP_USD = Number(process.env.RULES_JEV_DAILY_CAP_USD || '1.00');
const JEV_LEDGER = { day: '', calls: {}, cost: 0, last: '' };
function ledgerDay() { return new Date().toISOString().slice(0, 10); }
function ledgerRoll() {
  const d = ledgerDay();
  if (JEV_LEDGER.day !== d) { JEV_LEDGER.day = d; JEV_LEDGER.calls = {}; JEV_LEDGER.cost = 0; JEV_LEDGER.last = ''; }
}
// One served call. `cost` comes from the gateway's own usage block when it sends
// one (OpenRouter does) and falls back to the measured per-call price when it does
// not (the free tier never charges).
export function noteJevCall(gateway, cost) {
  ledgerRoll();
  const g = String(gateway || 'unknown');
  JEV_LEDGER.calls[g] = (JEV_LEDGER.calls[g] || 0) + 1;
  JEV_LEDGER.cost += Number.isFinite(cost) && cost > 0 ? cost : (g === 'opencode' ? 0 : JEV_PRICE_PER_CALL);
  JEV_LEDGER.last = g;
}
// A test seam, the same shape routeStatsReset has: the cap is enforced against this
// ledger, and a test that has to spend a real dollar to see the cap bite is a test
// nobody runs. Cost is settable so the over-cap branch is reachable.
export function jevSpendReset(costUsd) {
  ledgerRoll();
  JEV_LEDGER.calls = {};
  JEV_LEDGER.cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  JEV_LEDGER.last = '';
}
export function jevSpend() {
  ledgerRoll();
  return {
    day: JEV_LEDGER.day,
    calls: Object.assign({}, JEV_LEDGER.calls),
    costUsd: Math.round(JEV_LEDGER.cost * 1e6) / 1e6,
    capUsd: JEV_DAILY_CAP_USD,
    pricePerCall: JEV_PRICE_PER_CALL,
    remainingUsd: Math.max(0, Math.round((JEV_DAILY_CAP_USD - JEV_LEDGER.cost) * 1e6) / 1e6),
    capped: JEV_LEDGER.cost >= JEV_DAILY_CAP_USD,
    lastGateway: JEV_LEDGER.last,
  };
}
// Whether a gateway may be tried at all. The free one always may; a paid one only
// while the day's spend is under the cap.
export function gatewayAllowed(gateway) {
  if (!gateway || gateway.free) return true;
  return jevSpend().costUsd < JEV_DAILY_CAP_USD;
}

// One edition, named once. The corpus holds exactly one edition, because two
// editions answer the same question with different rules and mixing them is not
// a worse answer but a wrong one. It read wh40k10ed while 10th was current;
// 11th has been current since June 2026. RULES_EDITION pins the corpus to the
// edition it was built from, so a deployment and its index cannot drift apart
// silently.
export const RULES_EDITION = process.env.RULES_EDITION || 'wh40k11ed';

// 'wh40k11ed' is a slug, and a citation should not read like one.
export function editionOf(slug) {
  const m = String(slug || '').match(/^wh40k(\d+)/i);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  const tens = n % 100;
  const suffix = (tens >= 11 && tens <= 13) ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return n + suffix + ' edition';
}

export const RULES_EDITION_LABEL = editionOf(RULES_EDITION);

export class RulesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RulesError';
    this.status = status || 500;
  }
}

// --- keys -------------------------------------------------------------------
// Environment first, then the machine-global credential store. A public
// deployment sets the variables and never has the file.
export function credentialsPath() {
  return process.env.DSH_CREDENTIALS || path.join(os.homedir(), '.dsh', '.credentials.yaml');
}

// Read one NAME: value line out of the credential store. Deliberately blunt: the
// file is a flat map written by the harness, and a YAML parser for one shape
// would be a dependency the project does not take.
export function credentialFromFile(name, file) {
  const p = file || credentialsPath();
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return ''; }
  const re = new RegExp('^\\s*' + name + ':\\s*(\\S+)\\s*$', 'm');
  const m = text.match(re);
  return m ? m[1] : '';
}

export function credential(name, env, file) {
  const fromEnv = (env || process.env)[name];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return credentialFromFile(name, file);
}

export function credentials() {
  return {
    tinyfish: credential('TINYFISH_API_KEY'),
    // The key the active gateway actually authenticates with. While the
    // temporary OpenRouter route is in place this is OPENROUTER_API_KEY; the
    // health badge and the page's key line report it, so a missing paid key
    // reads as what it is rather than as a broken free tier.
    jev: credential(jevKeyName()),
    model: modelCredential(),
    fast: fastCredential(),
  };
}

// What the page and /health report: which steps this machine can actually run.
export function keyState() {
  const c = credentials();
  return {
    tinyfish: !!c.tinyfish, jev: !!c.jev,
    model: modelReady(), modelName: MODEL,
    fast: fastReady(), fastName: FAST_MODEL,
  };
}

// --- citations --------------------------------------------------------------
// Wahapedia does carry per-section anchors: the core rules are one long page
// whose headings are slugged, so '1. Hit Roll 05.01' is reachable at
// '#1.-Hit-Roll'. The rule id is stripped off the end first - it is ours to
// know and not part of the heading the page links by.
//
// 162 of the 232 headings on the 11th-edition core rules page resolve this way,
// and every section the pipeline has actually cited is one of them. The rest are
// headings inside cards, which carry no id; a fragment that does not exist is
// ignored by the browser and the link lands on the page anyway, so a wrong guess
// costs nothing and a right one lands on the rule.
export function anchorFor(heading) {
  const text = String(heading == null ? '' : heading)
    .replace(/&amp;/g, '&')
    .replace(/\s+\d{2}(?:\.\d{2})*\s*$/, '')
    .trim();
  return text.replace(/\s+/g, '-');
}

export default {
  RULES_EDITION, RULES_EDITION_LABEL, editionOf, anchorFor,
  credential, credentials, credentialFromFile, credentialsPath, keyState,
  JEV_ENDPOINT, JEV_MODEL, jevChain, gatewayVerdict, jevSpend, jevSpendReset, noteJevCall, gatewayAllowed,
  MODEL_ENDPOINT, MODEL, modelKeyName, modelCredential, modelReady,
  FAST_ENDPOINT, FAST_MODEL, FAST_REASONING, FAST_TIMEOUT_MS, MODEL_REASONING, MODEL_TIMEOUT_MS,
  fastKeyName, fastCredential, fastReady, RulesError,
};
