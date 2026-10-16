/* wiki-surface: the client. One page, an ask box and a viewscreen; the wiki is a
 * drawer, closed by default and remembered. The tree comes from the branch
 * payloads (one fetch per branch, ZERO per record); a record row expands in place
 * and its body is the server's own recordBody, fetched once from /rules/record.
 * The ask goes to the same /rules/ask the old page uses - same retrieval, same
 * judge - and renders the judged findings, the unjudged tail and the one icon. */
(function () {
  'use strict';
  var CFG = window.WIKI_SURFACE || {};
  var DATA = CFG.data || '/rules/data';
  var REC = CFG.record || '/rules/record';
  var ASK = CFG.ask || '/rules/ask';
  var VOTE = CFG.vote || '/rules/vote';
  var ANSWERED = CFG.answered || '/rules/answered';
  var DRAWER_KEY = 'wikiDrawer';
  var ROW_CAP = 500;
  var state = {
    branches: null, branch: null, cache: {}, open: {}, rows: {}, filter: '',
    mode: 'none', record: null, from: '', answer: null, icons: {},
  };
  
  function $(id) { return document.getElementById(id); }
  function el(t, cls, text) { var e = document.createElement(t); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function bookOf(slug) { var i = String(slug || '').indexOf('--'); return i === -1 ? '' : String(slug).slice(0, i); }
  function leafOfId(id) { var s = String(id); var h = s.indexOf('#'); return h === -1 ? s : s.slice(h + 1); }
  function headingLeaf(h) { var p = String(h || '').split(' > ').filter(Boolean); return p.length ? p[p.length - 1] : ''; }
  function titleOf(rec) { if (!rec) return ''; if (rec.title) return rec.title; if (rec.heading) return headingLeaf(rec.heading); return leafOfId(rec.id); }
  // The reader sees a place, not a key. The slug's prefix names the book; the
  // roster gives the faction its display name. Never a raw record id, never a
  // bare source string like 'faction-ac' (the old render removed those too).
  var FACTION_LABELS = { 't-au': 'T\u2019au Empire', 'adeptus-titanicus': 'Adeptus Titanicus' };
  function bookLabel(slug) {
    var b = bookOf(slug);
    if (!b) return '';
    if (b === 'rules') return 'Core Rules';
    if (b === 'missions') return 'Missions';
    if (b.indexOf('faction-') === 0) {
      var s = b.slice(8);
      return FACTION_LABELS[s] || s.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    }
    return b;
  }
  function kindLabel(k) { var s = String(k || '').replace(/-/g, ' '); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  // A snippet cut at the cap gets a marker: 'MAXIMU' with nothing after it reads
  // as the rule's own typo rather than as an excerpt.
  function cut(text, n) {
    var t = String(text == null ? '' : text);
    if (t.length <= n) return t;
    return t.slice(0, n).replace(/\s+$/, '') + '\u2026';
  }
  function snippetOf(rec) {
    var t = String((rec && (rec.excerpt || rec.passage || rec.text)) || '').replace(/\s+/g, ' ').trim();
    return cut(t, 100);
  }
  // The source string is a code ('core-rules', 'rules-appendix'): the reader gets
  // the book's name, so every finding's meta line has the same shape even when the
  // record has no payload page (and therefore no slug).
  var SOURCE_BOOKS = { 'core-rules': 'Core Rules', 'core-stratagems': 'Core Rules', 'rules-appendix': 'Rules appendix', 'event-companion': 'Event companion', 'stratagems': 'Faction rules' };
  function bookFromSource(src) {
    var s = String(src || '');
    if (!s) return '';
    if (SOURCE_BOOKS[s]) return SOURCE_BOOKS[s];
    return kindLabel(s.replace(/^core-/, ''));
  }

  // --- the drawer -----------------------------------------------------------
  function drawerOpen(want) {
    var d = $('sv-drawer'), t = $('sv-drawer-toggle');
    if (!d) return;
    d.classList.toggle('sv-open', !!want);
    d.setAttribute('aria-hidden', want ? 'false' : 'true');
    if (t) t.setAttribute('aria-expanded', want ? 'true' : 'false');
    try { localStorage.setItem(DRAWER_KEY, want ? '1' : '0'); } catch (e) {}
    if (want) openIndex();
  }
  function drawerWanted() { try { return localStorage.getItem(DRAWER_KEY) === '1'; } catch (e) { return false; } }

  // --- the tree -------------------------------------------------------------
  function openIndex() {
    if (state.branches) { renderTree(); return Promise.resolve(); }
    return getJson(DATA + '/index.json').then(function (j) { state.branches = j.branches || []; renderTree(); })
      .catch(function () { renderTree(); });
  }
  function openBranch(key) {
    if (state.branch === key) { state.branch = null; renderTree(); return; }
    if (state.cache[key]) { state.branch = key; renderTree(); return; }
    getJson(DATA + '/index/' + key + '.json').then(function (j) { state.cache[key] = j; state.branch = key; renderTree(); });
  }
  function matches(text) { return !state.filter || String(text || '').toLowerCase().indexOf(state.filter) !== -1; }
  function nodeOpen(key) { return state.open[key] === true; }
  function nodeMatches(n, key) {
    if (!state.filter) return true;
    if (matches(n.n)) return true;
    if ((n.recs || []).some(function (r) { return matches(r.title) || matches(r.snippet) || matches(bookLabel(r.slug)); })) return true;
    return (n.kids || []).some(function (k) { return nodeMatches(k, key + '/' + k.n); });
  }
  function renderTree() {
    var box = $('sv-tree');
    if (!box) return;
    box.textContent = '';
    if (!state.branches) { box.appendChild(el('div', 'sv-loading', 'Loading the wiki...')); return; }
    state.branches.forEach(function (b) {
      var btn = el('button', 'sv-node');
      btn.type = 'button';
      btn.setAttribute('data-branch', b.b);
      btn.appendChild(el('span', 'sv-t', b.n));
      btn.appendChild(el('span', 'sv-c', String(b.c)));
      btn.setAttribute('aria-expanded', state.branch === b.b ? 'true' : 'false');
      btn.addEventListener('click', function () { openBranch(b.b); });
      box.appendChild(btn);
      if (state.branch === b.b && state.cache[b.b]) {
        var tree = el('div', 'sv-branch');
        (state.cache[b.b].kids || []).forEach(function (k) { var child = renderNode(k, b.b + '/' + k.n); if (child) tree.appendChild(child); });
        box.appendChild(tree);
      }
    });
    if (!box.childNodes.length) box.appendChild(el('div', 'sv-empty', 'No matching branches.'));
  }
  function pageFor(n) {
    var branch = state.branch ? state.cache[state.branch] : null;
    if (!branch || !branch.pages) return null;
    return branch.pages.filter(function (p) { return p.n === n.n && p.recs && p.recs.length; })[0] || null;
  }
  function renderNode(n, key) {
    if (!nodeMatches(n, key)) return null;
    var wrap = el('div', 'sv-nodewrap');
    var kids = n.kids || [], recs = n.recs || [], page = !!n.page;
    var btn = el('button', 'sv-node');
    btn.type = 'button';
    btn.setAttribute('data-node', key);
    btn.appendChild(el('span', 'sv-t', n.n));
    if (n.c != null) btn.appendChild(el('span', 'sv-c', String(n.c)));
    var open = state.filter ? true : nodeOpen(key);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.addEventListener('click', function () { state.open[key] = !open; renderTree(); });
    wrap.appendChild(btn);
    if (!open) return wrap;
    var body = el('div', 'sv-recs');
    kids.forEach(function (k) { var child = renderNode(k, key + '/' + k.n); if (child) body.appendChild(child); });
    var shown = recs.filter(function (r) { return matches(r.title) || matches(r.snippet) || matches(bookLabel(r.slug)); });
    shown.slice(0, ROW_CAP).forEach(function (r) { body.appendChild(renderRec(r)); });
    // Never silently: the corpus maximum is 162 rows in one node, so the cap is
    // head-room, not a cut - and if a future payload passes it, the reader is told.
    if (shown.length > ROW_CAP) body.appendChild(el('div', 'sv-empty', (shown.length - ROW_CAP) + ' more not shown.'));
    if (page) {
      var p = pageFor(n);
      if (p) p.recs.forEach(function (id) { body.appendChild(renderRec({ id: id, title: leafOfId(id), slug: '', snippet: '' })); });
    }
    if (!body.childNodes.length) body.appendChild(el('div', 'sv-empty', state.filter ? 'No matching rows.' : 'No records under this node.'));
    wrap.appendChild(body);
    return wrap;
  }
  function renderRec(r) {
    var wrap = el('div', 'sv-recwrap');
    var b = el('button', 'sv-rec');
    b.type = 'button';
    b.setAttribute('data-rec', r.id);
    b.appendChild(el('span', 'sv-rec-title', r.title || leafOfId(r.id)));
    var meta = bookLabel(r.slug);
    if (meta) b.appendChild(el('span', 'sv-rec-meta', meta));
    // The payload caps a row's snippet at 100; a full-length snippet was cut, so
    // the row says so (the payload itself is not touched).
    if (r.snippet) b.appendChild(el('span', 'sv-rec-snip', r.snippet.length >= 100 ? r.snippet + '\u2026' : r.snippet));
    b.addEventListener('click', function (ev) { ev.preventDefault(); toggleInline(r, wrap); });
    wrap.appendChild(b);
    return wrap;
  }
  function toggleInline(r, wrap) {
    var existing = wrap.querySelector('.sv-inline');
    if (existing) { existing.remove(); return; }
    var box = el('div', 'sv-inline');
    box.appendChild(el('div', 'sv-inline-title', r.title || leafOfId(r.id)));
    var meta = [bookLabel(r.slug)].filter(Boolean).join(' \u00b7 ');
    if (meta) box.appendChild(el('div', 'sv-inline-meta', meta));
    var body = el('div', 'sv-inline-body');
    body.appendChild(el('div', 'sv-loading', 'Loading the record...'));
    box.appendChild(body);
    wrap.appendChild(box);
    if (state.rows[r.id]) { body.innerHTML = state.rows[r.id]; return; }
    fetch(REC + '?id=' + encodeURIComponent(r.id) + '&format=html', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (html) { state.rows[r.id] = html; body.innerHTML = html; })
      .catch(function () { body.textContent = 'The record could not be loaded.'; });
  }

  // --- the viewscreen: page mode and the cold deep link ---------------------
  function showPage(record, from) {
    state.mode = 'page';
    state.record = record;
    state.from = from || 'deep';
    var v = $('sv-viewscreen');
    if (!v) return;
    v.textContent = '';
    var cold = state.from === 'deep';
    var back = el('button', 'sv-back', cold ? 'Open the wiki' : '\u2190 Back');
    back.type = 'button';
    back.addEventListener('click', function () { cold ? drawerOpen(true) : closePage(); });
    v.appendChild(back);
    v.appendChild(el('h1', 'sv-page-title', titleOf(record)));
    var meta = [kindLabel(record.kind), bookLabel(record.slug)].filter(Boolean).join(' \u00b7 ');
    if (meta) v.appendChild(el('p', 'sv-page-meta', meta));
    var body = el('div', 'sv-page-body');
    body.appendChild(el('div', 'sv-loading', 'Loading the record...'));
    v.appendChild(body);
    if (state.rows[record.id]) { body.innerHTML = state.rows[record.id]; return; }
    fetch(REC + '?id=' + encodeURIComponent(record.id) + '&format=html', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (html) { state.rows[record.id] = html; body.innerHTML = html; })
      .catch(function () { body.textContent = 'The record could not be loaded.'; });
  }
  function closePage() {
    var from = state.from;
    state.mode = 'none';
    state.record = null;
    state.from = '';
    if (location.hash) { try { history.pushState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
    if (from === 'findings' && state.answer) { renderAnswer(); return; }
    var v = $('sv-viewscreen');
    if (v) v.innerHTML = '<p class=\"sv-hint\">Ask a rules question, or open the wiki to browse.</p>';
  }
  function openSlug(slug, from) {
    var book = bookOf(slug);
    if (!book) return;
    getJson(DATA + '/content/' + book + '.json').then(function (j) {
      var recs = j.records || {};
      var hit = null;
      Object.keys(recs).forEach(function (id) { if (recs[id].slug === slug) hit = recs[id]; });
      if (hit) showPage(hit, from);
      else { var v = $('sv-viewscreen'); if (v) v.textContent = 'No record for ' + slug; }
    }).catch(function () { var v = $('sv-viewscreen'); if (v) v.textContent = 'No record for ' + slug; });
  }
  function fromHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (h && h.indexOf('--') !== -1) { openSlug(h, state.from || 'deep'); return true; }
    return false;
  }

  // --- the ask: the judged findings, the tail, the one icon --------------------
  function ask() {
    drawerOpen(false);
    var q = String(($('sv-q') || {}).value || '').trim();
    var v = $('sv-viewscreen');
    if (q.length < 3) { if (v) { v.textContent = ''; v.appendChild(el('p', 'sv-hint', 'Type a question of at least three characters.')); } return; }
    state.mode = 'ask';
    state.answer = null;
    state.from = '';
    state.icons = {};
    if (v) { v.textContent = ''; v.appendChild(el('h1', 'sv-page-title', 'Findings')); v.appendChild(el('p', 'sv-hint', 'Searching\u2026')); }
    fetch(ASK, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ question: q, mode: 'fast' }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) { state.answer = j; state.mode = 'answer'; renderAnswer(); })
      .catch(function (e) { if (v) { v.textContent = ''; v.appendChild(el('p', 'sv-hint', 'The ask failed: ' + e.message)); } });
  }
  function renderAnswer() {
    var a = state.answer;
    var v = $('sv-viewscreen');
    if (!a || !v) return;
    // (6) An answer must land under the sticky header, not scrolled behind it.
    try { window.scrollTo(0, 0); } catch (e) {}
    v.textContent = '';
    v.appendChild(el('h1', 'sv-page-title', 'Findings'));
    var judged = a.findings || [];
    var tail = a.tail || [];
    var answered = !!(a.judge && a.judge.answered === true) && a.unresolved !== true;
    // With a tail, a refusal is about the TEN, not about the corpus: the copy says
    // what was judged, so the reader does not read it as 'we do not know'.
    var copy = answered
      ? 'The judge says these findings answer the question.'
      : (tail.length ? 'None of the judged findings states the rule. The tail below is further matched, unjudged.' : 'No judged finding states the rule.');
    v.appendChild(el('p', 'sv-verdict', copy));
    if (a.judge && a.judge.why) v.appendChild(el('p', 'sv-why', String(a.judge.why)));
    var list = el('div', 'sv-findings');
    judged.forEach(function (f, i) { list.appendChild(renderFinding(f, i)); });
    if (!judged.length) list.appendChild(el('div', 'sv-empty', 'No judged findings.'));
    v.appendChild(list);
    // 'None of these' is a judgement about the SET, so it sits at the foot.
    var foot = el('div', 'sv-foot');
    var none = el('button', 'sv-btn sv-none', 'None of these');
    none.type = 'button';
    none.setAttribute('data-none', '1');
    // (1) The reader's signal is only reported as landed when the server says it
    // landed. Traces off (the product default) means {ok:true, saved:false}, and
    // then the button says so instead of thanking them for nothing.
    none.addEventListener('click', function () {
      var id = a.traceId;
      if (!id) { none.textContent = 'Not kept (traces off)'; none.disabled = true; return; }
      postJson(ANSWERED, { id: id, none: true }).then(function (r) {
        none.textContent = (r && r.saved === true) ? 'Recorded: none of these' : 'Not kept (traces off)';
        none.disabled = true;
      });
    });
    foot.appendChild(none);
    v.appendChild(foot);
    if (tail.length) {
      var t = el('section', 'sv-tail');
      t.appendChild(el('h2', 'sv-tail-h', 'Also matched, not judged (' + tail.length + ')'));
      // (2) No two rows in one tail may read the same: a repeated heading's chain
      // is usually enough, and the number settles the rest.
      var seen = {};
      tail.forEach(function (f) {
        var row = renderTailRow(f);
        var key = row.textContent;
        if (seen[key]) { row.querySelector('.sv-tail-title').textContent += ' (' + (f.n || '') + ')'; key = row.textContent; }
        seen[key] = true;
        t.appendChild(row);
      });
      v.appendChild(t);
    }
  }
  // (3) Every finding carries the same shape: Kind \u00b7 Book. The book is the slug's
  // prefix, else the faction's display name, else the source's own name - never a
  // bare kind with the book silently missing.
  function sourceLine(f) {
    var kind = f.set === 'factions' ? 'Faction' : (f.set === 'rules' ? 'Rule' : kindLabel(f.set));
    var book = bookLabel(f.slug) || String(f.faction || '') || bookFromSource(f.source) || 'Rules';
    return [kind, book].filter(Boolean).join(' \u00b7 ');
  }
  function renderFinding(f, i) {
    var art = el('article', 'sv-finding');
    var head = el('div', 'sv-finding-head');
    head.appendChild(el('span', 'sv-finding-n', String(f.n || i + 1)));
    var t = el('button', 'sv-finding-title', titleOf(f));
    t.type = 'button';
    t.addEventListener('click', function () { openFinding(f); });
    head.appendChild(t);
    var note = el('span', 'sv-icon-note');
    head.appendChild(iconFor(f, note));
    head.appendChild(note);
    art.appendChild(head);
    var meta = sourceLine(f);
    if (meta) art.appendChild(el('div', 'sv-rec-meta', meta));
    var snip = snippetOf(f);
    if (snip) art.appendChild(el('div', 'sv-rec-snip', snip));
    return art;
  }
  function renderTailRow(f) {
    var row = el('button', 'sv-tail-row');
    row.type = 'button';
    // (2) A bare heading repeats across books - 'INDIRECT SHOOTING' three times -
    // so the row shows the heading's own chain below the first crumb, and the book
    // beside it. The caller appends the number to any two rows that still read the
    // same, so no two rows in one tail can be told apart only by their order.
    var chain = String(f.heading || '').split(' > ').filter(Boolean);
    var title = chain.length > 1 ? chain.slice(1).join(' \u203a ') : (chain[0] || leafOfId(f.id));
    row.appendChild(el('span', 'sv-tail-title', title));
    var meta = sourceLine(f);
    if (meta) row.appendChild(el('span', 'sv-rec-meta', meta));
    row.addEventListener('click', function () { openFinding(f); });
    return row;
  }
  function openFinding(f) {
    if (f.slug) { pushSlug(f.slug); openSlug(f.slug, 'findings'); return; }
    var v = $('sv-viewscreen');
    if (v) v.appendChild(el('p', 'sv-hint', 'This record has no page in the payloads.'));
  }
  function pushSlug(slug) { try { history.pushState({ sv: 1 }, '', '#' + slug); } catch (e) { location.hash = slug; } }
  function iconFor(f, note) {
    var st = state.icons[f.id] || 'neutral';
    var b = el('button', 'sv-icon sv-icon-' + st, st === 'yes' ? '\u2713' : st === 'no' ? '\u2715' : '\u00b7');
    b.type = 'button';
    b.setAttribute('data-icon', f.id);
    b.setAttribute('aria-label', st === 'yes' ? 'This is the one' : st === 'no' ? 'Wrong or irrelevant' : 'Not rated');
    b.addEventListener('click', function () {
      var next = st === 'neutral' ? 'yes' : st === 'yes' ? 'no' : 'neutral';
      state.icons[f.id] = next;
      // (1) Both channels are written, and the note reflects what the server
      // answered - never an unconditional 'Recorded'.
      var a = state.answer || {};
      var id = a.traceId;
      if (next === 'neutral') { if (note) note.textContent = ''; }
      else if (!id) { if (note) note.textContent = 'Not kept (traces off)'; }
      else {
        var jobs = next === 'yes'
          ? [postJson(VOTE, { id: id, vote: 'up' }), postJson(ANSWERED, { id: id, by: f.id })]
          : [postJson(VOTE, { id: id, vote: 'down' }), postJson(ANSWERED, { id: id, none: true })];
        Promise.all(jobs).then(function (rs) {
          var saved = rs.some(function (r) { return r && r.saved === true; });
          if (note) note.textContent = saved ? 'Recorded' : 'Not kept (traces off)';
        });
      }
      b.className = 'sv-icon sv-icon-' + next;
      b.textContent = next === 'yes' ? '\u2713' : next === 'no' ? '\u2715' : '\u00b7';
      b.setAttribute('aria-label', next === 'yes' ? 'This is the one' : next === 'no' ? 'Wrong or irrelevant' : 'Not rated');
      st = next;
    });
    return b;
  }

  function boot() {
    var form = $('sv-ask'), toggle = $('sv-drawer-toggle'), close = $('sv-drawer-close'), filter = $('sv-filter');
    if (toggle) toggle.addEventListener('click', function () { var d = $('sv-drawer'); drawerOpen(!(d && d.classList.contains('sv-open'))); });
    if (close) close.addEventListener('click', function () { drawerOpen(false); });
    if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); ask(); });
    if (filter) filter.addEventListener('input', function () { state.filter = String(filter.value || '').trim().toLowerCase(); renderTree(); });
    window.addEventListener('popstate', function () { if (!fromHash()) closePage(); });
    window.addEventListener('hashchange', function () { fromHash(); });
    drawerOpen(drawerWanted());
    fromHash();
    window.WIKI_SURFACE_LOADED = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
