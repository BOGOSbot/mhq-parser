import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGdmChangelog, compareDataVersion, describeCanon, isoDate, fetchGdmChangelog, parseFactionBreakdown, mergeChangelogs } from '../src/gdm-changelog.mjs';
import { downloadMfmDump, dumpVersionOf } from '../src/mfm-factions.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'fixtures', 'gdm-changelog-2026-10-28.html'), 'utf8');

// The picker is the contract: every data version, newest first, with its date
// and its Core Rules change count.
const p = parseGdmChangelog(html);
t('latest is the top option', p.latest, 995);
t('fifteen data versions', p.versions.length, 15);
t('newest first', p.versions.map(v => v.version).slice(0, 3), [995, 981, 972]);
t('a version row', p.versions[1], { version: 981, date: '14 Oct 2026', iso: '2026-10-14', changes: 16 });
t('singular "change" reads', p.versions[0].changes, 1);
t('the PDF baseline is kept apart', p.baseline, { label: 'The Core Rules PDF', date: '18 Jun 2026', iso: '2026-06-18', notes: 5 });
t('isoDate', [isoDate('2 Sep 2026'), isoDate('nonsense')], ['2026-09-02', '']);

// Entities instead of the literal middle dot, and option order shuffled.
const encoded = '<select><option value="900">Data version 900 &middot; 1 Jan 2027 &middot; 3 changes</option><option value="1003">Data version 1003 &#183; 2 Feb 2027 &#183; 7 changes</option></select>';
const e = parseGdmChangelog(encoded);
t('entities decode, order is by number not by page', [e.latest, e.versions[0].changes, e.versions[1].iso], [1003, 7, '2027-01-01']);

// A layout change is an error, never "current".
let threw = '';
try { parseGdmChangelog('<html><body>Core Rules Data Changelog</body></html>'); } catch (err) { threw = err.message; }
ok('a page with no versions throws', /no data versions/.test(threw));
threw = '';
try { parseGdmChangelog('<option value="995">Data version 994 · 1 Jan 2026 · 1 change</option>'); } catch (err) { threw = err.message; }
ok('a value that disagrees with its label is not read', /no data versions/.test(threw));

// The comparison: one integer against one integer.
t('current', compareDataVersion('995', p).state, 'current');
const b = compareDataVersion('963', p);
t('behind names what was missed', [b.state, b.missed.map(v => v.version), b.changes], ['behind', [995, 981, 972], 17]);
t('ahead', compareDataVersion('1001', p).state, 'ahead');
t('no stamp is unknown, not current', [compareDataVersion('', p).state, compareDataVersion('June 2026', p).state], ['unknown', 'unknown']);
ok('the behind line names the versions', /BEHIND.*v981 2026-10-14 \(16\)/.test(describeCanon(b)));

// The fetch is injectable, and a failing fetch surfaces as an error.
t('fetch through an injected reader', (await fetchGdmChangelog({ fetchText: async () => html })).latest, 995);
threw = '';
try { await fetchGdmChangelog({ fetchText: async () => { throw new Error('HTTP 503'); } }); } catch (err) { threw = err.message; }
t('a fetch failure propagates', threw, 'HTTP 503');

// The faction changelog: the same picker, its own counts, and the latest
// version's per-faction headers.
const fhtml = fs.readFileSync(path.join(here, 'fixtures', 'gdm-faction-changelog-2026-10-28.html'), 'utf8');
const f = parseGdmChangelog(fhtml);
t('faction picker reads', [f.latest, f.versions.length, f.versions[3].changes, f.baseline], [995, 15, 5990, null]);
const bd = parseFactionBreakdown(fhtml);
t('breakdown names the latest version', bd.version, 995);
t('breakdown: eight factions, 24 changes', [bd.factions.length, bd.factions.reduce((n, x) => n + x.changes, 0)], [8, 24]);
t('a breakdown row', bd.factions[3], { slug: 'blood-angels', name: 'Blood Angels', changes: 2, units: 1 });
t('singular change and unit read', bd.factions[4], { slug: 'dark-angels', name: 'Dark Angels', changes: 1, units: 1 });
t('a page with no sections has no breakdown', parseFactionBreakdown(html).factions.length, 0);

// The merge: one row per version, both counts side by side.
const both = mergeChangelogs(p, f);
t('merged latest and pages', [both.latest, both.pages], [995, { rules: true, factions: true }]);
const v981 = both.versions.find(v => v.version === 981);
t('a merged row carries both counts', [v981.rules, v981.factions, v981.changes], [16, 573, 589]);
const onlyFactions = mergeChangelogs(null, f);
t('one page is enough', [onlyFactions.latest, onlyFactions.pages, onlyFactions.versions[0].rules], [995, { rules: false, factions: true }, null]);
threw = '';
try { mergeChangelogs(null, null); } catch (err) { threw = err.message; }
ok('no page at all throws', /neither page/.test(threw));
const behindBoth = compareDataVersion('972', both);
t('behind over the merge counts both sides', [behindBoth.missed.map(v => v.version), behindBoth.changes], [[995, 981], 1 + 24 + 16 + 573]);
ok('the line splits rules and factions', /v981 2026-10-14 \(rules 16, factions 573\)/.test(describeCanon(behindBoth)));
// A version on the faction page that the rules page has not listed yet still counts.
const ahead = mergeChangelogs(p, parseGdmChangelog(fhtml.replace('<option value="995" selected="">', '<option value="1003">Data version 1003 · 4 Nov 2026 · 40 changes</option><option value="995" selected="">')));
t('a newer version on one page wins', [ahead.latest, ahead.versions[0].rules, ahead.versions[0].factions], [1003, null, 40]);

// The dump download swaps a file in only when it parses and carries a version.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-dump-'));
const dest = path.join(dir, 'mfm-dump.json');
fs.writeFileSync(dest, JSON.stringify({ metadata: { data_version: 981 }, data: {} }));
threw = '';
try { await downloadMfmDump({ dest, fetchBuffer: async () => Buffer.from('<html>rate limited</html>') }); } catch (err) { threw = err.message; }
ok('a non-JSON download is refused', /not JSON/.test(threw));
t('and the dump on disk is untouched', dumpVersionOf(dest), '981');
threw = '';
try { await downloadMfmDump({ dest, fetchBuffer: async () => Buffer.from('{"data":{}}') }); } catch (err) { threw = err.message; }
ok('a download with no version is refused', /no metadata.data_version/.test(threw));
const got = await downloadMfmDump({ dest, fetchBuffer: async () => Buffer.from(JSON.stringify({ metadata: { data_version: 995 }, data: {} })) });
t('a good download swaps in', [got.version, got.previous, dumpVersionOf(dest)], ['995', '981', '995']);
t('and the previous dump is kept', dumpVersionOf(path.join(dir, 'mfm-dump.prev.json')), '981');
ok('and no .part file is left', !fs.existsSync(dest + '.part'));
fs.rmSync(dir, { recursive: true, force: true });

console.log((fail ? 'FAIL' : 'ok') + ' test-gdm-changelog: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
