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

// The areas and each area's tree, built from the corpus and the page map. Core
// Rules is the rules half; an area is one faction, and the corpus writes its
// source as faction-<csv id> while the CSV owns the display name.
export function tocData(records, pageOf, factionNames) {
  const names = factionNames || new Map();
  const areaOf = r => {
    if (r.set === 'rules') return 'Core Rules';
    const m = /^faction-([A-Za-z]+)$/.exec(String(r.source || ''));
    if (!m) return 'Core Rules';
    for (const [id, name] of names) if (String(id).toLowerCase() === m[1].toLowerCase()) return name;
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
      const g = path.length > 1 ? path[0] : 'Pages';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ i: r.id, t: leaf, f: pageOf.get(r.id) || '' });
    }
    const g = [];
    for (const [gn, pages] of groups) { pages.sort((a, b) => a.t.localeCompare(b.t)); g.push({ n: gn, c: pages.length, p: pages }); }
    g.sort((a, b) => a.n.localeCompare(b.n));
    out.push({ n: name, c: list.length, g });
  }
  out.sort((a, b) => (a.n === 'Core Rules' ? -1 : b.n === 'Core Rules' ? 1 : a.n.localeCompare(b.n)));
  return { areas: out };
}

// The behaviour. One implementation: the wiki pages and the ask page both load
// this file (shell.js / /wiki/shell.js). Unquoted-attribute-free on purpose -
// every element is built, never a string of HTML - so the file needs no escaping.
export const TOC_JS = [
  "(function () {",
  "  var D = window.WIKI_TOC, HERE = window.WIKI_HERE || null, OPEN = window.WIKI_TOC_OPEN || null;",
  "  if (!D || !D.areas || !D.areas.length) return;",
  "  var root = null, area = null, railOpen = true, opened = {};",
  "  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }",
  "  function areaByName(n) { for (var i = 0; i < D.areas.length; i++) if (D.areas[i].n === n) return D.areas[i]; return D.areas[0]; }",
  "  function hereArea() { if (!HERE) return null; for (var i = 0; i < D.areas.length; i++) { var a = D.areas[i]; for (var j = 0; j < a.g.length; j++) { var p = a.g[j].p; for (var k = 0; k < p.length; k++) if (p[k].i === HERE.id) return a; } } return null; }",
  "  function hereGroup(a) { if (!HERE || !a) return ''; for (var j = 0; j < a.g.length; j++) { var p = a.g[j].p; for (var k = 0; k < p.length; k++) if (p[k].i === HERE.id) return a.g[j].n; } return ''; }",
  "  function build() {",
  "    root = el('div', 'wtoc hidden'); root.id = 'wtoc';",
  "    var scrim = el('div', 'wscrim'); scrim.setAttribute('data-toc-close', '1');",
  "    var sheet = el('div', 'wsheet');",
  "    var bar = el('div', 'wshbar');",
  "    bar.appendChild(el('span', 'wshtitle', 'Wiki'));",
  "    bar.appendChild(el('span', 'wsub', 'two panes'));",
  "    var x = el('button', 'wclose', '\\u00d7'); x.type = 'button'; x.setAttribute('data-toc-close', '1'); x.setAttribute('aria-label', 'Close');",
  "    bar.appendChild(x);",
  "    var panes = el('div', 'wpanes'); panes.id = 'wpanes';",
  "    var foot = el('div', 'wtreefoot'); foot.id = 'wfoot';",
  "    sheet.appendChild(bar); sheet.appendChild(panes); sheet.appendChild(foot);",
  "    root.appendChild(scrim); root.appendChild(sheet);",
  "    document.body.appendChild(root);",
  "  }",
  "  function render() {",
  "    if (!area) return;",
  "    var panes = root.querySelector('#wpanes');",
  "    panes.className = railOpen ? 'wpanes' : 'wpanes wrail-off';",
  "    var rail = el('nav', 'wrail');",
  "    rail.appendChild(el('div', 'wrailhead', 'Areas'));",
  "    for (var i = 0; i < D.areas.length; i++) {",
  "      var a = D.areas[i];",
  "      var r = el('div', 'wra' + (a === area ? ' on' : ''));",
  "      r.setAttribute('data-area', a.n);",
  "      r.appendChild(el('span', 'wdot'));",
  "      r.appendChild(el('span', null, a.n));",
  "      rail.appendChild(r);",
  "    }",
  "    var body = el('div', 'wbody');",
  "    var hdr = el('div', 'wareahdr');",
  "    hdr.appendChild(el('div', 'wan', area.n));",
  "    var groups = area.g.length, pages = 0;",
  "    for (var g1 = 0; g1 < area.g.length; g1++) pages += area.g[g1].c;",
  "    hdr.appendChild(el('div', 'wad', groups + ' sections \\u00b7 ' + pages + ' pages'));",
  "    body.appendChild(hdr);",
  "    var list = el('div', 'wlist');",
  "    var hg = hereGroup(area);",
  "    for (var q = 0; q < area.g.length; q++) {",
  "      var g = area.g[q];",
  "      var open = !!opened[area.n + '|' + g.n] || g.n === hg;",
  "      var grp = el('div', 'wgrp' + (open ? ' wopen' : ''));",
  "      var grow = el('div', 'wrow'); grow.setAttribute('data-group', g.n);",
  "      grow.appendChild(el('span', 'wchev', '\\u25b8'));",
  "      grow.appendChild(el('span', 'wglabel', g.n));",
  "      grow.appendChild(el('span', 'wcount', String(g.c)));",
  "      grp.appendChild(grow);",
  "      if (open) {",
  "        var kids = el('div', 'wkids');",
  "        for (var z = 0; z < g.p.length; z++) {",
  "          var p = g.p[z];",
  "          var isHere = HERE && p.i === HERE.id;",
  "          var pw = el('div', 'wpage');",
  "          var pr = el('div', 'wrow' + (isHere ? ' where' : ''));",
  "          pr.setAttribute('data-page', p.i);",
  "          pr.setAttribute('data-file', p.f);",
  "          pr.appendChild(el('span', 'wpdot'));",
  "          pr.appendChild(el('span', 'wplabel', p.t));",
  "          if (isHere) pr.appendChild(el('span', 'wyoutag', 'You are here'));",
  "          pw.appendChild(pr);",
  "          kids.appendChild(pw);",
  "        }",
  "        grp.appendChild(kids);",
  "      }",
  "      list.appendChild(grp);",
  "    }",
  "    body.appendChild(list);",
  "    panes.textContent = '';",
  "    panes.appendChild(rail);",
  "    panes.appendChild(body);",
  "    var foot = root.querySelector('#wfoot');",
  "    foot.textContent = '';",
  "    foot.appendChild(el('div', 'wlbl', 'Area'));",
  "    var chips = el('div', 'wchips');",
  "    var chip = el('button', 'wchip on', area.n);",
  "    chip.type = 'button'; chip.setAttribute('data-rail-open', '1');",
  "    chips.appendChild(chip);",
  "    foot.appendChild(chips);",
  "  }",
  "  function show() { if (!root) build(); root.classList.remove('hidden'); }",
  "  function hide() { if (root) root.classList.add('hidden'); }",
  "  function openAt(name) {",
  "    show();",
  "    area = areaByName(name || (hereArea() ? hereArea().n : (OPEN || 'Core Rules')));",
  "    var hg = hereGroup(area); if (hg) opened[area.n + '|' + hg] = true;",
  "    render();",
  "  }",
  "  document.addEventListener('click', function (e) {",
  "    var t = e.target;",
  "    if (t && t.closest && t.closest('[data-toc-open]')) { e.preventDefault(); openAt(); return; }",
  "    if (!root || !t || !t.closest) return;",
  "    if (t.closest('[data-toc-close]')) { hide(); return; }",
  "    if (t.closest('[data-rail-open]')) { railOpen = true; render(); return; }",
  "    var ra = t.closest('[data-area]'); if (ra) { area = areaByName(ra.getAttribute('data-area')); railOpen = false; render(); return; }",
  "    var gr = t.closest('[data-group]'); if (gr) { opened[area.n + '|' + gr.getAttribute('data-group')] = true; render(); return; }",
  "    var pg = t.closest('[data-page]'); if (pg) { var f = pg.getAttribute('data-file'); if (f) location.href = f; return; }",
  "  });",
  "  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });",
  "  if (OPEN) openAt();",
  "})();",
].join('\n');

export default { TOC_CSS, TOC_JS, tocData };
