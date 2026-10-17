import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const surface = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const payload = fs.readFileSync(path.join(ROOT, 'src', 'wiki-payload.mjs'), 'utf8');
ok('the inline box no longer prints a duplicate title', surface.indexOf('sv-inline-title') === -1 && surface.indexOf('sv-inline-meta') === -1);
ok('the row prints the number before the title when it has one', /r\.num \? r\.num \+ ' '/.test(surface));
ok('the payload row carries the rule number, and never the chapter\'s own', /if \(raw\.ruleId && raw\.ruleId !== chNum\) out\.num = raw\.ruleId/.test(payload) && !/num: raw\.ruleId \|\| ''/.test(payload));
// The corpus records the number: Dice is 01.05, its children 01.05.01 and 01.05.02.
const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'rules-corpus', 'core-rules.json'), 'utf8'));
// task-90: a section's heading carries its chapter now ('Core Concepts > Dice'), so the
// record is found by its own leaf, not by the whole string.
const dice = (core.sections || []).find(s => String(s.heading || '').split(' > ').pop().trim() === 'Dice');
ok('Dice carries ruleId 01.05', !!dice && dice.ruleId === '01.05');
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'rules-corpus', 'rules-appendix.json'), 'utf8'));
const kids = (app.sections || []).filter(s => /^01\.05\.\d{2}$/.test(String(s.ruleId || '')));
ok('the two numbered children resolve', kids.length >= 2);
// task-88/90: a chapter's lead block is the record whose heading IS the chapter name;
// it carries no number of its own (the chapter header shows it) and sits in its chapter.
const rows = [];
(function walk(n) { for (const r of (n.recs || [])) rows.push(Object.assign({ chapter: n.n }, r)); for (const k of (n.kids || [])) walk(k); })(JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', 'rules.json'), 'utf8')));
const byId = new Map(rows.map(r => [r.id, r]));
const intro05 = byId.get('core-rules#Attack-Sequence');
ok('the 05 lead block is the chapter own record', !!intro05 && intro05.title === 'Attack Sequence' && /05 Attack Sequence/.test(String(intro05.chapter || '')));
ok('and it carries no chapter number of its own', !!intro05 && intro05.num === undefined);
const diceRow = byId.get('core-rules#Dice');
ok('Dice still carries its own 01.05', !!diceRow && diceRow.num === '01.05' && diceRow.title === 'Dice');
const rerolls = byId.get('rules-appendix#Re-rolls');
ok('Re-rolls still carries 01.05.02', !!rerolls && rerolls.num === '01.05.02');
const dupes = rows.filter(r => r.num && String(r.chapter || '').match(/^(\d{2})/) && r.num === /^(\d{2})/.exec(String(r.chapter))[1]);
ok('no row repeats its chapter number', dupes.length === 0);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
