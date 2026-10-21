"""task-73: the row-click sweep. Ask questions, expand the residue list, click EVERY row in
both door modes, and classify the surface each tap produces from the state the code sets.

A row the sweep cannot classify is a FAILURE, not a pass. The signals are read from the DOM
the code itself mutates:
  quick mode: openRecord() adds body.recopen and unhides #record  -> surface 'record'
  book mode : revealInTree() either adds .sv-reading to the drawer -> surface 'page',
              or expands .sv-inline inside the tree                -> surface 'inline'
Anything else is 'unclassified' and fails.
"""
import json, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3128'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'workspace/t73-sweep.json'
QUESTIONS = [
    'Can a baneblade have an invulnerable save?',
    'Does a Tech-priest Manipulus give its own unit an invulnerable save?',
    'Can a Wraithguard unit shoot after it Fell Back?',
]
MODES = ['wiki', 'inline']
RESULT = {'base': BASE, 'questions': [], 'rows': [], 'failures': []}

def close_drawer(pg):
    # The drawer is hidden by its OWN classes - sv-open on the aside and sv-drawer-open on
    # the body - and the toggle OPENS it when it is closed, so clicking is not a reliable
    # close. The sweep sets the two classes the client itself toggles.
    pg.evaluate("""() => {
      const d = document.getElementById('sv-drawer');
      if (d) { d.classList.remove('sv-open'); d.setAttribute('aria-hidden', 'true'); }
      document.body.classList.remove('sv-drawer-open');
    }""")
    pg.wait_for_timeout(400)

def classify(pg, mode):
    return pg.evaluate("""(mode) => {
      const body = document.body;
      const rec = document.getElementById('record');
      const recVisible = !!rec && !rec.classList.contains('hidden') && rec.textContent.trim().length > 0;
      const drawer = document.getElementById('sv-drawer') || document.querySelector('.sv-drawer');
      const reading = !!(drawer && drawer.classList.contains('sv-reading')) || !!document.querySelector('.sv-reading');
      const inline = document.querySelectorAll('.sv-inline').length;
      // task-74: the drawer carries data-surface, set where the surface is chosen, so a
      // test reads the code's own answer rather than guessing a selector. The fallback
      // note is the inline mode's one honest exception and is reported as 'page+note'.
      const marked = drawer ? drawer.getAttribute('data-surface') : '';
      const note = !!document.querySelector('.sv-inline-fallback');
      if (mode === 'wiki') {
        if (marked === 'page' && body.classList.contains('sv-drawer-open') && reading) return { surface: 'page', signal: 'data-surface=page + sv-reading' };
        return { surface: 'unclassified', signal: 'marked=' + marked + ' drawer=' + body.classList.contains('sv-drawer-open') + ' reading=' + reading };
      }
      if (marked === 'inline' && inline > 0) return { surface: 'inline', signal: 'data-surface=inline + .sv-inline x' + inline };
      if (marked === 'page' && note) return { surface: 'page+note', signal: 'data-surface=page + fallback note' };
      return { surface: 'unclassified', signal: 'marked=' + marked + ' inline=' + inline + ' note=' + note };
    }""", mode)

with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    pg = b.new_page(viewport={'width': 390, 'height': 844})
    for q in QUESTIONS:
        entry = {'question': q, 'rows': 0, 'used': 0, 'residue': 0}
        pg.goto(BASE + '/rules', wait_until='domcontentloaded', timeout=90000)
        pg.wait_for_timeout(1500)
        # The wiki drawer covers the ask form when it is open; close it first.
        close_drawer(pg)
        pg.fill('#q', q)
        pg.click('#go')
        # wait for the ledger: a used row or a residue toggle means the findings landed
        landed = False
        for i in range(90):
            pg.wait_for_timeout(2000)
            if pg.query_selector('.lrow') or pg.query_selector('.resid'):
                landed = True
                break
        if not landed:
            entry['error'] = 'no findings landed'
            RESULT['questions'].append(entry)
            RESULT['failures'].append({'question': q, 'why': 'no findings landed'})
            continue
        pg.wait_for_timeout(3000)
        # expand the residue list so every row is on screen
        resid = pg.query_selector('.resid')
        if resid:
            try:
                resid.click()
                pg.wait_for_timeout(600)
            except Exception as e:
                pass
        rows = pg.evaluate("""() => Array.from(document.querySelectorAll('.lrow, .rrow')).map((b, i) => ({
          i: i, kind: b.classList.contains('rrow') ? 'residue' : 'used',
          name: (b.querySelector('.lname, .rname') || {}).textContent || ''
        }))""")
        entry['rows'] = len(rows)
        entry['used'] = len([r for r in rows if r['kind'] == 'used'])
        entry['residue'] = len([r for r in rows if r['kind'] == 'residue'])
        RESULT['questions'].append(entry)
        for mode in MODES:
            for r in rows:
                pg.evaluate("(m) => localStorage.setItem('mhq.rules.door', m)", mode)
                # close whatever is open before the tap, so the next classification is this tap's
                pg.keyboard.press('Escape')
                # Only the SURFACE MARKER is cleared, and only so the wait below can tell
                # this tap's choice from the previous one. The DOM itself is left to the
                # app: a sweep that deletes the app's own nodes tests the sweep, not the
                # app (measured - clearing .sv-inline by hand left the drawer showing a
                # page while a new inline existed, a state the app never produces).
                pg.evaluate("() => { const d = document.getElementById('sv-drawer'); if (d) d.removeAttribute('data-surface'); }")
                pg.wait_for_timeout(150)
                # re-query the row (the list may have re-rendered) and click it
                clicked = pg.evaluate("""(i) => {
                  const list = Array.from(document.querySelectorAll('.lrow, .rrow'));
                  if (!list[i]) return false;
                  list[i].click();
                  return true;
                }""", r['i'])
                if not clicked:
                    RESULT['failures'].append({'question': q, 'mode': mode, 'row': r, 'why': 'row disappeared'})
                    continue
                # Wait for THIS tap's surface to be chosen: data-surface is cleared above
                # and set where the surface is picked, so a non-empty value means the
                # classification is about this tap and not the one before it.
                for _ in range(30):
                    pg.wait_for_timeout(250)
                    marked = pg.evaluate("() => { const d = document.getElementById('sv-drawer'); return d ? (d.getAttribute('data-surface') || '') : ''; }")
                    if marked:
                        break
                pg.wait_for_timeout(800)
                c = classify(pg, mode)
                row = {'question': q, 'mode': mode, 'kind': r['kind'], 'name': r['name'][:60], 'surface': c['surface'], 'signal': c['signal']}
                RESULT['rows'].append(row)
                if c['surface'] == 'unclassified':
                    RESULT['failures'].append(row)
        sys.stdout.write('asked: ' + q[:50] + '  rows=' + str(len(rows)) + ' (used ' + str(entry['used']) + ', residue ' + str(entry['residue']) + ')\n')
        sys.stdout.flush()
    b.close()

import os
os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(RESULT, f, indent=1)
sys.stdout.write('\nSWEEP: ' + str(len(RESULT['rows'])) + ' taps, ' + str(len(RESULT['failures'])) + ' failures\n')
for f in RESULT['failures'][:12]:
    sys.stdout.write('  FAIL ' + json.dumps(f)[:200] + '\n')
sys.stdout.write('by surface: ' + json.dumps({s: len([r for r in RESULT['rows'] if r['surface'] == s]) for s in set(r['surface'] for r in RESULT['rows'])}) + '\n')
sys.stdout.write('by mode+kind: ' + json.dumps({m + '/' + k: len([r for r in RESULT['rows'] if r['mode'] == m and r['kind'] == k]) for m in MODES for k in ['used', 'residue']}) + '\n')
