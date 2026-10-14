#!/usr/bin/env node
'use strict';
/**
 * wiki-shell: the product's top bar, shared by the wiki pages and the ask page.
 *
 * The wiki render used to be a light developer shell - a nav of Index / Search /
 * Reading aids over a breadcrumb. It becomes the product: the same top bar the ask
 * page has, over the plain dark record page, with the Wiki control that opens the
 * area tree. The CSS and the markup live here ONCE and are written beside the
 * render (shell.css) and served from there, so the wiki pages and the ask page
 * cannot drift the way the record markup did.
 *
 * Nothing here reads the corpus at request time: the render writes shell.css and
 * shell.js, and a page that opens from a folder still has both.
 */

// The product palette, the same custom properties the ask page uses.
export const SHELL_CSS = [
  ':root{--w-bg:#0f1116;--w-panel:#161a22;--w-panel2:#1c212b;--w-line:#2a3040;--w-txt:#e7eaf0;--w-dim:#8d96a8;--w-acc:#6ea8fe;--w-err:#ef6b6b;--w-ok:#5fbf7f;--w-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  'body.wpage{margin:0;background:var(--w-bg);color:var(--w-txt);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}',
  '.wtop{position:sticky;top:0;z-index:40;background:rgba(15,17,22,.96);border-bottom:1px solid var(--w-line);padding:8px 12px 10px}',
  '.wbrand{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--w-dim)}',
  '.wbrand b{color:var(--w-txt);font-size:14px;letter-spacing:.2px}',
  '.wspacer{flex:1}',
  '.wicon{height:30px;min-width:30px;padding:0 9px;border:1px solid var(--w-line);border-radius:7px;background:var(--w-panel2);color:var(--w-dim);display:inline-flex;align-items:center;justify-content:center;font-size:12px;text-decoration:none;cursor:pointer}',
  '.wicon:hover{color:var(--w-txt);border-color:var(--w-acc)}',
  '.wwiki.on{background:#13203a;border-color:#2f4c78;color:var(--w-acc);font-weight:700}',
  '.wask{display:flex;gap:8px;align-items:center;margin-top:8px}',
  '.wqbox{flex:1;min-width:0;background:var(--w-panel2);border:1px solid var(--w-line);border-radius:8px;padding:9px 10px;font:13.5px system-ui;color:var(--w-txt)}',
  '.wqbox:focus{outline:none;border-color:var(--w-acc)}',
  '.wsend{width:40px;height:40px;flex:0 0 auto;border:0;border-radius:9px;background:var(--w-acc);color:#0b1020;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer}',
  '.wrec{max-width:46rem;margin:0 auto;padding:12px 12px 60px}',
  '.wcrumb{font-size:12px;color:var(--w-dim);margin:2px 0 4px}',
  '.wcrumb a{color:var(--w-dim)}',
  '.wtitle{font-size:19px;font-weight:700;letter-spacing:.2px;margin:2px 0 2px}',
  '.wmeta{font:11px var(--w-mono);color:var(--w-dim);margin:0 0 10px;word-break:break-all}',
  '.wfoot{font-size:12px;color:var(--w-dim);margin:14px 0 0}',
  '.wfoot a{color:var(--w-dim)}',
  '.wdev{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0 0;font-size:12px}',
  '.wdev a{color:var(--w-dim)}',
].join('\n');

// The top bar, one string for both surfaces. `here` is the page the reader is on
// (a wiki page passes its own area so the Wiki control knows what to open).
export function topBar(opts) {
  const o = opts || {};
  const action = o.action || '/rules';
  return '<header class="wtop">'
    + '<div class="wbrand"><b>40k rules</b><span class="wspacer"></span>'
    + '<a class="wicon" href="/">Army lists</a>'
    + '<button type="button" class="wicon wwiki" id="wwiki" data-toc-open aria-expanded="false">Wiki</button>'
    + '</div>'
    + '<form class="wask" method="get" action="' + action + '">'
    + '<input class="wqbox" type="search" name="q" autocomplete="off" placeholder="Ask a rules question" aria-label="Ask a rules question">'
    + '<button class="wsend" type="submit" aria-label="Ask" title="Ask"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></button>'
    + '<a class="wicon" href="/rules?mic=1" aria-label="Ask by voice" title="Ask by voice"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/></svg></a>'
    + '</form>'
    + '</header>';
}

// What a wiki page's head needs: the shell stylesheet, the card stylesheet (the
// card's own, unchanged), and the tree data + behaviour. All four are written
// beside the pages, so the page opens from a folder with no server.
export function shellHead(opts) {
  const o = opts || {};
  const nav = o.nav || '';
  return '<link rel="stylesheet" href="shell.css">\n<link rel="stylesheet" href="card.css">\n' + nav;
}

export default { SHELL_CSS, topBar, shellHead };

