import { readAllCorpus } from '../src/rules-corpus.mjs';

// task-13 (Mandal, 2026-10-19): the corpus routing trio, pinned where it is data
// rather than prose. (a) PULSE JET MOVE is Wazdakka Gutsmek's ability: the
// core-stratagem copy leaves the corpus and the full definition rides the
// datasheet's own ability list. (b) the nine Challenger mission stratagems are
// outside matched play and out of the corpus. (c) the enhancement titles keep
// Mandal's 2026-10-18 form - pinned in test-glossary/test-corpus? (the payload
// tests read the headings). This file is the data half.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const good = JSON.stringify(got) === JSON.stringify(want); if (good) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } };

const all = readAllCorpus();
const core = all.filter(r => r.source === 'core-stratagems');

// (b) the Challenger records are gone, heading and Type alike.
t('no Challenger record is left in the corpus', all.filter(r => /challenger/i.test(String(r.heading || '')) || /Type:\s*Challenger/i.test(String(r.text || ''))).length, 0);

// (a) one movement ability left the core stratagems, and its text is on the datasheet.
t('the core-stratagem copy of PULSE JET MOVE is gone', core.filter(r => /PULSE JET MOVE/i.test(String(r.heading || ''))).length, 0);
const waz = all.filter(r => String(r.id).indexOf('unitrules#000004221') === 0);
const attached = waz.filter(r => /PULSE JET MOVE/.test(String(r.text || '')));
ok('the Wazdakka Gutsmek datasheet carries the full Pulse Jet definition', attached.length === 1
  && /MAXIMUM DISTANCE: Pulse roll \+ 18"/.test(attached[0].text)
  && /BEFORE MOVING: Make a pulse roll/.test(attached[0].text)
  && /AFTER MOVING:/.test(attached[0].text));
ok('the datasheet keeps its own one-line ability too', attached.length === 1 && /Pulse Jet - In your Movement phase/.test(attached[0].text));
ok('the attached definition names its kind', attached.length === 1 && /Ability \(Movement Ability\): PULSE JET MOVE/.test(attached[0].text));

// The trap that made the first cut wrong: the export writes a non-breaking hyphen in
// 'CLOSE\u2011QUARTERS SHOOTING' while the rules page writes an ASCII one. The name
// check folds hyphens, so this core ability is NOT mistaken for a stray.
ok('CLOSE-QUARTERS SHOOTING stays a core record', core.some(r => /CLOSE.QUARTERS SHOOTING/i.test(String(r.heading || ''))));
// 15 movement + 7 shooting before task-13; PULSE JET MOVE is the one that left.
t('the remaining movement and shooting ability definitions are core records', core.filter(r => /Type:\s*(Movement|Shooting) Ability/i.test(String(r.text || ''))).length, 21);

// (c) the enhancement title keeps the 2026-10-18 form with the detachment inside.
const enh = all.filter(r => r.kind === 'enhancement' && /Lucid Eye/i.test(String(r.heading || '')));
ok('an enhancement title still names its kind, faction and detachment', enh.length > 0 && /\(Enhancement - [^,)]+, [^)]+\)$/.test(enh[0].heading));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
