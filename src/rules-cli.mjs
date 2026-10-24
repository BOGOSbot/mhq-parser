#!/usr/bin/env node
// task-37: a CLI for agents, so an agent with shell access can ask this corpus a question
// without writing a script against the HTTP routes. Three verbs:
//
//   rules find <words>     the lexical/heading search - instant, no model, no network
//   rules ask <question>   the full pipeline, read from the local server
//   rules deep <topic>     the same pipeline with the sweep (ask --deep)
//
// WHY THE SPLIT, and it is a deliberate one:
//   find imports the SAME modules the server uses - header-index.mjs's findRows with the
//   same surfaceSlugMap and deliveredIds the /rules/find route passes - so a CLI row and a
//   page row are produced by one function, and the CLI works with no server running and no
//   credentials. That is the whole point of a lexical verb: instant and dependency-free.
//   ask needs the model routes, the vector index and the keys, all of which live in a
//   running server's environment; re-implementing that assembly in a CLI would be a second
//   pipeline that could disagree with the first. So ask/deep POST to the local server and
//   stream its NDJSON, and the CLI renders what the page renders.
//
// The server is 127.0.0.1:8787 unless --server or RULES_SERVER says otherwise.
import fs from 'node:fs';

const USAGE = `rules - ask the 40k rules corpus

  rules find <words>            lexical search over headings. Instant, no model.
  rules ask <question>          the full pipeline: retrieve, rerank, rule on it.
  rules deep <question>         the same with the bounded sweep (slower, wider).

  --json                        one JSON object on stdout, nothing else
  --lang <en|fr>                the language of the answer (default en)
  --server <url>                the local server (default http://127.0.0.1:8787)
  --limit <n>                   rows for find (default 20)
  --help
`;

// --- arguments ---------------------------------------------------------------
// Parsing is separated from doing so the test can pin the shapes without a server.
export function parseArgs(argv) {
  const out = { verb: '', words: [], json: false, lang: 'en', server: '', limit: 20, help: false };
  const args = (argv || []).slice();
  if (!args.length) return out;
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') { out.help = true; return out; }
  out.verb = String(first);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--lang') { out.lang = String(args[++i] || 'en').toLowerCase(); }
    else if (a === '--server') { out.server = String(args[++i] || ''); }
    else if (a === '--limit') { out.limit = Math.max(1, Number(args[++i]) || 20); }
    else out.words.push(a);
  }
  return out;
}

export function serverUrl(o) {
  const fromFlag = o && o.server ? String(o.server) : '';
  const fromEnv = process.env.RULES_SERVER || '';
  const base = fromFlag || fromEnv || 'http://127.0.0.1:8787';
  return base.replace(/\/+$/, '');
}

// --- find: the same function the route calls ---------------------------------
export async function find(o) {
  const q = (o.words || []).join(' ').trim();
  if (!q) throw new Error('find needs words');
  const { findRows } = await import('./header-index.mjs');
  const { deliveredIds } = await import('./rules-corpus.mjs');
  const { surfaceSlugMap } = await import('./wiki-surface.mjs');
  const delivered = deliveredIds();
  return findRows(q, { slugs: surfaceSlugMap(), delivered, cap: o.limit || 20 });
}

// --- ask / deep: the server's own pipeline -----------------------------------
export async function ask(o) {
  const question = (o.words || []).join(' ').trim();
  if (!question) throw new Error(o.verb + ' needs a question');
  const base = serverUrl(o);
  const body = { question, answerLang: o.lang === 'fr' ? 'fr' : 'en', stream: true };
  if (o.verb === 'deep') body.mode = 'deep';
  let res;
  try {
    res = await fetch(base + '/rules/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(1800000) });
  } catch (e) {
    throw new Error('no server at ' + base + ' (' + String((e && e.message) || e) + '). Start it with ./start.ps1, or pass --server.');
  }
  if (!res.ok) throw new Error('server said ' + res.status + ': ' + (await res.text()).slice(0, 200));
  // NDJSON: one JSON object per line. Progress goes to stderr, the result to stdout.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      events.push(ev);
      progress(ev);
    }
  }
  return summarise(events);
}

function progress(ev) {
  const t = String((ev && ev.type) || '');
  if (t === 'findings') process.stderr.write('  findings: ' + ((ev.findings || []).length) + String.fromCharCode(10));
  else if (t === 'agent') process.stderr.write('  agent: ' + (ev.second ? 'second opinion' : 'ruling') + ' in ' + Math.round((ev.elapsedMs || 0) / 1000) + 's' + String.fromCharCode(10));
  else if (t === 'sweep') process.stderr.write('  sweep: ' + ((ev.sweep && ev.sweep.checks ? ev.sweep.checks.length : 0)) + ' check(s)' + String.fromCharCode(10));
  else if (t === 'reconcile') process.stderr.write('  reconcile: ' + (ev.polar ? 'the two agents answered differently' : 'a disagreement') + String.fromCharCode(10));
  else if (t === 'done') process.stderr.write('  done in ' + Math.round((ev.elapsedMs || 0) / 1000) + 's' + String.fromCharCode(10));
}

// The last findings event and the last agent event are the answer: a widening renumbers
// the list and a second opinion follows the first, exactly as the page reads them.
export function summarise(events) {
  const out = { question: '', asked: '', lang: '', findings: [], agent: null, secondAgent: null, disagreement: false, polar: false, sweep: null };
  for (const ev of events || []) {
    if (ev.type === 'findings') out.findings = ev.findings || [];
    else if (ev.type === 'agent') { if (ev.second) out.secondAgent = ev.agent || null; else out.agent = ev.agent || null; }
    else if (ev.type === 'reconcile') { out.disagreement = !!ev.disagreement || true; out.polar = ev.polar === true; }
    else if (ev.type === 'sweep') out.sweep = ev.sweep || null;
    else if (ev.type === 'done') { out.question = ev.question || out.question; out.lang = ev.lang || out.lang; }
  }
  return out;
}

export function renderRows(rows, json) {
  if (json) return JSON.stringify({ rows: (rows && rows.rows) || [], total: (rows && rows.total) || 0 });
  const list = (rows && rows.rows) || [];
  if (!list.length) return 'nothing matched.';
  const lines = list.map((r, i) => String(i + 1).padStart(3) + '. ' + String(r.title || r.id) + '  [' + String(r.kind || '') + '] ' + String(r.id));
  return lines.join(String.fromCharCode(10));
}

export function renderAnswer(a, json) {
  if (json) return JSON.stringify(a);
  const agent = a.agent || {};
  const out = [];
  if (agent.failed === true) out.push('THE CALL FAILED - this is not an answer about the corpus.');
  else if (agent.answered === true) out.push('ANSWER: ' + String(agent.answer || ''));
  else if (agent.answered === false) out.push('NOT ANSWERED: no record states the rule. ' + String(agent.why || ''));
  else out.push('NO RULING.');
  if (agent.quote) out.push('QUOTE: ' + String(agent.quote));
  out.push('FINDINGS: ' + (a.findings || []).length);
  for (const f of (a.findings || []).slice(0, 8)) out.push('  [' + f.n + '] ' + String(f.heading || f.id));
  if (a.secondAgent) out.push('SECOND AGENT: ' + (a.secondAgent.answered === true ? 'answered' : a.secondAgent.answered === false ? 'refused' : 'no ruling'));
  return out.join(String.fromCharCode(10));
}

// --- main --------------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.verb) { process.stdout.write(USAGE); return 0; }
  if (['find', 'ask', 'deep'].indexOf(o.verb) === -1) {
    process.stderr.write('unknown verb: ' + o.verb + String.fromCharCode(10) + USAGE);
    return 2;
  }
  if (!o.words.length) { process.stderr.write(o.verb + ' needs a question.' + String.fromCharCode(10)); return 2; }
  if (o.verb === 'find') {
    process.stdout.write(renderRows(await find(o), o.json) + String.fromCharCode(10));
    return 0;
  }
  process.stdout.write(renderAnswer(await ask(o), o.json) + String.fromCharCode(10));
  return 0;
}

// Only run when executed, so the test can import the parsing and the renderers.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().then(c => { process.exitCode = c; }).catch(e => { process.stderr.write(String((e && e.message) || e) + String.fromCharCode(10)); process.exitCode = 1; });
}