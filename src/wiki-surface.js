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
  // The drawer's search: the server greps its own heading index, so a name typed
  // in the drawer reaches all 6,000+ records without a payload download.
  var FIND = CFG.find || '/rules/find';
  var DRAWER_KEY = 'wikiDrawer';
  var ROW_CAP = 500;
  var state = {
    branches: null, branch: null, cache: {}, open: {}, rows: {}, rowsCache: {}, rowsLoading: {}, filter: '',
    hits: null, searchQ: '', searchTimer: null,
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
  // Drawer mode: the page already has an ask surface of its own (src/rules.html),
  // so the client mounts only the wiki - the drawer and the record sheet - and
  // leaves the ask box, the findings and the passages to the page.
  var DRAWER_MODE = CFG.mode === 'drawer';
  function toggleEl() {
    var sel = String(CFG.toggle || '');
    if (sel && sel.charAt(0) === '#') return document.getElementById(sel.slice(1));
    return $('sv-drawer-toggle');
  }
  function ensureChrome() {
    if (!DRAWER_MODE) return;
    if (!$('sv-drawer')) {
      var aside = el('aside', 'sv-drawer');
      aside.id = 'sv-drawer';
      aside.setAttribute('aria-hidden', 'true');
      aside.setAttribute('aria-label', 'Wiki');
      var head = el('div', 'sv-drawer-head');
      head.appendChild(el('strong', null, 'Wiki'));
      var close = el('button', 'sv-btn sv-close', 'Close');
      close.type = 'button'; close.id = 'sv-drawer-close';
      head.appendChild(close);
      aside.appendChild(head);
      var filter = el('input', 'sv-filter');
      filter.id = 'sv-filter'; filter.type = 'search';
      filter.placeholder = 'Find a rule, unit or stratagem';
      filter.setAttribute('aria-label', 'Find a rule, unit or stratagem');
      filter.setAttribute('autocomplete', 'off');
      aside.appendChild(filter);
      var tree = el('div', 'sv-tree'); tree.id = 'sv-tree'; tree.setAttribute('role', 'tree');
      aside.appendChild(tree);
      document.body.appendChild(aside);
    }
    if (!$('sv-viewscreen') && !$('sv-overlay')) {
      var ov = el('div', 'sv-overlay');
      ov.id = 'sv-overlay';
      ov.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ov);
    }
  }
  // Where a record is shown: the page's own viewscreen when it has one, else the
  // sheet this mode creates (a cold #<slug> must still render the record).
  function stage() { return $('sv-viewscreen') || $('sv-overlay'); }
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
  // The corpus keeps the source's ALL-CAPS emphasis ('FALL-BACK MOVE', 239 mission
  // records): a name is a name, so a title that is entirely upper case is set in
  // title case for display. The data keeps the source; only the screen changes.
  function displayTitle(t) {
    var s = String(t == null ? '' : t).replace(/^\[(.*)\]$/, '$1').trim();
    if (!s || !/[A-Z]/.test(s) || s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|[\s\-\/(\u2019'])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }
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
    var d = $('sv-drawer'), t = toggleEl();
    if (!d) return;
    d.classList.toggle('sv-open', !!want);
    d.setAttribute('aria-hidden', want ? 'false' : 'true');
    // The drawer is the page while it is open: the page's own header hides, so
    // nothing of the drawer sits behind it (at any width).
    document.body.classList.toggle('sv-drawer-open', !!want);
    if (t) t.setAttribute('aria-expanded', want ? 'true' : 'false');
    try { localStorage.setItem(DRAWER_KEY, want ? '1' : '0'); } catch (e) {}
    if (want) { openIndex(); searchLater(); }
    else hideDrawerRecord();
  }
  function drawerWanted() { try { return localStorage.getItem(DRAWER_KEY) === '1'; } catch (e) { return false; } }

  // --- the tree -------------------------------------------------------------
  function openIndex() {
    if (state.branches) { renderTree(); return Promise.resolve(); }
    return getJson(DATA + '/index.json').then(function (j) { state.branches = j.branches || []; renderTree(); })
      .catch(function () { renderTree(); });
  }
  function openBranch(key, anchor) {
    if (state.branch === key) { state.branch = null; renderTree(anchor); return; }
    if (state.cache[key]) { state.branch = key; renderTree(anchor); return; }
    getJson(DATA + '/index/' + key + '.json').then(function (j) { state.cache[key] = j; state.branch = key; renderTree(anchor); });
  }
  function matches(text) { return !state.filter || String(text || '').toLowerCase().indexOf(state.filter) !== -1; }
  function nodeOpen(key) { return state.open[key] === true; }
  function nodeMatches(n, key) {
    if (!state.filter) return true;
    if (matches(n.n)) return true;
    if ((n.recs || []).some(function (r) { return matches(r.title) || matches(r.snippet) || matches(bookLabel(r.slug)); })) return true;
    return (n.kids || []).some(function (k) { return nodeMatches(k, key + '/' + k.n); });
  }
  // The tapped element, found by an attribute value rather than a selector: node keys
  // are heading text and may carry quotes.
  function findByAttr(root, attr, val) {
    var list = root.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < list.length; i++) { if (list[i].getAttribute(attr) === val) return list[i]; }
    return null;
  }
  function renderTree(anchor) {
    var box = $('sv-tree');
    if (!box) return;
    // task-108: the rebuild moves the scroll even when the content above is restored
    // (measured: scrollTop 1725 -> 2250 through one node open). When the caller names
    // the element it acted on, that element is put back where it was.
    var a0 = anchor ? findByAttr(box, anchor.attr, anchor.val) : null;
    var top0 = a0 ? a0.getBoundingClientRect().top : 0;
    box.textContent = '';
    if (!state.branches) { box.appendChild(el('div', 'sv-loading', 'Loading the wiki...')); return; }
    state.branches.forEach(function (b) {
      var btn = el('button', 'sv-node');
      btn.type = 'button';
      btn.setAttribute('data-branch', b.b);
      btn.appendChild(el('span', 'sv-t', b.n));
      btn.appendChild(el('span', 'sv-c', String(b.c)));
      btn.setAttribute('aria-expanded', state.branch === b.b ? 'true' : 'false');
      btn.addEventListener('click', function () { openBranch(b.b, { attr: 'data-branch', val: b.b }); });
      box.appendChild(btn);
      if (state.branch === b.b && state.cache[b.b]) {
        var tree = el('div', 'sv-branch');
        (state.cache[b.b].kids || []).forEach(function (k) { var child = renderNode(k, b.b + '/' + k.n); if (child) tree.appendChild(child); });
        box.appendChild(tree);
      }
    });
    if (!box.childNodes.length) box.appendChild(el('div', 'sv-empty', 'No matching branches.'));
    // task-108: a re-render (opening a chapter, loading rows, filtering) rebuilt the
    // tree and threw the open record away. Expanding a chapter while a record was open
    // therefore closed the body above the tapped header and pulled it out of the screen
    // (reported on 08.05 then 19). The open record is put back in place, so the rebuild
    // leaves the tree's height above the tapped row unchanged.
    restoreInline();
    if (a0) {
      var a1 = findByAttr(box, anchor.attr, anchor.val);
      if (a1) {
        var drift = a1.getBoundingClientRect().top - top0;
        if (drift) box.scrollTop += drift;
        var view = box.getBoundingClientRect();
        if (a1.getBoundingClientRect().top < view.top + 2) a1.scrollIntoView({ block: 'start' });
      }
    }
  }
  function restoreInline() {
    var r = state.openRec;
    if (!r) return;
    var tree = treeEl();
    if (!tree) return;
    var rows = tree.querySelectorAll('.sv-rec'), row = null;
    for (var i = 0; i < rows.length; i++) { if (rows[i].getAttribute('data-rec') === r.id) { row = rows[i]; break; } }
    if (!row || !row.parentNode) { state.openRec = null; return; }
    toggleInline(r, row.parentNode, row.svSiblings);
  }
  // --- finding an entry: the whole rulebook, one field -----------------------
  // The tree asks the reader to know where a rule lives; the field asks only for
  // its name. The server answers from the same heading index the ask page's lookup
  // uses, so a name typed here reaches every book without a payload download, and
  // each row is one tap from its record. The tree keeps filtering under it while
  // the round trip is in flight, so typing never blocks on the network.
  function searchLater() {
    var box = $('sv-filter');
    var q = box ? String(box.value || '').trim() : '';
    if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
    if (q.length < 2) {
      if (state.searchQ) { state.searchQ = ''; state.hits = null; renderTree(); }
      return;
    }
    state.searchTimer = setTimeout(function () { runSearch(q); }, 180);
  }
  function runSearch(q) {
    state.searchQ = q;
    fetch(FIND + '?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) { if (state.searchQ !== q) return; state.hits = j; renderHits(q); })
      .catch(function () { if (state.searchQ !== q) return; state.hits = { rows: [], failed: true }; renderHits(q); });
  }
  function renderHits(q) {
    var box = treeEl();
    if (!box) return;
    box.textContent = '';
    var rows = (state.hits && state.hits.rows) || [];
    var head = el('div', 'sv-hits-head');
    if (rows.length) {
      head.appendChild(el('b', null, String(rows.length)));
      head.appendChild(el('span', null, rows.length === 1 ? ' match' : ' matches'));
      if (state.hits && state.hits.total > rows.length) head.appendChild(el('span', null, ' \u00b7 ' + state.hits.total + ' found'));
    } else if (state.hits && state.hits.failed) {
      head.appendChild(el('b', null, 'Search failed'));
      head.appendChild(el('span', null, ' \u2014 the tree below still works.'));
    } else {
      head.appendChild(el('b', null, 'Nothing'));
      head.appendChild(el('span', null, ' in the index names that.'));
    }
    box.appendChild(head);
    rows.forEach(function (r) {
      var b = el('button', 'sv-hit');
      b.type = 'button';
      b.appendChild(el('span', 'sv-hit-t', displayTitle(r.title)));
      var meta = el('span', 'sv-hit-m');
      var kind = r.kind === 'rule' ? '' : kindLabel(r.kind);
      if (kind) meta.appendChild(el('span', null, kind));
      var book = bookLabel(r.slug);
      if (book) {
        if (kind) meta.appendChild(el('span', null, ' \u00b7 '));
        meta.appendChild(el('span', 'sv-hit-book', book));
      }
      if (r.crumbs && r.crumbs.length) meta.appendChild(el('span', null, ' \u2014 ' + r.crumbs.slice(-2).join(' \u203a ')));
      b.appendChild(meta);
      // A row opens the record it names, over the tree, with the same back stack
      // a link inside a record uses: finding a rule and reading it are one tap.
      b.addEventListener('click', function () {
        recordBySlug(r.slug).then(function (rec) { if (rec) showInDrawer(rec, true); });
      });
      box.appendChild(b);
    });
    if (!rows.length && !(state.hits && state.hits.failed)) {
      var empty = el('div', 'sv-hits-empty', 'Try the name alone \u2014 \u201cTyrannofex\u201d, \u201cRapid Ingress\u201d \u2014 or ask it as a question.');
      var ask = el('a', 'sv-hits-ask', 'Ask it instead');
      ask.href = '#';
      ask.addEventListener('click', function (ev) {
        ev.preventDefault();
        drawerOpen(false);
        var q2 = $('q');
        if (q2) { q2.value = q; q2.focus(); }
      });
      empty.appendChild(document.createElement('br'));
      empty.appendChild(ask);
      box.appendChild(empty);
    }
  }

  // task-81: every faction's page is named 'Army rules', so matching on the name
  // alone gave the FIRST one (Adepta Sororitas) to all 24 factions. The node's own
  // key carries its faction ('branch/alliance/faction/node'): that identifies the
  // page. A page with no area (or no match) falls back to the first, as before.
  function pageFor(n, key) {
    var branch = state.branch ? state.cache[state.branch] : null;
    if (!branch || !branch.pages) return null;
    var list = branch.pages.filter(function (p) { return p.n === n.n && p.recs && p.recs.length; });
    var parts = String(key || '').split('/');
    var area = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (area) {
      var own = list.filter(function (p) { return p.area === area; });
      if (own.length) return own[0];
    }
    return list[0] || null;
  }
  // task-81: a page id or an owned id resolves through the branch's own row map
  // (built for exactly those ids), so it renders with its real title/snippet
  // instead of an id leaf.
  // task-81 step 3b: the rows live in index/<branch>-rows.json now, fetched the
  // first time a page or a detachment is opened and cached per branch, so a plain
  // Factions open never pays for them.
  function loadRows() {
    var b = state.branch;
    if (!b) return Promise.resolve({});
    if (state.rowsCache[b]) return Promise.resolve(state.rowsCache[b]);
    if (state.rowsLoading[b]) return state.rowsLoading[b];
    state.rowsLoading[b] = getJson(DATA + '/index/' + b + '-rows.json').then(function (j) {
      state.rowsCache[b] = (j && j.rows) || {};
      return state.rowsCache[b];
    }).catch(function () { state.rowsCache[b] = {}; return {}; });
    return state.rowsLoading[b];
  }
  function rowFromBranch(id) {
    var b = state.branch;
    var m = (b && state.rowsCache[b]) || {};
    var r = m[id];
    return r ? { id: r.id, slug: r.slug, title: r.title, source: r.source, snippet: r.snippet } : { id: id, title: leafOfId(id), slug: '', snippet: '' };
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
    btn.addEventListener('click', function () { state.open[key] = !open; renderTree({ attr: 'data-node', val: key }); });
    wrap.appendChild(btn);
    if (!open) return wrap;
    var body = el('div', 'sv-recs');
    kids.forEach(function (k) { var child = renderNode(k, key + '/' + k.n); if (child) body.appendChild(child); });
    var shown = recs.filter(function (r) { return matches(r.title) || matches(r.snippet) || matches(bookLabel(r.slug)); });
    // task-103: the rows of one container are the sibling list the reader's bar walks,
    // so they are collected first and handed to every row of that container.
    var rows = shown.slice(0, ROW_CAP);
    if (page) {
      var p = pageFor(n, key);
      if (p) {
        if (!state.rowsCache[state.branch]) {
          body.appendChild(el('div', 'sv-loading', 'Loading the records...'));
          loadRows().then(function () { renderTree(); });
        } else {
          rows = rows.concat(p.recs.map(function (id) { return rowFromBranch(id); }));
        }
      }
    }
    rows.forEach(function (r) { body.appendChild(renderRec(r, rows)); });
    // Never silently: the corpus maximum is 162 rows in one node, so the cap is
    // head-room, not a cut - and if a future payload passes it, the reader is told.
    if (shown.length > ROW_CAP) body.appendChild(el('div', 'sv-empty', (shown.length - ROW_CAP) + ' more not shown.'));
    if (!body.childNodes.length) body.appendChild(el('div', 'sv-empty', state.filter ? 'No matching rows.' : 'No records under this node.'));
    wrap.appendChild(body);
    return wrap;
  }
  function renderRec(r, siblings) {
    var wrap = el('div', 'sv-recwrap');
    var b = el('button', 'sv-rec');
    b.type = 'button';
    b.setAttribute('data-rec', r.id);
    // task-103: the row remembers the container's row list, so the reader's bar can
    // walk to a sibling without re-deriving the tree from the DOM.
    b.svSiblings = siblings || null;
    // task-87/89: the row carries the rule's own number ('01.05 Dice'); the payload's
    // row has a num when the corpus record has a ruleId. task-89: the row is the title
    // only - the book label and the 100-character preview are gone, they repeat the
    // chapter above and cut the text mid-sentence (Mandal, 2026-10-17).
    if (r.num) b.appendChild(el('span', 'sv-rec-num', r.num));
    b.appendChild(el('span', 'sv-rec-title', displayTitle(r.title || leafOfId(r.id))));
    b.addEventListener('click', function (ev) { ev.preventDefault(); toggleInline(r, wrap, siblings); });
    wrap.appendChild(b);
    return wrap;
  }
  // task-103: the reader's own navigation. An open record used to push the next sibling
  // 2,600 px down (measured: the 2,534 px body of '2. Profiles' at 390x844) and its body
  // was 322 px wide of 390, because the tree's rails stack 12 px per level. The bar pins
  // prev/current/next to the top of the scrollport and the box de-indents to the tree's
  // own width, so the next section is one tap at any body length.
  function treeEl() { return $('sv-tree'); }
  function deIndent(box) {
    var tree = treeEl();
    if (!tree || !box) return;
    var cs = window.getComputedStyle(tree);
    var edge = tree.getBoundingClientRect().left + parseFloat(cs.paddingLeft || '0') + parseFloat(cs.borderLeftWidth || '0');
    var d = box.getBoundingClientRect().left - edge;
    if (d > 0) box.style.marginLeft = (-d) + 'px';
  }
  function rowFor(id) {
    var tree = treeEl();
    if (!tree) return null;
    var rows = tree.querySelectorAll('.sv-rec');
    for (var k = 0; k < rows.length; k++) { if (rows[k].getAttribute('data-rec') === id) return rows[k]; }
    return null;
  }
  function openSibling(rec) {
    var row = rowFor(rec.id);
    if (!row || !row.parentNode) return;
    toggleInline(rec, row.parentNode, row.svSiblings);
    if (row.scrollIntoView) row.scrollIntoView({ block: 'start' });
  }
  function sibButton(rec, dir) {
    var b = el('button', 'sv-sib sv-sib-' + dir);
    b.type = 'button';
    b.setAttribute('aria-label', (dir === 'prev' ? 'Previous: ' : 'Next: ') + titleOf(rec));
    b.appendChild(el('span', 'sv-sib-chev', dir === 'prev' ? '\u2039' : '\u203A'));
    b.appendChild(el('span', 'sv-sib-t', titleOf(rec)));
    b.addEventListener('click', function (ev) { ev.preventDefault(); openSibling(rec); });
    return b;
  }
  function siblingBar(r, list, i) {
    var bar = el('div', 'sv-sibbar');
    bar.appendChild(list[i - 1] ? sibButton(list[i - 1], 'prev') : el('span', 'sv-sib-spacer'));
    bar.appendChild(el('span', 'sv-sib-cur', titleOf(r)));
    bar.appendChild(list[i + 1] ? sibButton(list[i + 1], 'next') : el('span', 'sv-sib-spacer'));
    return bar;
  }
  function toggleInline(r, wrap, siblings) {
    var existing = wrap.querySelector('.sv-inline');
    if (existing) { existing.remove(); state.openRec = null; return; }
    // One record at a time: two open bodies made a 4,909 px tree with the first one
    // 2,155 px above the viewport, and the bar removes the reason to keep two. An inline
    // that CONTAINS this row stays: a detachment's enhancements open inside it, and
    // removing the parent would append the child to a detached subtree (found 2026-10-18).
    // task-107: closing the body ABOVE the row just tapped used to drag that row out of
    // the screen (measured: tapped at y=233, landed at y=-105 - 338 px of body removed
    // above it). The tapped row is the reader's place, so it is the anchor: remove the
    // others, then give back exactly the scroll they took. Where the container has no
    // room left to give (the row was near the top), the row is pinned to the top of the
    // scrollport instead of being left under the head.
    var tree = treeEl();
    var anchor = tree ? wrap.getBoundingClientRect().top : 0;
    if (tree) Array.prototype.forEach.call(tree.querySelectorAll('.sv-inline'), function (n) { if (!n.contains(wrap)) n.remove(); });
    if (tree) {
      var drift = wrap.getBoundingClientRect().top - anchor;
      if (drift) {
        tree.scrollTop += drift;
        // Only when the clamp left the row above the scrollport: then it is pinned to
        // the top (where the bar sits) rather than left under the drawer head.
        var view = tree.getBoundingClientRect();
        if (wrap.getBoundingClientRect().top < view.top + 2) wrap.scrollIntoView({ block: 'start' });
      }
    }
    var box = el('div', 'sv-inline');
    var list = siblings || [];
    var at = -1;
    for (var k = 0; k < list.length; k++) { if (list[k] && list[k].id === r.id) { at = k; break; } }
    if (at !== -1 && list.length > 1) box.appendChild(siblingBar(r, list, at));
    // task-87: no inline title or meta - the row above this box IS the header, and
    // printing the title again read as a duplicate 'Dice / Core Rules'. task-103: the
    // bar carries the title instead, because it has to say where the reader is going.
    var body = el('div', 'sv-inline-body');
    body.appendChild(el('div', 'sv-loading', 'Loading the record...'));
    box.appendChild(body);
    // task-81: a detachment owns its enhancements and stratagems; they are rows
    // here, each opening its own record.
    if (r.own && r.own.length) {
      var ownBox = el('div', 'sv-ownlist');
      ownBox.appendChild(el('div', 'sv-owntitle', 'Its enhancements and stratagems (' + r.own.length + ')'));
      var ownRows = null, filled = false;
      var fillOwn = function () {
        if (filled) return;
        filled = true;
        if (!ownRows) ownRows = r.own.map(function (id) { return rowFromBranch(id); });
        ownRows.forEach(function (o) { ownBox.appendChild(renderRec(o, ownRows)); });
      };
      if (state.rowsCache[state.branch]) { fillOwn(); }
      else {
        ownBox.appendChild(el('div', 'sv-loading', 'Loading...'));
        loadRows().then(function () {
          var wait = ownBox.querySelector('.sv-loading'); if (wait) wait.remove();
          fillOwn();
        });
      }
      box.appendChild(ownBox);
    }
    wrap.appendChild(box);
    state.openRec = r;
    deIndent(box);
    if (state.rows[r.id]) { body.innerHTML = faceHtml(r.id) + state.rows[r.id]; wireFaces(body); return; }
    fetch(REC + '?id=' + encodeURIComponent(r.id) + '&format=html', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (html) { state.rows[r.id] = html; loadFaces().then(function () { body.innerHTML = faceHtml(r.id) + html; wireFaces(body); }); })
      .catch(function () { body.textContent = 'The record could not be loaded.'; });
  }

  // task-78: the mission card faces. The corpus owns the bytes; the manifest maps a
  // record id to the face file. The attacker's face is the default because our
  // mission records are the attacker's deck; the defender's is the alternate.
  var ASSET = CFG.asset || '/rules/asset';
  var FACES = null, FACES_LOAD = null;
  function loadFaces() {
    if (FACES_LOAD) return FACES_LOAD;
    FACES_LOAD = getJson(ASSET + '?path=' + encodeURIComponent('missions/sources.json')).then(function (m) {
      var map = {};
      ((m && m.assets) || []).forEach(function (a) {
        if (!a || !a.record_id || !a.file) return;
        if (!map[a.record_id] || a.role === 'attacker') map[a.record_id] = a;
      });
      FACES = map;
      return map;
    }).catch(function () { FACES = {}; return FACES; });
    return FACES_LOAD;
  }
  function wireFaces(root) {
    var f = root && root.querySelector && root.querySelector('.sv-recface');
    if (f) f.addEventListener('click', function () { f.classList.toggle('sv-recface-full'); });
  }
  function faceHtml(id) {
    var a = FACES && FACES[id];
    if (!a) return '';
    return '<img class="sv-recface" loading="lazy" alt="" src="' + ASSET + '?path=' + encodeURIComponent(a.file) + '">';
  }

  // --- the viewscreen: page mode and the cold deep link ---------------------
  function showPage(record, from) {
    state.mode = 'page';
    state.record = record;
    state.from = from || 'deep';
    var v = stage();
    if (!v) return;
    v.classList.add('sv-open');
    v.setAttribute('aria-hidden', 'false');
    v.textContent = '';
    var cold = state.from === 'deep';
    var back = el('button', 'sv-back', cold ? 'Open the wiki' : '\u2190 Back');
    back.type = 'button';
    back.addEventListener('click', function () { cold ? drawerOpen(true) : closePage(); });
    v.appendChild(back);
    v.appendChild(el('h1', 'sv-page-title', displayTitle(titleOf(record))));
    var meta = [kindLabel(record.kind), bookLabel(record.slug)].filter(Boolean).join(' \u00b7 ');
    if (meta) v.appendChild(el('p', 'sv-page-meta', meta));
    var body = el('div', 'sv-page-body');
    body.appendChild(el('div', 'sv-loading', 'Loading the record...'));
    v.appendChild(body);
    if (state.rows[record.id]) { body.innerHTML = faceHtml(record.id) + state.rows[record.id]; wireFaces(body); return; }
    fetch(REC + '?id=' + encodeURIComponent(record.id) + '&format=html', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (html) { state.rows[record.id] = html; loadFaces().then(function () { body.innerHTML = faceHtml(record.id) + html; wireFaces(body); }); })
      .catch(function () { body.textContent = 'The record could not be loaded.'; });
  }
  function closePage() {
    var from = state.from;
    state.mode = 'none';
    state.record = null;
    state.from = '';
    if (location.hash) { try { history.pushState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; } }
    if (from === 'findings' && state.answer) { renderAnswer(); return; }
    var v = stage();
    if (v) {
      if (v.id === 'sv-overlay') { v.classList.remove('sv-open'); v.setAttribute('aria-hidden', 'true'); v.textContent = ''; return; }
      v.innerHTML = '<p class=\"sv-hint\">Ask a rules question, or open the wiki to browse.</p>';
    }
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

  // --- the drawer's own record view (task-104) ---------------------------------
  // A link inside a record body is a slug ('#ignore-modifiers-...'). It used to set the
  // hash, and fromHash() turned it into a PAGE under the drawer: the reader lost the tree
  // and the back button said 'Open the wiki'. A link now stays in the drawer and opens the
  // record it points at, on a stack, so a chain of links reads like a path.
  function drawerStack() { if (!state.dstack) state.dstack = []; return state.dstack; }
  function drawerPanel() {
    var d = $('sv-drawer');
    if (!d) return null;
    var p = $('sv-drawer-record');
    if (!p) {
      p = el('div', 'sv-drawer-record');
      p.id = 'sv-drawer-record';
      p.setAttribute('hidden', '');
      p.setAttribute('aria-label', 'Record');
      d.appendChild(p);
    }
    return p;
  }
  function recordBySlug(slug) {
    var book = bookOf(slug);
    if (!book) return Promise.resolve(null);
    return getJson(DATA + '/content/' + book + '.json').then(function (j) {
      var recs = (j && j.records) || {}, hit = null;
      Object.keys(recs).forEach(function (id) { if (recs[id] && recs[id].slug === slug) hit = recs[id]; });
      return hit;
    }).catch(function () { return null; });
  }
  function showInDrawer(record, push) {
    var d = $('sv-drawer'), panel = drawerPanel(), tree = treeEl();
    if (!d || !panel || !record) return;
    var stack = drawerStack();
    if (push !== false) stack.push(record);
    // Save the tree's place only while it is still visible: a hidden tree reports 0, so
    // saving on every step of a chain would overwrite the place the reader left.
    if (tree && push !== false && !d.classList.contains('sv-reading')) state.treeScroll = tree.scrollTop;
    d.classList.add('sv-reading');
    panel.removeAttribute('hidden');
    panel.textContent = '';
    var back = el('button', 'sv-back sv-drawer-back');
    back.type = 'button';
    back.textContent = '\u2190 ' + (stack.length > 1 ? titleOf(stack[stack.length - 2]) : 'Wiki');
    back.addEventListener('click', function (ev) { ev.preventDefault(); drawerBack(); });
    panel.appendChild(back);
    panel.appendChild(el('h2', 'sv-drawer-title', displayTitle(titleOf(record))));
    var meta = [kindLabel(record.kind), bookLabel(record.slug)].filter(Boolean).join(' \u00b7 ');
    if (meta) panel.appendChild(el('p', 'sv-drawer-meta', meta));
    var body = el('div', 'sv-inline-body');
    body.appendChild(el('div', 'sv-loading', 'Loading the record...'));
    panel.appendChild(body);
    panel.scrollTop = 0;
    if (state.rows[record.id]) { body.innerHTML = faceHtml(record.id) + state.rows[record.id]; wireFaces(body); return; }
    fetch(REC + '?id=' + encodeURIComponent(record.id) + '&format=html', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (html) {
        state.rows[record.id] = html;
        loadFaces().then(function () {
          if (!panel.contains(body)) return;
          body.innerHTML = faceHtml(record.id) + html;
          wireFaces(body);
        });
      })
      .catch(function () { body.textContent = 'The record could not be loaded.'; });
  }
  function drawerBack() {
    var stack = drawerStack();
    stack.pop();
    if (!stack.length) { hideDrawerRecord(); return; }
    showInDrawer(stack[stack.length - 1], false);
  }
  function hideDrawerRecord() {
    var d = $('sv-drawer'), panel = $('sv-drawer-record'), tree = treeEl();
    if (state.dstack) state.dstack.length = 0;
    if (d) d.classList.remove('sv-reading');
    if (panel) { panel.setAttribute('hidden', ''); panel.textContent = ''; }
    // The tree lost its layout while hidden, so its scroll height reads 0 until a reflow:
    // reading it first is what makes the restored offset stick.
    if (tree && state.treeScroll != null) { void tree.scrollHeight; tree.scrollTop = state.treeScroll; }
  }
  // One delegated handler, so every body rendered in the drawer is covered - including
  // the ones fetched after the handler is wired.
  function wireDrawerLinks() {
    var d = $('sv-drawer');
    if (!d || d.svLinksWired) return;
    d.svLinksWired = true;
    d.addEventListener('click', function (ev) {
      var node = ev.target, a = null;
      while (node && node !== d) {
        if (node.tagName === 'A' && node.classList && node.classList.contains('wlink')) { a = node; break; }
        node = node.parentNode;
      }
      if (!a) return;
      var slug = String(a.getAttribute('href') || '').replace(/^#/, '');
      if (slug.indexOf('--') === -1) return;
      ev.preventDefault();
      recordBySlug(slug).then(function (rec) { if (rec) showInDrawer(rec, true); });
    });
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
  // A record's stored text begins with its own heading chain (the corpus writes it
  // in front of the body so the vector carries its context). The finding already
  // prints that chain as crumbs, so the excerpt cuts exactly the longest prefix of
  // it: 'Movement Phase > 3. End of Movement Phase > 09.05.01 More Than One...'
  // becomes the sentence a reader came for. Nothing else in the text is touched.
  function stripHeadingPrefix(text, heading) {
    var segs = String(heading || '').split(' > ').filter(Boolean);
    var t = String(text == null ? '' : text);
    for (var i = segs.length; i > 0; i--) {
      var pre = segs.slice(0, i).join(' > ');
      if (pre && t.indexOf(pre) === 0) {
        var rest = t.slice(pre.length).replace(/^\s*>\s*/, '').trim();
        if (rest) return rest;
        break;
      }
    }
    return t;
  }
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
    ensureChrome();
    wireDrawerLinks();
    var form = $('sv-ask'), toggle = toggleEl(), close = $('sv-drawer-close'), filter = $('sv-filter');
    if (toggle) toggle.addEventListener('click', function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); var d = $('sv-drawer'); drawerOpen(!(d && d.classList.contains('sv-open'))); });
    if (close) close.addEventListener('click', function () { drawerOpen(false); });
    if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); ask(); });
    if (filter) filter.addEventListener('input', function () { state.filter = String(filter.value || '').trim().toLowerCase(); renderTree(); searchLater(); });
    window.addEventListener('popstate', function () { if (!fromHash()) closePage(); });
    window.addEventListener('hashchange', function () { fromHash(); });
    drawerOpen(drawerWanted());
    fromHash();
  
function pickRow(state, ctx) {
  if (!state || !state.traceId) return null;
  var row = el('div', 'pickrow');
  row.appendChild(el('div', 'pickq', ctx.t('pickHelp')));
  var none = el('button', 'picknone' + (state.pick === 'none' ? ' on' : ''), ctx.t('pickNone'));
  none.type = 'button';
  none.setAttribute('aria-pressed', state.pick === 'none' ? 'true' : 'false');
  none.addEventListener('click', function () { ctx.sendPick(state, '', true); });
  row.appendChild(none);
  var note = state.pickSaved === true
    ? (state.pick === 'none' ? ctx.t('pickNoneThanks') : ctx.t('pickThanks'))
    : (state.pickPending ? ctx.t('pickWaiting') : '');
  row.appendChild(el('div', 'picknote', note));
  return row;
}

function isFirsted(state, f) {
  return !!(state && state.selectable && !state.rerun && f && (state.positive || []).indexOf(f.id) !== -1);
}

function isIgnored(state, f) {
  return !!(state && state.selectable && !state.rerun && f && state.keep[f.id] === false);
}

function heroOrder(findings, cited, state, ctx) {
  findings = sortedFindings(findings);
  cited = cited || [];
  var picked = [], citedOnes = [], rest = [], dropped = [];
  for (var j = 0; j < findings.length; j++) {
    var f = findings[j];
    if (isIgnored(state, f)) dropped.push(f);
    else if (isFirsted(state, f)) picked.push(f);
    else if (cited.indexOf(f.n) !== -1) citedOnes.push(f);
    else rest.push(f);
  }
  // The caret's order is the reader's, newest first: the sort is on the record's
  // position in state.positive, not on its rank.
  if (state && state.selectable && !state.rerun) {
    picked.sort(function (a, b) { return state.positive.indexOf(a.id) - state.positive.indexOf(b.id); });
  }
  return picked.concat(citedOnes, rest, dropped);
}

function findingsCard(findings, counts, cited, state, ctx) {
  // Ordered by the rank the retrievers gave them, not by arrival: a widened
  // pass re-renders this card with the wider list, and the order is the whole
  // point of showing it. Each half keeps its own rank order, and the halves
  // stay in the order the server sent them.
  findings = sortedFindings(findings);
  cited = cited || [];
  var title = ctx.t('findingsTitle') + ' - ' + findings.length;
  if (counts) title += ' (' + counts.rules + ctx.t('findingsCounts') + counts.factions + ctx.t('findingsCountsTail') + ')';
  var card = ctx.sectionCard(title);
  if (!findings.length) {
    card.appendChild(el('div', 'note warn', ctx.t('nothingMatchedCard')));
    // Nothing to pick from, but 'none of these' is still an assertion the reader
    // can make - and this is the out-of-corpus case the bank is shortest of.
    var noneOnly = pickRow(state, ctx);
    if (noneOnly) card.appendChild(noneOnly);
    return card;
  }
  // The passages the reader is shown whole whatever their rank: the top five by
  // rank and the passages the verdict rests on. The evidence behind a verdict is
  // never collapsed - the ability that answered a question once sat at rank 15,
  // inside the collapse, while the writer cited it.
  var isCited = function (f) { return cited.indexOf(f.n) !== -1; };
  var prominent = {};
  for (var i = 0; i < findings.length; i++) if (i < 5 || isCited(findings[i])) prominent[findings[i].id] = true;
  var selectable = !!(state && state.selectable && !state.rerun);
  var firsted = function (f) { return isFirsted(state, f); };
  var ignored = function (f) { return isIgnored(state, f); };
  var order = heroOrder(findings, cited, state, ctx);
  var shown = [], behind = [], shownIds = {};
  for (var k = 0; k < order.length; k++) {
    var g = order[k];
    if (prominent[g.id] || firsted(g) || ignored(g)) { shown.push(g); shownIds[g.id] = true; }
  }
  // The more-findings block keeps rank order underneath: the hidden remainder is read
  // after everything shown whole.
  for (var m = 0; m < order.length; m++) if (!shownIds[order[m].id]) behind.push(order[m]);
  var ol = el('ol', 'cites');
  for (var c = 0; c < shown.length; c++) ol.appendChild(findingItem(shown[c], true, isCited(shown[c]), state, ctx));
  card.appendChild(ol);
  if (behind.length) {
    var det = document.createElement('details');
    det.className = 'moref';
    det.appendChild(el('summary', null, ctx.t('moreFindings') + ' (' + behind.length + ')'));
    var ol2 = el('ol', 'cites');
    for (var r = 0; r < behind.length; r++) ol2.appendChild(findingItem(behind[r], false, isCited(behind[r]), state, ctx));
    det.appendChild(ol2);
    card.appendChild(det);
  }
  if (selectable) {
    // The manual rerank footer. The button only exists once the reader has
    // actually changed the selection: a control that re-asks the same list is
    // noise, and an accidental tap must not spend a judge and a writer. The
    // caret's order travels with the ids, so the second answer is written from
    // the passages in the order the reader put them.
    var positive = state.positive || [];
    var kept = [];
    for (var k1 = 0; k1 < state.shownIds.length; k1++) {
      var id1 = state.shownIds[k1];
      if (state.keep[id1] !== false && positive.indexOf(id1) !== -1) kept.push(id1);
    }
    for (var k2 = 0; k2 < state.shownIds.length; k2++) {
      var id2 = state.shownIds[k2];
      if (state.keep[id2] !== false && positive.indexOf(id2) === -1) kept.push(id2);
    }
    var droppedN = state.shownIds.length - kept.length;
    var foot = el('div', 'rerunfoot');
    foot.appendChild(el('div', 'note', ctx.t('rerankHelp')));
    var again = el('button', 'rerunbtn', ctx.t('rerankButton'));
    again.type = 'button';
    again.disabled = !droppedN || !kept.length;
    again.addEventListener('click', function () {
      ctx.rerank({ question: ctx.questionValue(state), asked: state.asked, over: state.traceId, keep: kept, shown: state.shownIds, append: true, english: true });
    });
    foot.appendChild(again);
    card.appendChild(foot);
  }
  var pickFoot = pickRow(state, ctx);
  if (pickFoot) card.appendChild(pickFoot);
  return card;
}

function sortedFindings(list) {
  var halves = ['rules', 'factions'];
  var out = [];
  for (var h = 0; h < halves.length; h++) {
    var part = [];
    for (var i = 0; i < list.length; i++) if ((list[i].set || 'rules') === halves[h]) part.push(list[i]);
    part.sort(function (a, b) { return (a.rank || a.n || 0) - (b.rank || b.n || 0); });
    out = out.concat(part);
  }
  for (var j = 0; j < list.length; j++) if (halves.indexOf(list[j].set || 'rules') === -1) out.push(list[j]);
  return out;
}

function findingItem(f, prominent, cited, state, ctx) {
  var selectable = !!(state && state.selectable && !state.rerun);
  var first = selectable && (state.positive || []).indexOf(f.id) !== -1;
  var ignored = selectable && state.keep[f.id] === false;
  var li = el('li', 'fitem hero' + (prominent ? ' top' : '') + (ignored ? ' dropped' : ''));
  var head = el('div', 'fhead');
  head.appendChild(el('span', 'num', '[' + f.n + ']'));
  if (f.leg) head.appendChild(el('span', 'leg ' + ctx.legClass(f.leg), ctx.legLabel(f.leg)));
  if (cited) head.appendChild(el('span', 'leg cite', ctx.t('citedByJudge')));
  if (first) head.appendChild(el('span', 'leg badgetop', ctx.t('heroTop')));
  if (ignored) head.appendChild(el('span', 'leg badgeign', ctx.t('heroIgnored')));
  var parts = ctx.crumbs(f.heading);
  var a = el('a', 'ftitle', (f.faction ? f.faction + ' - ' : '') + displayTitle(parts.length ? parts[parts.length - 1] : f.heading) + (f.ruleId ? '  (' + f.ruleId + ')' : ''));
  a.href = f.href || f.url; a.target = '_blank'; a.rel = 'noopener';
  // The title opens the record, not the source page: the source is one tap
  // further in, inside the record, where the reader is already looking.
  a.setAttribute('aria-label', ctx.t('recordOpen') + ': ' + a.textContent);
  a.addEventListener('click', function (ev) { ev.preventDefault(); ctx.openRecord(state, f.id); });
  head.appendChild(a);
  if (selectable) head.appendChild(findingControls(state, f, first, ignored, ctx));
  li.appendChild(head);
  // The whole card is the tap target; the controls are not, so a caret or an x
  // is never swallowed by the navigation.
  li.addEventListener('click', function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest('.fctl, .fdev, .flinks, .pickbtn, .ftitle')) return;
    ctx.openRecord(state, f.id);
  });
  if (parts.length > 1) li.appendChild(el('div', 'fcrumbs', parts.slice(0, -1).join(' \u203a ')));
  // One line at rest: the card says what the passage is, and the dev toggle opens
  // the whole record instead of a wall of prose above the answer.
  var p = el('p', 'ftext heroline');
  p.appendChild(ctx.markTerms(stripHeadingPrefix(f.excerpt || '', f.heading), (f.leg === 'lexical' || f.leg === 'both') ? f.matchedTerms : []));
  li.appendChild(p);
  var chips = ctx.linkChips(f);
  if (chips) li.appendChild(chips);
  if (state && state.devOpen && state.devOpen[f.id]) li.appendChild(devPanel(f, state, ctx));
  return li;
}

function findingControls(state, f, first, ignored, ctx) {
  var ctl = el('span', 'fctl');
  var caret = el('button', 'herocaret' + (first ? ' on' : ''), '^');
  caret.type = 'button';
  caret.setAttribute('aria-pressed', first ? 'true' : 'false');
  caret.setAttribute('aria-label', first ? ctx.t('heroCaretOn') : ctx.t('heroCaret'));
  caret.title = caret.getAttribute('aria-label');
  caret.addEventListener('click', function () { ctx.toggleFirst(state, f.id); });
  ctl.appendChild(caret);
  var x = el('button', 'herox' + (ignored ? ' on' : ''), 'x');
  x.type = 'button';
  x.setAttribute('aria-pressed', ignored ? 'true' : 'false');
  x.setAttribute('aria-label', ignored ? ctx.t('heroIgnoreOn') : ctx.t('heroIgnore'));
  x.title = x.getAttribute('aria-label');
  x.addEventListener('click', function () { ctx.toggleIgnore(state, f.id); });
  ctl.appendChild(x);
  var open = !!(state.devOpen && state.devOpen[f.id]);
  var dev = el('button', 'herodev' + (open ? ' on' : ''), '<>');
  dev.type = 'button';
  dev.setAttribute('aria-expanded', open ? 'true' : 'false');
  dev.setAttribute('aria-label', open ? ctx.t('heroDevHide') : ctx.t('heroDev'));
  dev.title = dev.getAttribute('aria-label');
  dev.addEventListener('click', function () { ctx.toggleDev(state, f.id); });
  ctl.appendChild(dev);
  return ctl;
}

function findingMeta(f, ctx) {
  var meta = el('div', 'fmeta');
  meta.appendChild(el('span', null, ctx.t('rankN') + (f.rank || f.n)));
  meta.appendChild(el('span', 'devleg', ctx.t('foundBy') + (ctx.legLabel(f.leg) || ctx.t('legUnknown'))));
  if (f.leg === 'vector' || f.leg === 'both') {
    var sc = el('span', 'score', ctx.t('rankScore') + ctx.fmtScore(f.vectorScore));
    sc.title = ctx.t('rankScoreTitle');
    meta.appendChild(sc);
  }
  if ((f.leg === 'lexical' || f.leg === 'both') && f.matchedTerms && f.matchedTerms.length) {
    meta.appendChild(el('span', 'words', ctx.t('matchedWords') + f.matchedTerms.join(', ')));
  }
  return meta;
}

function devPanel(f, state, ctx) {
  var box = el('div', 'fdev');
  box.appendChild(findingMeta(f, ctx));
  box.appendChild(ctx.passageBody(f));
  // The reader's own 'this passage answered it': an assertion about the answer,
  // one per question, replacing any earlier pick. It sits in the dev view because
  // it is made after reading the passage, and it is NOT the caret or the x - the
  // caret only changes the order, the x only changes what the second answer rests
  // on, and this one is a candidate for the test bank.
  if (state && state.traceId && f.id) {
    var picked = state.pick === f.id;
    var pickBtn = el('button', 'pickbtn' + (picked ? ' on' : ''), ctx.t('pickThis'));
    pickBtn.type = 'button';
    pickBtn.setAttribute('aria-pressed', picked ? 'true' : 'false');
    pickBtn.addEventListener('click', function () { ctx.sendPick(state, f.id, false); });
    box.appendChild(pickBtn);
  }
  var link = el('a', 'psource', ctx.t('openSource'));
  link.href = f.href || f.url; link.target = '_blank'; link.rel = 'noopener';
  box.appendChild(link);
  return box;
}

  // task-80: the findings renderer lives here, not on the page. The page keeps the
  // i18n, the record dialog, the ask transport and the reader's marks; it calls in
  // with a ctx carrying those helpers, so there is exactly one implementation.
  window.WIKI_SURFACE_API = {
    findings: function (host, state, ctx) {
      host.textContent = '';
      host.appendChild(findingsCard(state.findings, state.counts, state.cited, state, ctx));
    },
    findingOrder: function (findings, cited, state, ctx) { return heroOrder(findings, cited, state, ctx); },
    displayTitle: displayTitle,
    controls: function (state, f, ctx) { return findingControls(state, f, isFirsted(state, f), isIgnored(state, f), ctx); },
    meta: function (f, ctx) { return findingMeta(f, ctx); },
  };
  window.WIKI_SURFACE_LOADED = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
