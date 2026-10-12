#!/usr/bin/env node
'use strict';
/**
 * The answer key for the reddit question bank.
 *
 *   node tests/build-reddit-answers.mjs
 *
 * fixtures/reddit-questions.json is 68 real questions with no answers, which
 * grades retrieval but cannot grade an answer. The answers are in the weekly
 * threads the questions came from, harvested whole into
 * fixtures/reddit-threads/<thread>.json (id, parent, score, body per comment).
 *
 * The thread dumps were read from the thread pages themselves. Reddit refuses
 * this machine and the cloud browsers that were tried (403 and a
 * network-security page), so both threads were opened through a redlib mirror,
 * which renders the whole comment tree server-side, and the tree was taken from
 * the DOM: id, parent, score and body per comment.
 *
 * A question is the top-level comment and the ruling is what was written under
 * it, so this walks each question's whole subtree rather than only its direct
 * replies - "ask your TO" is often answered one level deeper - and keeps the
 * bodies with their scores, best first. A question with no reply is written
 * with an empty list: it is the grader's job to say "no ruling", not this
 * script's to invent one.
 *
 * Answering a question against the thread its asker used also decides which
 * question is which: the text is the join key, matched exactly first, then by
 * prefix (the bank truncates long questions), then by token overlap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit-questions.json'), 'utf8'));

const threads = {};
for (const id of new Set(bank.questions.map(q => q.thread))) {
  const file = path.join(__dirname, 'fixtures', 'reddit-threads', id + '.json');
  threads[id] = JSON.parse(fs.readFileSync(file, 'utf8')).comments;
}

export function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchQuestion(question, comments) {
  const nq = normalize(question);
  let hit = comments.find(c => normalize(c.body) === nq);
  if (hit) return { comment: hit, how: 'exact' };
  hit = comments.find(c => {
    const n = normalize(c.body);
    return n && (nq.startsWith(n.slice(0, 120)) || n.startsWith(nq.slice(0, 120))) && Math.abs(n.length - nq.length) < 400;
  });
  if (hit) return { comment: hit, how: 'prefix' };
  const words = w => new Set(normalize(w).split(/[^a-z0-9+]+/).filter(t => t.length > 3));
  const qt = words(question);
  let best = null, bestScore = 0;
  for (const c of comments) {
    const ct = words(c.body);
    let seen = 0;
    for (const w of qt) if (ct.has(w)) seen++;
    const score = seen / Math.max(1, qt.size);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best && bestScore >= 0.8 ? { comment: best, how: 'tokens ' + bestScore.toFixed(2) } : { comment: null, how: 'unmatched' };
}

// Every comment under the question, not only its direct replies, best first.
export function subtree(comments, rootId) {
  const byParent = new Map();
  for (const c of comments) {
    if (!byParent.has(c.parent)) byParent.set(c.parent, []);
    byParent.get(c.parent).push(c);
  }
  const out = [];
  const walk = (id, depth) => {
    for (const child of byParent.get(id) || []) {
      if (child.body && normalize(child.body).length > 2) out.push({ score: child.score || 0, depth, id: child.id, body: child.body });
      walk(child.id, depth + 1);
    }
  };
  walk(rootId, 1);
  out.sort((a, b) => b.score - a.score || a.depth - b.depth);
  return out;
}

function main() {
  const questions = [];
  let matched = 0, withAnswer = 0;
  for (const item of bank.questions) {
    const comments = threads[item.thread] || [];
    const { comment, how } = matchQuestion(item.q, comments);
    const replies = comment ? subtree(comments, comment.id) : [];
    if (comment) matched++;
    if (replies.length) withAnswer++;
    questions.push({
      q: item.q,
      thread: item.thread,
      date: item.date,
      match: how,
      comment: comment ? comment.id : '',
      url: comment ? 'https://www.reddit.com/r/WarhammerCompetitive/comments/' + item.thread + '/comment/' + comment.id + '/' : '',
      score: comment ? comment.score : 0,
      replies,
    });
  }
  const out = {
    version: 1,
    note: 'Answers for fixtures/reddit-questions.json, read off the threads the questions came from. "replies" is every comment written under the question with its score, best first; an empty list means the thread left the question unanswered and the grader should expect no ruling.',
    source: 'r/WarhammerCompetitive weekly question threads, harvested into fixtures/reddit-threads/',
    questions,
  };
  const file = path.join(__dirname, 'fixtures', 'reddit-answers.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log('questions ' + questions.length + ', matched ' + matched + ', with an answer in the thread ' + withAnswer);
  const unmatched = questions.filter(q => !q.comment);
  if (unmatched.length) console.log('unmatched: ' + unmatched.map(q => q.q.slice(0, 60)).join(' | '));
  console.log('wrote ' + path.relative(process.cwd(), file));
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build-reddit-answers.mjs')) main();
