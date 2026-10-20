#!/usr/bin/env node
'use strict';
/**
 * The /dev diagnostics report: what we keep checking by hand, in one read-only
 * page. It is deliberately data-first (devState) and pure (devProblems, devHtml)
 * so a test can hand it the two faults it exists to catch without a server, a
 * network, or a corpus:
 *
 *   - an index behind the rebuilt corpus: faction ids in the corpus that the
 *     index never saw. The /health JSON carried the counts but nobody read them;
 *     the page states BEHIND n in the banner.
 *   - a process serving pre-commit code: the server booted before src/ changed
 *     last. Everything else can be right and the answers still come from the old
 *     code.
 *
 * It reads; it never writes and never prints a credential. The corpus/index
 * comparison is against the DELIVERED set, the same predicate the ingest and the
 * render use: a filtered record is expected out of the index, not a fault.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SOURCES, corpusDir, deliveredSections, jevCalls, namespaceFor, rangeIds, readAllCorpus, routeStats } from './rules-corpus.mjs';
import { jevSpend } from './rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEV_NAMESPACES = ['rules', 'factions', 'rulings'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The newest mtime under a directory, so a running process can be told from the
// code it is serving. No git, no dependency: mtime is what a reboot-child sees.
export function newestFile(dir) {
  let newest = 0, name = '';
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const t = fs.statSync(path.join(dir, e.name)).mtimeMs;
      if (t > newest) { newest = t; name = e.name; }
    }
  } catch (e) { /* the directory may not exist */ }
  return { at: newest, name: name };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

export function lastRebuilds(dir) {
  const out = [];
  for (const s of ALL_SOURCES) {
    const l = readJson(path.join(dir, s.name + '.rebuilds.json'));
    if (Array.isArray(l) && l.length) out.push(Object.assign({ source: s.name }, l[l.length - 1]));
  }
  return out;
}

// opts: { bootedAt, corpusDir, srcDir }
export async function devState(opts) {
  const o = opts || {};
  const all = readAllCorpus();
  const delivered = deliveredSections(all);
  const byNamespace = {};
  for (const r of delivered) { const ns = namespaceFor(r.set); byNamespace[ns] = (byNamespace[ns] || 0) + 1; }
  const namespaces = [];
  for (const ns of DEV_NAMESPACES) {
    let ids = 0, error = '';
    try { ids = (await rangeIds(ns)).length; } catch (e) { error = String((e && e.message) || e); }
    const want = byNamespace[ns] || 0;
    namespaces.push({ ns: ns, index: ids, delivered: want, delta: ids - want, error: error });
  }
  const code = newestFile(o.srcDir || path.join(__dirname, '..', 'src'));
  const bootedAt = o.bootedAt || Date.now();
  return {
    corpus: { total: all.length, delivered: delivered.length, filtered: all.length - delivered.length, byNamespace: byNamespace },
    namespaces: namespaces,
    rebuilds: lastRebuilds(o.corpusDir || corpusDir()),
    route: routeStats(),
    // task-45: the Jev gateway chain - which gateway served the calls, and what the
    // paid fallback has spent today against its cap.
    jev: { spend: jevSpend(), calls: jevCalls() },
    code: code,
    bootedAt: bootedAt,
  };
}

// The at-a-glance verdicts. Pure: the test hands this a state with the factions
// index 1,624 behind and a src file newer than boot to prove both faults show.
export function devProblems(state) {
  const out = [];
  for (const n of state.namespaces || []) {
    if (n.error) out.push('index ' + n.ns + ': ' + n.error);
    else if (n.delta < 0) out.push(n.ns + ' index is BEHIND the delivered corpus by ' + (-n.delta) + ' ids');
    else if (n.delta > 0) out.push(n.ns + ' index has ' + n.delta + ' ids the delivered corpus does not have');
  }
  if ((state.code || {}).at > (state.bootedAt || 0)) {
    out.push('STALE PROCESS: src/' + (state.code.name || '') + ' changed at ' + new Date(state.code.at).toISOString() + ', after this process booted at ' + new Date(state.bootedAt).toISOString());
  }
  return out;
}

export function devHtml(state) {
  const problems = devProblems(state);
  const okBadge = problems.length ? '<span class="bad">' + problems.length + ' problem(s)</span>' : '<span class="good">ok</span>';
  const rows = (state.namespaces || []).map(n => {
    const verdict = n.error ? 'error' : (n.delta === 0 ? 'ok' : (n.delta < 0 ? 'BEHIND ' + (-n.delta) : 'AHEAD +' + n.delta));
    return '<tr><td>' + esc(n.ns) + '</td><td class="n">' + n.index + '</td><td class="n">' + n.delivered + '</td><td class="' + (n.delta ? 'bad' : 'good') + '">' + esc(verdict) + '</td></tr>';
  }).join('');
  const rebuilds = (state.rebuilds || []).map(r => '<tr><td>' + esc(r.source) + '</td><td class="n">' + (r.rebuild || '') + '</td><td>' + esc(r.at || '') + '</td><td class="n">' + (r.sections == null ? '' : r.sections) + '</td><td class="n">' + (r.upserted == null ? '' : r.upserted) + '</td><td class="n">' + (r.deleted == null ? '' : r.deleted) + '</td><td class="n">' + (r.unchanged == null ? '' : r.unchanged) + '</td></tr>').join('');
  const route = state.route || {};
  const byRoute = Object.entries(route.byRoute || {}).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="n">' + v.calls + '</td><td class="n">' + v.empty + '</td><td class="n">' + v.retries + '</td><td class="n">' + v.recovered + '</td></tr>').join('');
  const render = state.render || {};
  const code = state.code || {};
  return '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>/dev - mhq-parser</title><style>'
    + 'body{font:14px/1.45 system-ui,sans-serif;margin:1.2rem;max-width:70rem;color:#111}'
    + 'h1{font-size:1.2rem;margin:0 0 .2rem}h2{font-size:.9rem;text-transform:uppercase;letter-spacing:.05em;margin:1.4rem 0 .3rem;color:#555}'
    + 'table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:.25rem .4rem;vertical-align:top}'
    + 'td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}'
    + '.bad{color:#b00020;font-weight:600}.good{color:#0a7a2f;font-weight:600}'
    + '.banner{margin:.7rem 0;padding:.5rem .7rem;border-left:4px solid #0a7a2f;background:#f4f7f4}'
    + '.banner.bad{border-color:#b00020;background:#fdf2f3}'
    + 'ul{margin:.3rem 0 .3rem 1.1rem;padding:0}code{background:#f2f2f2;padding:.05rem .25rem;border-radius:3px}'
    + '</style></head>\n<body>'
    + '<h1>/dev diagnostics ' + okBadge + '</h1>'
    + '<p>Read-only. Corpus and index are compared on the DELIVERED set (filtered records are expected out of the index).</p>'
    + '<div class="banner' + (problems.length ? ' bad' : '') + '">' + (problems.length ? '<ul>' + problems.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' : 'No problem: index ids match delivered, the render map matches its pass, and the process is not older than <code>src/</code>.') + '</div>'
    + '<h2>Corpus</h2><table><tr><th>records</th><th class="n">total</th><th class="n">delivered</th><th class="n">filtered (expected out)</th></tr>'
    + '<tr><td></td><td class="n">' + state.corpus.total + '</td><td class="n">' + state.corpus.delivered + '</td><td class="n">' + state.corpus.filtered + '</td></tr></table>'
    + '<h2>Index vs delivered</h2><table><tr><th>namespace</th><th class="n">index ids</th><th class="n">delivered</th><th>verdict</th></tr>' + rows + '</table>'
    + '<h2>Last rebuild per source</h2><table><tr><th>source</th><th class="n">#</th><th>at</th><th class="n">sections</th><th class="n">upserted</th><th class="n">deleted</th><th class="n">unchanged</th></tr>' + rebuilds + '</table>'
    + '<p>If a rebuild is newer than the index row above, the corpus moved and the index did not: run <code>--ingest</code>, then <code>--prune</code>.</p>'
    + '<h2>Model route since boot</h2><table><tr><th>calls</th><th class="n">empty</th><th class="n">empty rate</th><th class="n">retries</th><th class="n">recovered</th><th class="n">truncated</th></tr>'
    + '<tr><td>' + route.calls + '</td><td>' + route.empty + '</td><td>' + route.empty_rate + '%</td><td>' + route.retries + '</td><td>' + route.recovered + '</td><td>' + route.truncated + '</td></tr></table>'
    + (byRoute ? '<table><tr><th>route</th><th class="n">calls</th><th class="n">empty</th><th class="n">retries</th><th class="n">recovered</th></tr>' + byRoute + '</table>' : '')
    // task-45: the Jev gateway chain. Which gateway served each call and what the
    // paid fallback has spent today, against its cap - the only place the
    // free-versus-paid split is visible.
    + '<h2>Jev gateways</h2>'
    + (function () {
      const j = state.jev || {};
      const spend = j.spend || {};
      const calls = j.calls || {};
      const per = Object.entries(spend.calls || {}).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="n">' + v + '</td></tr>').join('');
      return '<table><tr><th>gateway</th><th class="n">calls served</th></tr>' + (per || '<tr><td>(none yet)</td><td class="n">0</td></tr>') + '</table>'
        + '<table><tr><th>spend today</th><td>$' + Number(spend.costUsd || 0).toFixed(4) + ' of $' + Number(spend.capUsd || 0).toFixed(2) + (spend.capped ? ' - CAP HIT, the paid route is off until tomorrow' : '') + '</td></tr>'
        + '<tr><th>price per paid call</th><td>$' + Number(spend.pricePerCall || 0).toFixed(4) + '</td></tr>'
        + '<tr><th>rerank calls</th><td>' + ((calls.rerank && calls.rerank.answered) || 0) + ' answered, ' + ((calls.rerank && calls.rerank.failed) || 0) + ' failed</td></tr>'
        + '<tr><th>gate calls</th><td>' + ((calls.gate && calls.gate.answered) || 0) + ' answered, ' + ((calls.gate && calls.gate.failed) || 0) + ' failed</td></tr></table>';
    })()
    + '<h2>Code / process</h2><table>'
    + '<tr><th>process booted</th><td>' + esc(new Date(state.bootedAt).toISOString()) + '</td></tr>'
    + '<tr><th>newest src file</th><td>' + esc(code.name || '') + ' at ' + esc(code.at ? new Date(code.at).toISOString() : '') + '</td></tr>'
    + '<tr><th>verdict</th><td class="' + (code.at > state.bootedAt ? 'bad' : 'good') + '">' + (code.at > state.bootedAt ? 'STALE: restart to pick up the code' : 'current') + '</td></tr>'
    + '</table>'
    + '<h2>Views</h2><ul>'
    + '<li><a href="/health">/health (JSON)</a></li>'
    + '</ul>'
    + '</body></html>\n';
}

export default { devState, devProblems, devHtml, newestFile, lastRebuilds, DEV_NAMESPACES };
