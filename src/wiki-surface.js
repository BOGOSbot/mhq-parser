/* wiki-surface: the client. One page, an ask box and a viewscreen; the wiki is a
 * drawer, closed by default and remembered. The tree comes from the branch
 * payloads (one fetch per branch, ZERO per record); a record row expands in place
 * and its body is the server's own recordBody, fetched once from /rules/record. */
(function () {
  'use strict';
  var CFG = window.WIKI_SURFACE || {};
  var DATA = CFG.data || '/rules/data';
  var REC = CFG.record || '/rules/record';
  var DRAWER_KEY = 'wikiDrawer';
  var state = {
    branches: null,            // index.json
    branch: null,              // the branch currently rendered ('rules'|...|null)
    cache: {},                 // branch key -> payload
    open: {},                  // node key -> true
    rows: {},                  // record id -> { html } inline bodies
    filter: '',
    mode: 'none',              // 'none' | 'page' | 'ask'
    record: null,
  };
  
  function $(id) { return document.getElementById(id); }
  function el(t, cls, text) { var e = document.createElement(t); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }
  function bookOf(slug) { var i = slug.indexOf('--'); return i === -1 ? '' : slug.slice(0, i); }

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
    return getJson(DATA + '/index.json').then(function (j) {
      state.branches = j.branches || [];
      renderTree();
    }).catch(function () { renderTree(); });
  }
  function openBranch(key) {
    if (state.branch === key) { state.branch = null; renderTree(); return; }
    if (state.cache[key]) { state.branch = key; renderTree(); return; }
    getJson(DATA + '/index/' + key + '.json').then(function (j) {
      state.cache[key] = j;
      state.branch = key;
      renderTree();
    });
  }
  function matches(text) { return !state.filter || String(text || '').toLowerCase().indexOf(state.filter) !== -1; }
  function nodeOpen(key) { return state.open[key] === true; }

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
        // renderNode returns null for a node the filter hides - never append null.
        (state.cache[b.b].kids || []).forEach(function (k) { var child = renderNode(k, b.b + '/' + k.n); if (child) tree.appendChild(child); });
        box.appendChild(tree);
      }
    });
    if (!box.childNodes.length) box.appendChild(el('div', 'sv-empty', 'No matching branches.'));
  }

  // A node matches when its own label, a row under it, or a descendant matches.
  function nodeMatches(n, key) {
    if (!state.filter) return true;
    if (matches(n.n)) return true;
    if ((n.recs || []).some(function (r) { return matches(r.title) || matches(r.snippet) || matches(r.source); })) return true;
    return (n.kids || []).some(function (k) { return nodeMatches(k, key + '/' + k.n); });
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
    // While filtering, every matching node is open: the filter narrows the tree,
    // and a match buried behind a closed chapter would be invisible.
    var open = state.filter ? true : nodeOpen(key);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.addEventListener('click', function () { state.open[key] = !open; renderTree(); });
    wrap.appendChild(btn);
    if (!open) return wrap;
    var body = el('div', 'sv-recs');
    kids.forEach(function (k) { var child = renderNode(k, key + '/' + k.n); if (child) body.appendChild(child); });
    var rows = recs.slice();
    var shown = rows.filter(function (r) { return matches(r.title) || matches(r.snippet) || matches(r.source); });
    shown.slice(0, 200).forEach(function (r) { body.appendChild(renderRec(r)); });
    // A page node (Army rules) has no nested rows: its ids live in the branch's
    // pages, so a tap still yields rows instead of an empty pane.
    if (page) {
      var p = pageFor(n);
      if (p) p.recs.forEach(function (id) { body.appendChild(renderRec({ id: id, title: leafOfId(id), source: '', snippet: '' })); });
    }
    if (!body.childNodes.length) body.appendChild(el('div', 'sv-empty', state.filter ? 'No matching rows.' : 'No records under this node.'));
    wrap.appendChild(body);
    return wrap;
  }
  function pageFor(n) {
    var branch = state.branch ? state.cache[state.branch] : null;
    if (!branch || !branch.pages) return null;
    return branch.pages.filter(function (p) { return p.n === n.n && p.recs && p.recs.length; })[0] || null;
  }
  function leafOfId(id) { var s = String(id); var h = s.indexOf('#'); return h === -1 ? s : s.slice(h + 1); }
  // The content payload carries the heading, not a title: the reader's name for a
  // record is the heading's own leaf, with the id leaf only as a last resort.
  function titleOf(rec) {
    if (!rec) return '';
    if (rec.title) return rec.title;
    var p = String(rec.heading || '').split(' > ').filter(Boolean);
    return p.length ? p[p.length - 1] : leafOfId(rec.id);
  }

  function renderRec(r) {
    var wrap = el('div', 'sv-recwrap');
    var b = el('button', 'sv-rec');
    b.type = 'button';
    b.setAttribute('data-rec', r.id);
    b.appendChild(el('span', 'sv-rec-title', r.title || leafOfId(r.id)));
    var meta = [r.source, r.snippet ? '' : ''].filter(Boolean).join(' · ').trim();
    if (meta) b.appendChild(el('span', 'sv-rec-meta', meta));
    if (r.snippet) b.appendChild(el('span', 'sv-rec-snip', r.snippet));
    b.addEventListener('click', function (ev) { ev.preventDefault(); toggleInline(r, wrap); });
    wrap.appendChild(b);
    return wrap;
  }
  function toggleInline(r, wrap) {
    var existing = wrap.querySelector('.sv-inline');
    if (existing) { existing.remove(); return; }
    var box = el('div', 'sv-inline');
    // Heading and meta render here, inside the tree: the record body from the
    // server is the body only, and the row already knows the title and source.
    // The body goes in its OWN child: filling the box itself would wipe the head.
    box.appendChild(el('div', 'sv-inline-title', r.title || leafOfId(r.id)));
    var meta = [r.source, r.id].filter(Boolean).join(' \u00b7 ');
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
  function showPage(record) {
    state.mode = 'page';
    state.record = record;
    var v = $('sv-viewscreen');
    if (!v) return;
    v.textContent = '';
    var back = el('button', 'sv-back', '\u2190 Back to the wiki');
    back.type = 'button';
    back.addEventListener('click', function () { closePage(); });
    v.appendChild(back);
    v.appendChild(el('h1', 'sv-page-title', titleOf(record)));
    var meta = [record.kind, record.source, record.set].filter(Boolean).join(' \u00b7 ');
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
    state.mode = 'none';
    state.record = null;
    if (location.hash) { try { history.pushState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
    var v = $('sv-viewscreen');
    if (v) v.innerHTML = '<p class="sv-hint">Ask a rules question, or open the wiki to browse.</p>';
  }
  function openSlug(slug) {
    var book = bookOf(slug);
    if (!book) return;
    getJson(DATA + '/content/' + book + '.json').then(function (j) {
      var recs = j.records || {};
      var hit = null;
      Object.keys(recs).forEach(function (id) { if (recs[id].slug === slug) hit = recs[id]; });
      if (hit) showPage(hit);
      else { var v = $('sv-viewscreen'); if (v) v.textContent = 'No record for ' + slug; }
    }).catch(function () { var v = $('sv-viewscreen'); if (v) v.textContent = 'No record for ' + slug; });
  }
  function fromHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (h && h.indexOf('--') !== -1) { openSlug(h); return true; }
    return false;
  }

  // --- the ask box (slice 3 runs the search) --------------------------------
  function ask() {
    drawerOpen(false);
    state.mode = 'ask';
    var v = $('sv-viewscreen');
    if (v) {
      v.textContent = '';
      v.appendChild(el('h1', 'sv-page-title', 'Findings'));
      v.appendChild(el('p', 'sv-hint', 'The ask runs in slice 3. This slice delivers the surface: the box, the viewscreen and the wiki drawer.'));
    }
  }

  function boot() {
    var form = $('sv-ask'), q = $('sv-q'), toggle = $('sv-drawer-toggle'), close = $('sv-drawer-close'), filter = $('sv-filter');
    if (toggle) toggle.addEventListener('click', function () { drawerOpen(!($('sv-drawer') || {}).classList || !$('sv-drawer').classList.contains('sv-open')); });
    if (close) close.addEventListener('click', function () { drawerOpen(false); });
    if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); ask(); });
    if (q) q.addEventListener('input', function () { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 128) + 'px'; });
    if (filter) filter.addEventListener('input', function () { state.filter = String(filter.value || '').trim().toLowerCase(); renderTree(); });
    window.addEventListener('popstate', function () { if (!fromHash()) closePage(); });
    window.addEventListener('hashchange', function () { fromHash(); });
    // The drawer is closed by default: only a remembered OPEN reopens it, and only
    // this page's own control changes that - the page never opens it by itself.
    drawerOpen(drawerWanted());
    if (!fromHash()) { /* the viewscreen keeps its hint */ }
    window.WIKI_SURFACE_LOADED = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
