import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered, exclusionReason, indexedSections, isLegendsRecord, TENTH_EDITION_RULE_IDS } from '../src/rules-corpus.mjs';
import { recordBody } from '../src/wiki-cards.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };

// task-44: a filtered record is never embedded and never lost. Legends, the pack line
// and the named tenth-edition rule are out of the search and out of the tree - that is
// the whole fix for the dilution Mandal measured - but a direct id still answers, and
// the fragment says out loud why the record is not in the corpus's search.
const all = readAllCorpus();
const delivered = all.filter(isDelivered);
const legends = all.filter(r => isLegendsRecord(r));
const pack = all.filter(r => String(r.edition) === '0');
const tenth = all.filter(r => TENTH_EDITION_RULE_IDS.has(String(r.id)));

ok('the filter still holds: Legends, edition 0 and the named rule are out', legends.length > 900 && pack.length > 0 && tenth.length === 1);
ok('and every one of them is delivered=false', legends.concat(pack, tenth).every(r => !isDelivered(r)));
ok('a delivered record has no exclusion reason', delivered.every(r => exclusionReason(r) === ''));
ok('the reason names what the record is', exclusionReason(legends[0]) === 'Warhammer Legends' && exclusionReason(pack[0]) === 'the pack line (edition 0)' && exclusionReason(tenth[0]) === 'tenth edition');

// never embedded: the one predicate the ingest and the query share.
const indexed = new Set(indexedSections(all).map(r => String(r.id)));
ok('no Legends record is in the indexed set', legends.every(r => !indexed.has(String(r.id))));
ok('nor the pack line, nor the tenth-edition rule', pack.concat(tenth).every(r => !indexed.has(String(r.id))));
ok('the indexed set is the delivered set minus the navigation pages', indexed.size === delivered.filter(r => r.kind !== 'index').length);
ok('and the delivered count is unchanged by any of this', delivered.length === 6363);

// task-44 moved the payload's own contract to tests/test-legends.mjs, which pins the
// OFF state (index.json names three books and no Legends payload) and the ON state (the
// branch, the content, every record reachable) in one place. What stays here is the
// corpus predicate and the banner, which is this file's job.
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-data', 'index.json'), 'utf8'));
ok('the default reader is still handed exactly three books', (index.branches || []).length === 3);

// the direct id still answers, and the label rides in the fragment.
const leg = legends[0];
const html = recordBody(leg, { href: () => '' });
ok('a Legends record reached by id renders', html.length > 200 && html.indexOf(leg.text.slice(0, 40)) !== -1);
ok('with the banner above it', html.indexOf('wprov-excl') !== -1 && html.indexOf('Not used in matched play') !== -1);
ok('and the banner names the reason', html.indexOf('Warhammer Legends') !== -1);
ok('a delivered record carries no such banner', recordBody(delivered.find(r => r.kind === 'rule'), { href: () => '' }).indexOf('wprov-excl') === -1);
const tenthHtml = recordBody(tenth[0], { href: () => '' });
ok('the same banner names the tenth-edition rule', tenthHtml.indexOf('wprov-excl') !== -1 && tenthHtml.indexOf('tenth edition') !== -1);
const packHtml = recordBody(pack[0], { href: () => '' });
ok('and the pack line', packHtml.indexOf('wprov-excl') !== -1 && packHtml.indexOf('the pack line') !== -1);
console.log('corpus ' + all.length + ': delivered ' + delivered.length + ', Legends ' + legends.length + ', pack ' + pack.length + ', tenth-edition ' + tenth.length + ', indexed ' + indexed.size);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
