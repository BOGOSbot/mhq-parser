#!/usr/bin/env node
'use strict';
/**
 * One hop: the manifest the agent is offered, and the guarantee that it is one hop.
 *
 * Pure - no network, no key. The agent CALL is measured by tests/eval-agent-arms.mjs;
 * what is pinned here is the contract around it, because every one of these clauses is
 * something a wrong implementation would do silently.
 */
import { followManifest, agentPrompt, resolveFollow, AGENT_FOLLOW_PER_PASSAGE, AGENT_FOLLOW_TOTAL } from '../src/rules-corpus.mjs';
let pass = 0, fail = 0;
function ok(name, got) { if (got) pass++; else { fail++; console.log('FAIL ' + name); } }
function t(name, got, want) { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } }

const rec = (id, heading, links) => ({ id, heading, ruleId: '', source: 'core-rules', set: 'rules', text: heading + ' body', links: links || [] });
const CORPUS = new Map([
  ['a#1', rec('a#1', 'Leader', [{ to: 'core#leader', title: 'Leader', kind: 'rule' }])],
  ['a#2', rec('a#2', 'Battle Focus', [{ to: 'core#focus', title: 'Battle Focus', kind: 'rule' }, { to: 'gone', title: 'Missing', kind: 'rule' }])],
  ['core#leader', rec('core#leader', 'LEADER 24.22', [])],
  ['core#focus', rec('core#focus', 'Battle Focus', [])],
]);
const resolve = id => CORPUS.get(id);
const P = id => ({ id, heading: CORPUS.get(id).heading, set: 'rules', text: CORPUS.get(id).text });

t('a link already on screen is not offered', followManifest([P('a#1'), P('core#leader')], resolve).length, 0);
const m2 = followManifest([P('a#2')], resolve);
t('a link whose target the corpus does not hold is not offered', m2.reduce((a, m) => a + m.items.length, 0), 1);
t('and the one it does hold is offered by its heading', m2[0].items[0].t, 'Battle Focus');
t('the manifest is keyed by passage number', m2[0].p, 1);

// The caps are the prompt's budget. A manifest that grows with the finding list is a
// prompt that grows with it, and a small agent drifts into prose as the prompt grows.
const many = rec('a#many', 'Many', Array.from({ length: 12 }, (_, i) => ({ to: 'core#' + i, title: 'T' + i, kind: 'rule' })));
CORPUS.set('a#many', many);
for (let i = 0; i < 12; i++) CORPUS.set('core#' + i, rec('core#' + i, 'T' + i, []));
const capped = followManifest([P('a#many')], resolve);
t('one passage cannot spend the whole manifest', capped[0].items.length, AGENT_FOLLOW_PER_PASSAGE);
t('and the total is capped too', followManifest(Array.from({ length: 20 }, () => P('a#many')), resolve).reduce((a, m) => a + m.items.length, 0) <= AGENT_FOLLOW_TOTAL, true);

// The prompt. Off means byte-identical to what the page sends today.
const plain = agentPrompt('q', [P('a#1')], { manifest: [] });
const offered = agentPrompt('q', [P('a#1')], { manifest: followManifest([P('a#2')], resolve) });
t('with no manifest the prompt declares no follow field', plain.indexOf('follow') === -1, true);
t('with no manifest the prompt offers no links', plain.indexOf('Links you may open') === -1, true);
ok('with a manifest the prompt names the link and how to open it', offered.indexOf('Links you may open') !== -1 && offered.indexOf('Battle Focus') !== -1 && offered.indexOf('"follow"') !== -1);
ok('and the hop is stated as bounded to one', /At most one/.test(offered));

// A model that answers outside the manifest it was shown is ignored, not obeyed. This is
// the clause that keeps one hop from becoming a walk of the corpus.
const man = followManifest([P('a#1'), P('a#2')], resolve);
const first = man[0];
t('a link that was offered resolves to its record', resolveFollow({ passage: first.p, link: 1 }, man, resolve).rec.id, first.items[0].id);
t('a link number nobody offered is refused', resolveFollow({ passage: first.p, link: 9 }, man, resolve), null);
t('a passage number nobody offered is refused', resolveFollow({ passage: 9, link: 1 }, man, resolve), null);
t('no follow is no follow', resolveFollow(null, man, resolve), null);
t('a target the corpus lost is refused', resolveFollow({ passage: 1, link: 1 }, followManifest([P('a#2')], resolve), () => null), null);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
