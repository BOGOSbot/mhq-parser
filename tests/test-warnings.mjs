import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readArmies, summarise, report, signature, instancesOf } from '../src/warnings.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail ? ' - ' + detail : '')); }
}

// A scratch archive: two events, a clean army, an army with a points mismatch
// and no disposition, and a text the parser cannot recognise. The armies are
// written by hand rather than parsed, so the test pins the survey and not the
// list parser.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-warnings-'));
const army = (over) => ({
  name: 'T', faction: 'Xenos - Orks', teamName: null,
  bodyText: 'Char1: 1x Boss (900 pts)\n1x Boyz (900 pts)\n',
  header: { detachment: 'Gladius Task Force', forceDisposition: 'Take and Hold', totalPoints: '1800 pts' },
  units: [{ model: 'Boss', points: 900 }, { model: 'Boyz', points: 900 }],
  ...over,
});
const clean = army({});
const dirty = army({
  name: 'D',
  header: { detachment: 'Gladius Task Force', totalPoints: '1000 pts' },
});
const unclear = {
  name: 'C', faction: 'Orks', teamName: null, bodyText: 'no markers here at all, just prose',
  header: { detachment: 'Gladius Task Force', forceDisposition: 'Take and Hold' }, units: [],
};
fs.writeFileSync(path.join(dir, 'event-a.json'), JSON.stringify({ event: { name: 'Event A', date: '2026-01-01' }, count: 2, players: [dirty, clean] }));
fs.writeFileSync(path.join(dir, 'event-b.json'), JSON.stringify({ event: { name: 'Event B', date: '2026-01-02' }, count: 1, players: [unclear] }));
fs.writeFileSync(path.join(dir, 'not-a-parse.json'), JSON.stringify({ hello: 'world' }));

const { events, armies } = readArmies([{ label: 'scratch', dir }]);
t('read: two events, the stray json skipped', events.length, 2);
t('read: three armies', armies.length, 3);
const instances = instancesOf(armies);
t('read: each warning is one instance', instances.map(i => i.type).sort(), ['disposition', 'mismatch', 'missing-total', 'unrecognized']);
t('read: the source label rides every instance', [...new Set(instances.map(i => i.source))], ['scratch']);
t('read: the mismatch delta is kept', instances.find(i => i.type === 'mismatch').delta, 800);
t('read: the clean army carries nothing', instances.filter(i => i.player === 'T'), []);

const s = summarise(events, armies);
t('summarise: armies', s.armies, 3);
t('summarise: byType', Object.fromEntries(s.byType), { mismatch: 1, disposition: 1, unrecognized: 1, 'missing-total': 1 });
t('summarise: events by warnings', s.byEvent.map(e => [e.name, e.warnings]), [['Event A', 2], ['Event B', 2]]);
t('summarise: the exporter with two armies', Math.max(...[...s.byExporter.values()].map(x => x.armies)), 2);
t('summarise: no signature repeats yet', [...s.bySignature.values()].map(b => b.count), [1, 1, 1, 1]);

const text = report(s, { min: 3 });
ok('report: header', text.startsWith('# Parser warnings\n'), text.slice(0, 40));
ok('report: the counts line', text.includes('2 events, 3 armies, 4 warnings (133.3% of armies)'), text.split('\n')[2]);
ok('report: the repeat threshold is named', text.includes('below the repeat threshold of 3'));
ok('report: the event table', text.includes('| Event A | 2 | 2 |'), text.split('\n').slice(-4).join(' / '));

// The signature is what makes a repeat visible: the arithmetic must not be part
// of it, and neither must the sign, or +5 and -5 read as two complaints.
t('signature: numbers squashed', signature('> \u26a0 points mismatch: declared 2000, parsed 1995 (-5)'), '> points mismatch: declared N, parsed N (N)');
t('signature: the same complaint, other arithmetic', signature('> \u26a0 points mismatch: declared 2000, parsed 1960 (-40)'), '> points mismatch: declared N, parsed N (N)');
t('signature: the sign is not part of it', signature('> \u26a0 points mismatch: declared 1995, parsed 2000 (+5)'), '> points mismatch: declared N, parsed N (N)');

fs.rmSync(dir, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
