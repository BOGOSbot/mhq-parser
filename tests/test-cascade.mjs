import { WRITER_DECLINED, compileCascade } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// The cascade, with the writer stubbed so no call is made: reasoning off first,
// and only a decline pays for thinking. The decline sentence is fixed, which is
// what makes it detectable without asking a model to agent its own refusal.
async function run(answers) {
  const calls = [];
  const write = (q, f, reasoning) => { calls.push(reasoning); return answers.shift(); };
  const res = await compileCascade('q', [{ n: 1 }], 'key', { write });
  return { res, calls };
}

const a = await run(['An answer [1].']);
t('a real answer takes the fast path', a.res.path, 'fast');
t('a real answer is not retried', a.res.retried, false);
t('one call', a.calls, ['none']);
t('the answer is returned', a.res.answer, 'An answer [1].');

const b = await run([WRITER_DECLINED, 'A thinking answer [1].']);
t('a decline takes the slow path', b.res.path, 'slow');
t('a decline is retried', b.res.retried, true);
t('two calls, none then medium', b.calls, ['none', 'medium']);
t('the thinking answer is what the reader gets', b.res.answer, 'A thinking answer [1].');

const c = await run(['   ' + WRITER_DECLINED + '  ', 'ok']);
t('a decline with whitespace still counts', c.res.path, 'slow');
t('and the retry answer is used', c.res.answer, 'ok');

const d = await run(['', 'recovered']);
t('an empty fast answer also takes the slow path', d.res.path, 'slow');

const e = await run([WRITER_DECLINED, '']);
t('if the retry is empty the decline is kept', e.res.answer, WRITER_DECLINED);
t('and the path is still reported as slow', e.res.path, 'slow');

const g = await run(['Anything at all']);
t('the slow path is never taken on a good answer', g.calls.length, 1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
