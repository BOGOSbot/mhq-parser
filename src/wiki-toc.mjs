#!/usr/bin/env node
'use strict';
/**
 * wiki-toc: the two-pane area tree, one implementation for both surfaces.
 *
 * The design is the chosen toc-3-twopanes mockup: a rail of areas (Core Rules and
 * the factions, with their record counts) beside the selected area's tree; a group
 * opens on the first tap and a page opens on the second - a tap on a group never
 * collapses it - and the rail collapses to the current-area chip once an area is
 * picked. The wiki render writes it as shell.js + shell-data.js, so a record page
 * still opens from a folder; the ask page loads the same two files from /wiki/.
 */

// The popup's own CSS, kept apart from the shell's: shell.css reads as two blocks,
// the top bar and then the tree, on the same palette and custom properties.
export const TOC_CSS = [
  ".wtoc{position:fixed;inset:0;z-index:60}",
  ".wtoc.hidden{display:none}",
  ".wscrim{position:absolute;inset:0;background:rgba(6,8,12,.66)}",
  ".wsheet{position:absolute;left:0;right:0;bottom:0;top:64px;background:var(--w-panel);border-top:1px solid var(--w-line);display:flex;flex-direction:column;box-shadow:0 -18px 40px rgba(0,0,0,.55)}",
  ".wshbar{padding:9px 12px 8px;border-bottom:1px solid var(--w-line);display:flex;align-items:center;gap:9px}",
  ".wshtitle{font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}",
  ".wsub{font:10.5px var(--w-mono);color:var(--w-dim)}",
  ".wclose{margin-left:auto;width:30px;height:30px;border:1px solid var(--w-line);border-radius:7px;background:var(--w-panel2);color:var(--w-dim);font-size:13px;cursor:pointer}",
  ".wpanes{flex:1;display:flex;min-height:0}",
  ".wpanes.wrail-off .wrail{display:none}",
  ".wrail{width:132px;flex:0 0 auto;border-right:1px solid var(--w-line);background:#12161d;overflow-y:auto}",
  ".wrailhead{padding:9px 10px 6px;font:9px var(--w-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--w-dim);border-bottom:1px solid #212633}",
  ".wra{display:flex;align-items:center;gap:7px;padding:10px;font-size:12px;color:#c3cbd8;border-bottom:1px solid #1b202a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}",
  ".wra .wdot{width:5px;height:5px;flex:0 0 auto;border-radius:50%;background:#4e596e}",
  ".wra.on{background:var(--w-panel);color:#fff;font-weight:700;border-left:3px solid var(--w-acc);padding-left:7px}",
  ".wra.on .wdot{background:var(--w-acc)}",
  ".wbody{flex:1;min-width:0;display:flex;flex-direction:column}",
  ".wareahdr{padding:10px 12px;border-bottom:1px solid var(--w-line);background:var(--w-panel2)}",
  ".wan{font-size:13.5px;font-weight:700}",
  ".wad{font:10px var(--w-mono);color:var(--w-dim);margin-top:3px}",
  ".wlist{flex:1;overflow-y:auto;overscroll-behavior:contain}",
  ".wrow{display:flex;align-items:center;gap:9px;padding:11px 12px;border-bottom:1px solid #212633;min-height:44px;cursor:pointer}",
  ".wgrp>.wrow{background:var(--w-panel2)}",
  ".wpage .wrow{background:var(--w-panel)}",
  ".wchev{flex:0 0 auto;width:14px;color:var(--w-dim);font-size:12px}",
  ".wgrp.wopen .wchev{transform:rotate(90deg);color:var(--w-acc)}",
  ".wglabel{flex:1;font-size:13.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".wcount{font:10px var(--w-mono);color:var(--w-dim);border:1px solid var(--w-line);border-radius:4px;padding:1px 5px}",
  ".wpdot{flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:#54607a;margin:0 4px}",
  ".wplabel{flex:1;font-size:13px;color:#dbe1eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".where{background:#13203a!important;border-left:3px solid var(--w-acc)}",
  ".where .wplabel{color:#fff;font-weight:700}",
  ".where .wpdot{background:var(--w-acc);width:7px;height:7px}",
  ".wyoutag{font:9px var(--w-mono);color:var(--w-acc);border:1px solid #2f4c78;background:#0f1a2c;border-radius:4px;padding:2px 5px}",
  ".wkids{margin-left:18px;border-left:1px solid #232a38}",
  ".wtreefoot{border-top:1px solid var(--w-line);background:var(--w-panel)}",
  ".wlbl{font:9.5px var(--w-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--w-dim);padding:8px 12px 4px}",
  ".wchips{display:flex;gap:6px;overflow-x:auto;padding:2px 12px 10px}",
  ".wchip{flex:0 0 auto;font-size:11.5px;padding:6px 10px;border-radius:999px;border:1px solid var(--w-line);background:var(--w-panel2);color:var(--w-dim);cursor:pointer}",
  ".wchip.on{color:#0b1020;background:var(--w-acc);border-color:var(--w-acc);font-weight:700}",
].join('\n');

// Each area's tree, built from the corpus and the page map. The area comes from the
// record's OWN url ('factions/adeptus-custodes'), because that is the only field
// every kind carries: a stratagem's source is 'stratagems' and its faction is empty,
// and filing it under Core Rules is the defect this fixes. Fallbacks, in order: the
// record's faction field (the card carries it), then a trailing '(Faction)' in the
// heading, which is how a faction-rule with no url still lands in its own area.
// Anything left over - the ability records and the rule ids with no url and no
// parenthetical - is a core-side record and lands in Core Rules, deliberately.
const GROUP = {
  datasheet: 'Datasheets', unitrules: 'Datasheets', stratagem: 'Stratagems',
  enhancement: 'Enhancements', detachment: 'Detachments', 'faction-rule': 'Faction rules',
  'faction-index': 'Index', rule: 'Rules', 'core-rules': 'Core rules',
  'core-stratagem': 'Core stratagems', 'rules-appendix': 'Appendix', ability: 'Abilities',
  index: 'Index', 'event-companion': 'Event companion',
};
const groupOf = r => GROUP[r.kind] || 'Other';

export function tocData(records, pageOf, factionNames, factionSlug) {
  const names = factionNames || new Map();
  const slugs = factionSlug || new Map();
  const known = new Set();
  for (const n of names.values()) known.add(String(n));
  const areaOf = r => {
    const m = /factions\/([a-z0-9-]+)/i.exec(String(r.url || ''));
    if (m) { const hit = slugs.get(m[1].toLowerCase()); if (hit) return hit; }
    if (r.faction) return String(r.faction);
    const h = /\(([^()]+)\)\s*$/.exec(String(r.heading || ''));
    if (h && known.has(h[1].trim())) return h[1].trim();
    return 'Core Rules';
  };
  const areas = new Map();
  for (const r of records) {
    const a = areaOf(r);
    if (!areas.has(a)) areas.set(a, []);
    areas.get(a).push(r);
  }
  const out = [];
  for (const [name, list] of areas) {
    const groups = new Map();
    for (const r of list) {
      const path = String(r.heading || '').split(' > ').filter(Boolean);
      const leaf = path.length ? path[path.length - 1] : (r.heading || r.id);
      const g = groupOf(r);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ i: r.id, t: leaf, f: pageOf.get(r.id) || '' });
    }
    const g = [];
    for (const [gn, pages] of groups) { pages.sort((a, b) => a.t.localeCompare(b.t)); g.push({ n: gn, c: pages.length, p: pages }); }
    g.sort((a, b) => a.n.localeCompare(b.n));
    out.push({ n: name, c: list.length, g });
  }
  out.sort((a, b) => (a.n === 'Core Rules' ? -1 : b.n === 'Core Rules' ? 1 : a.n.localeCompare(b.n)));
  // The file each area's tree lives in, so a record page loads the index and then
  // exactly one area when the popup opens - not every page in the corpus.
  for (const a of out) a.f = 'toc-' + a.n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.js';
  return { areas: out };
}

// The index a page loads up front: the areas with their counts and the file their
// tree lives in, and nothing else.
export function tocIndex(data) {
  return { areas: data.areas.map(a => ({ n: a.n, c: a.c, f: a.f })) };
}

// The behaviour, one implementation for both surfaces. The rail comes from the
// index; an area's tree is loaded when it is first opened (shell.js is small and
// shell-data.js is only the index - the 788KB payload was the thing every record
// page paid for and most page views never opened).
export const TOC_JS = [
  '(function () {',
  '  var D = window.WIKI_TOC, HERE = window.WIKI_HERE || null, OPEN = window.WIKI_TOC_OPEN || null;',
  '  if (!D || !D.areas || !D.areas.length) return;',
  '  var BASE = window.WIKI_TOC_BASE || \'\';',
  '  var root = null, entry = null, railOpen = true, opened = {};',
  '  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }',
  '  function entryByName(n) { for (var i = 0; i < D.areas.length; i++) if (D.areas[i].n === n) return D.areas[i]; return D.areas[0]; }',
  '  function tree() { return window.WIKI_TOC_AREA && entry && window.WIKI_TOC_AREA.n === entry.n ? window.WIKI_TOC_AREA : null; }',
  '  function hereName() { return HERE && HERE.area ? HERE.area : null; }',
  '  function hereGroup() { var t = tree(); if (!HERE || !t) return \'\'; for (var j = 0; j < t.g.length; j++) { var p = t.g[j].p; for (var k = 0; k < p.length; k++) if (p[k].i === HERE.id) return t.g[j].n; } return \'\'; }',
  '  function load(cb) {',
  '    if (tree()) { cb(); return; }',
  '    var old = document.getElementById(\'wtocdata\'); if (old) old.parentNode.removeChild(old);',
  '    var s = document.createElement(\'script\'); s.id = \'wtocdata\'; s.src = BASE + entry.f;',
  '    s.onload = function () { cb(); };',
  '    s.onerror = function () { window.WIKI_TOC_AREA = { n: entry.n, g: [] }; cb(); };',
  '    document.head.appendChild(s);',
  '  }',
  '  function build() {',
  '    root = el(\'div\', \'wtoc hidden\'); root.id = \'wtoc\';',
  '    var scrim = el(\'div\', \'wscrim\'); scrim.setAttribute(\'data-toc-close\', \'1\');',
  '    var sheet = el(\'div\', \'wsheet\');',
  '    var bar = el(\'div\', \'wshbar\');',
  '    bar.appendChild(el(\'span\', \'wshtitle\', \'Wiki\'));',
  '    bar.appendChild(el(\'span\', \'wsub\', \'two panes\'));',
  '    var x = el(\'button\', \'wclose\', \'\u00d7\'); x.type = \'button\'; x.setAttribute(\'data-toc-close\', \'1\'); x.setAttribute(\'aria-label\', \'Close\');',
  '    bar.appendChild(x);',
  '    var panes = el(\'div\', \'wpanes\'); panes.id = \'wpanes\';',
  '    var foot = el(\'div\', \'wtreefoot\'); foot.id = \'wfoot\';',
  '    sheet.appendChild(bar); sheet.appendChild(panes); sheet.appendChild(foot);',
  '    root.appendChild(scrim); root.appendChild(sheet);',
  '    document.body.appendChild(root);',
  '  }',
  '  function render() {',
  '    if (!entry) return;',
  '    var t = tree() || { n: entry.n, g: [] };',
  '    var panes = root.querySelector(\'#wpanes\');',
  '    panes.className = railOpen ? \'wpanes\' : \'wpanes wrail-off\';',
  '    var rail = el(\'nav\', \'wrail\');',
  '    rail.appendChild(el(\'div\', \'wrailhead\', \'Areas\'));',
  '    for (var i = 0; i < D.areas.length; i++) {',
  '      var a = D.areas[i];',
  '      var r = el(\'div\', \'wra\' + (a.n === entry.n ? \' on\' : \'\'));',
  '      r.setAttribute(\'data-area\', a.n);',
  '      r.appendChild(el(\'span\', \'wdot\'));',
  '      r.appendChild(el(\'span\', null, a.n));',
  '      r.appendChild(el(\'span\', \'wcount\', String(a.c)));',
  '      rail.appendChild(r);',
  '    }',
  '    var body = el(\'div\', \'wbody\');',
  '    var hdr = el(\'div\', \'wareahdr\');',
  '    hdr.appendChild(el(\'div\', \'wan\', t.n));',
  '    var pages = 0; for (var g1 = 0; g1 < t.g.length; g1++) pages += t.g[g1].c;',
  '    hdr.appendChild(el(\'div\', \'wad\', t.g.length + \' sections \u00b7 \' + pages + \' pages\'));',
  '    body.appendChild(hdr);',
  '    var list = el(\'div\', \'wlist\');',
  '    var hg = hereGroup();',
  '    if (!hg && !HERE && t.g.length) opened[t.n + \'|\' + t.g[0].n] = true;',
  '    for (var q = 0; q < t.g.length; q++) {',
  '      var g = t.g[q];',
  '      var open = !!opened[t.n + \'|\' + g.n] || g.n === hg;',
  '      var grp = el(\'div\', \'wgrp\' + (open ? \' wopen\' : \'\'));',
  '      var grow = el(\'div\', \'wrow\'); grow.setAttribute(\'data-group\', g.n);',
  '      grow.appendChild(el(\'span\', \'wchev\', \'\u25b8\'));',
  '      grow.appendChild(el(\'span\', \'wglabel\', g.n));',
  '      grow.appendChild(el(\'span\', \'wcount\', String(g.c)));',
  '      grp.appendChild(grow);',
  '      if (open) {',
  '        var kids = el(\'div\', \'wkids\');',
  '        for (var z = 0; z < g.p.length; z++) {',
  '          var p = g.p[z];',
  '          var isHere = HERE && p.i === HERE.id;',
  '          var pw = el(\'div\', \'wpage\');',
  '          var pr = el(\'div\', \'wrow\' + (isHere ? \' where\' : \'\'));',
  '          pr.setAttribute(\'data-page\', p.i);',
  '          pr.setAttribute(\'data-file\', p.f);',
  '          pr.appendChild(el(\'span\', \'wpdot\'));',
  '          pr.appendChild(el(\'span\', \'wplabel\', p.t));',
  '          if (isHere) pr.appendChild(el(\'span\', \'wyoutag\', \'You are here\'));',
  '          pw.appendChild(pr);',
  '          kids.appendChild(pw);',
  '        }',
  '        grp.appendChild(kids);',
  '      }',
  '      list.appendChild(grp);',
  '    }',
  '    body.appendChild(list);',
  '    panes.textContent = \'\';',
  '    panes.appendChild(rail);',
  '    panes.appendChild(body);',
  '    var foot = root.querySelector(\'#wfoot\');',
  '    foot.textContent = \'\';',
  '    foot.appendChild(el(\'div\', \'wlbl\', \'Area\'));',
  '    var chips = el(\'div\', \'wchips\');',
  '    var chip = el(\'button\', \'wchip on\', t.n);',
  '    chip.type = \'button\'; chip.setAttribute(\'data-rail-open\', \'1\');',
  '    chips.appendChild(chip);',
  '    foot.appendChild(chips);',
  '  }',
  '  function show() { if (!root) build(); root.classList.remove(\'hidden\'); }',
  '  function hide() { if (root) root.classList.add(\'hidden\'); }',
  '  function openAt(name) {',
  '    show();',
  '    entry = entryByName(name || hereName() || OPEN || \'Core Rules\');',
  '    load(function () {',
  '      var hg = hereGroup(); if (hg) opened[entry.n + \'|\' + hg] = true;',
  '      render();',
  '    });',
  '  }',
  '  document.addEventListener(\'click\', function (e) {',
  '    var t = e.target;',
  '    if (t && t.closest && t.closest(\'[data-toc-open]\')) { e.preventDefault(); openAt(); return; }',
  '    if (!root || !t || !t.closest) return;',
  '    if (t.closest(\'[data-toc-close]\')) { hide(); return; }',
  '    if (t.closest(\'[data-rail-open]\')) { railOpen = true; render(); return; }',
  '    var ra = t.closest(\'[data-area]\'); if (ra) { entry = entryByName(ra.getAttribute(\'data-area\')); railOpen = false; load(render); return; }',
  '    var gr = t.closest(\'[data-group]\'); if (gr) { opened[entry.n + \'|\' + gr.getAttribute(\'data-group\')] = true; render(); return; }',
  '    var pg = t.closest(\'[data-page]\'); if (pg) { var f = pg.getAttribute(\'data-file\'); if (f) location.href = f; return; }',
  '  });',
  '  document.addEventListener(\'keydown\', function (e) { if (e.key === \'Escape\') hide(); });',
  '  if (OPEN || (window.WIKI_TOC_ALWAYS)) openAt();',
  '})();',
].join('\n');

export default { TOC_CSS, TOC_JS, tocData, tocIndex };
