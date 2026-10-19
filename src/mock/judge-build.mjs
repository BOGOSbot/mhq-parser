// Builds judge-data.js for the judge-presentation mockups from real /rules/ask
// captures. Synthetic states are marked as such and say what was changed.
//   node judge-build.mjs
import fs from 'node:fs';

const SRC = 'C:/agentic/bulle/workspace/';
const OUT = 'C:/GitRepos/mhq-parser/src/mock/judge-data.js';

function load(tag) {
  return JSON.parse(fs.readFileSync(SRC + 'judge-run-' + tag + '.json', 'utf8')).last;
}
// Ported from src/wiki-surface.js: the corpus keeps the source's ALL-CAPS
// emphasis, the screen sets a name in title case.
function displayTitle(t) {
  var s = String(t == null ? '' : t).replace(/^\[(.*)\]$/, '$1').trim();
  if (!s || !/[A-Z]/.test(s) || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-\/(\u2019'])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
}
function cut(t, n) {
  var s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n).replace(/\s+$/, '') + '\u2026';
}
function parts(heading) {
  var seg = String(heading || '').split(' > ').filter(Boolean);
  var leaf = seg.length ? seg[seg.length - 1] : '';
  return { title: displayTitle(leaf), crumb: seg.slice(0, -1).join(' \u203a ') };
}
function finding(f) {
  var p = parts(f.heading);
  var ex = cut(f.excerpt || f.passage, 240);
  // The excerpt repeats the heading path on most records; the row already prints
  // it as the crumb, so it is stripped rather than shown twice.
  if (p.crumb) {
    var tail = p.crumb.split(' \u203a ').pop();
    var at = ex.indexOf(tail);
    if (at > -1 && at < 80) ex = ex.slice(at + tail.length).replace(/^[\s\u203a>-]+/, '');
  }
  return { n: f.n, title: p.title, crumb: p.crumb, excerpt: cut(ex, 190), passage: String(f.passage || '') };
}
// The trace check: every number of two digits or more and every quoted string in
// the reading must appear in the passages the reading cites. It is a floor, not
// entailment - it catches an invented figure or a quote that is not there.
function traceCheck(why, cited) {
  var hay = cited.map(function (f) { return f.passage; }).join('\n');
  var body = String(why || '').replace(/\[\d+\]/g, ' ');
  var nums = body.match(/\b\d{2,}\b/g) || [];
  var quotes = [];
  var re = /["\u201c\u2018']([^"\u201d\u2019']{12,})["\u201d\u2019']/g, m;
  while ((m = re.exec(body)) !== null) quotes.push(m[1]);
  var claims = nums.concat(quotes);
  var bad = [];
  for (var i = 0; i < nums.length; i++) if (hay.indexOf(nums[i]) === -1) bad.push(nums[i]);
  for (var k = 0; k < quotes.length; k++) if (hay.indexOf(quotes[k].slice(0, 40)) === -1) bad.push(quotes[k]);
  return { total: claims.length, dropped: bad.length, bad: bad };
}
function markBad(why, bad) {
  var out = String(why || '');
  for (var i = 0; i < bad.length; i++) out = out.split(bad[i]).join('~~' + bad[i] + '~~');
  return out;
}
function stateOf(tag, kind, label, answerKind, note, mutate) {
  var last = load(tag);
  var findings = last.findings.findings.map(finding);
  var j = JSON.parse(JSON.stringify(last.judge.judge));
  var judge2 = null;
  if (mutate) { var r = mutate({ judge: j, findings: findings }); if (r && r.judge2) judge2 = r.judge2; }
  var cited = (j.passages || []).map(function (n) { var f = findings.filter(function (x) { return x.n === n; })[0]; return f; }).filter(Boolean);
  var trace = null;
  if (kind === 'answered' || kind === 'split') {
    trace = traceCheck(j.why, cited);
    if (trace.dropped) j.why = markBad(j.why, trace.bad);
  }
  return {
    key: tag + '-' + kind, label: label, kind: kind, question: last.start && last.start.question || '', asked: last.start && last.start.asked || '',
    findings: findings, judge: { answered: j.answered, rulesQuestion: j.rulesQuestion, confidence: j.confidence, passages: j.passages || [], why: j.why, widen: j.widen },
    judge2: judge2, trace: trace, answerKind: answerKind, note: note
  };
}

var states = [];
states.push(stateOf('a', 'answered', 'the rule', 'Real capture, 2026-10-19.',
  'Can a unit shoot after it Fell Back? - 15 findings; the judge answers from [1] and [2], and the sentence it writes quotes the rule verbatim. Rows 2 to 4 all read Fall-Back Move: that is what the live page shows today, because an FAQ record\u2019s heading path ends at its section. It is a row-title defect, not the judge\u2019s.'));
states.push(stateOf('c', 'answered', 'the numbers', 'Real capture, 2026-10-19.',
  'The points question - the judge\u2019s pick is rank 6 of 11, which is what the pick-first toggle is for.'));
states.push(stateOf('e', 'refused', 'nothing found', 'Real capture, 2026-10-19.',
  'Out of corpus (Kill Team) - the judge\u2019s diagnosis is the useful part, and it is three sentences long.'));
states.push(stateOf('d', 'notq', 'not a question', 'Real capture, 2026-10-19.',
  'A painting question - not a rules question at all, and the corpus has nothing near it.'));
states.push(stateOf('a', 'split', 'judges split', 'Synthetic.',
  'The second judge\u2019s verdict is flipped on the Fell Back capture to draw the disagreement state.', function (s) {
    return { judge2: { answered: false, reasoning: 'none', confidence: 'medium', passages: [], why: 'The passages describe falling back, but none of them states whether the unit may shoot afterwards.' } };
  }));
states.push(stateOf('c', 'answered', 'a dropped claim', 'Synthetic.',
  'One figure in the reading was changed to 150. The trace check finds it is not in the cited passage and strikes it.', function (s) {
    s.judge.why = s.judge.why.replace('170', '150');
    return {};
  }));

var data = {
  arms: [
    { badge: 'J1', name: 'The recommendation', pitch: 'the judge says where to look and marks the rows it used. No model sentence reaches the screen, so nothing on it can be confidently wrong.' },
    { badge: 'J2', name: 'The rule itself', pitch: 'the judge only decides which passage opens; what you read at the top is the rulebook\u2019s own words.' },
    { badge: 'J3', name: 'The reading', pitch: 'one to three sentences in the interface voice, never in the rulebook face, with the passages they came from and what the trace check dropped.' }
  ],
  states: states
};
fs.writeFileSync(OUT, 'window.JUDGE_DATA = ' + JSON.stringify(data, null, 1) + ';\n');
var lines = states.map(function (s) {
  return '  ' + s.label + ': ' + s.findings.length + ' findings, kind=' + s.kind + ', cited=' + s.judge.passages.join(',') +
    (s.trace ? ', trace ' + (s.trace.total - s.trace.dropped) + '/' + s.trace.total : '') + ', why ' + s.judge.why.length + ' chars';
});
console.log(lines.join('\n'));
console.log('wrote ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
