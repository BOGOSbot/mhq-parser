// task-74: one tap, one kind of surface. Mandal's ruling: the SETTING names the rule
// (wiki or inline), and the record no longer decides - a tree row used to get the tree with
// the record inline while anything else got the reading view, which is the defect he hit.
// These pin the modes, the migration and the fallback; the row sweep
// (tests/row-sweep.py) is what proves it on a live page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + ' | got: ' + JSON.stringify(got) + ' | want: ' + JSON.stringify(want)); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const page = fs.readFileSync(path.join(REPO, 'src', 'rules.html'), 'utf8');
const surface = fs.readFileSync(path.join(REPO, 'src', 'wiki-surface.js'), 'utf8');

// --- the setting names the rule ------------------------------------------------
ok('the two buttons are wiki and inline', /data-door="wiki"/.test(page) && /data-door="inline"/.test(page));
ok('the old names are gone', !/data-door="book"/.test(page) && !/data-door="quick"/.test(page));
ok('the English labels are Wiki and Inline', /doorWiki: 'Wiki'/.test(page) && /doorInline: 'Inline'/.test(page));
ok('and the French ones are the same two words', /doorWiki: 'Wiki',\s*\n\s*doorInline: 'Inline'/.test(page));
ok('the old label keys are gone', !/doorBook|doorQuick/.test(page));

// --- the migration: by meaning, not by name ------------------------------------
// A reader who had 'quick' (the record alone) gets wiki, which is the same surface; one who
// had 'book' (the tree with the record inline) gets inline. Nobody is reset to a default.
{
  const m = /function doorMode\(\) \{([\s\S]*?)\n\}/.exec(page);
  const body = m ? m[1] : '';
  ok('the stored value is read first', /localStorage\.getItem\(DOOR_KEY\)/.test(body));
  ok('an already-migrated value is honoured', /saved === 'wiki' \|\| saved === 'inline'/.test(body));
  ok('quick maps to wiki', /saved === 'quick'\) return 'wiki'/.test(body));
  ok('book maps to inline', /saved === 'book'\) return 'inline'/.test(body));
  ok('and the default is wiki, the surface every record has', /return 'wiki';/.test(body));
  ok('the setter stores the two new values only', /setItem\(DOOR_KEY, mode === 'inline' \? 'inline' : 'wiki'\)/.test(page));
}

// --- one tap, one surface ------------------------------------------------------
ok('the door switches on the mode, not on the record', /doorMode\(\) === 'inline'\).*openInline|if \(doorMode\(\) === 'inline'\) openInline\(state, f\);/s.test(page));
ok('wiki mode never consults the tree', /function openPage\(state, f\) \{[\s\S]*?openRecordPage/.test(page));
ok('inline mode goes to the tree', /function openInline\(state, f\) \{[\s\S]*?openRecordInTree/.test(page));
ok('the surface has a page entry point of its own', /function showRecordPage\(f\)/.test(surface) && /openRecordPage: showRecordPage/.test(surface));
ok('and the page entry point does not look at the tree', !/function showRecordPage\(f\) \{[\s\S]{0,400}rowFor\(/.test(surface));

// --- the drawer says which surface it is ---------------------------------------
ok('the drawer carries the surface it was given', /setAttribute\('data-surface', which/.test(surface));
ok('the page marks itself', /markSurface\('page'\)/.test(surface));
ok('the inline marks itself', /markSurface\('inline'\)/.test(surface));
ok('an inline is opened in the tree, not behind the reading view', /classList\.contains\('sv-reading'\)\) hideDrawerRecord\(\)/.test(surface));
ok('and the page closes any inline box left open', /querySelectorAll\('\.sv-inline'\)/.test(surface));

// --- inline mode's one honest exception ----------------------------------------
ok('a record with no place in the tree falls back to the page', /showInDrawer\(recordLike\(f\), true, 'This record has no place in the tree/.test(surface));
ok('the fallback is said in the panel, not injected after it', /if \(note\) panel\.appendChild\(el\('p', 'sv-inline-fallback', note\)\)/.test(surface));
ok('and the fallback marks itself as a page', /markSurface\('page'\);\s*\n\s*state\.inlineFallback = true;/.test(surface));

// --- the row says where the tap goes -------------------------------------------
ok('the finding row names the mode it will open', /doorName = ctx\.doorMode\(state\) === 'inline' \? ctx\.t\('doorInline'\) : ctx\.t\('doorWiki'\)/.test(surface));

// --- the sweep is a real artefact ----------------------------------------------
const sweep = path.join(REPO, 'tests', 'row-sweep.py');
ok('the row sweep ships with the tests', fs.existsSync(sweep));
if (fs.existsSync(sweep)) {
  const py = fs.readFileSync(sweep, 'utf8');
  ok('it clicks every used and residue row', /querySelectorAll\('\.lrow, \.rrow'\)/.test(py));
  ok('it runs both modes', /MODES = \['wiki', 'inline'\]/.test(py));
  ok('it reads the state the code sets, not a guessed selector', /data-surface/.test(py) && /body\.classList\.contains\('recopen'\)|marked === 'page'/.test(py));
  ok('and an unclassifiable row is a failure', /'unclassified'/.test(py) && /RESULT\['failures'\]\.append/.test(py));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
