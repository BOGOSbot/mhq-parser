#!/usr/bin/env node
'use strict';
/**
 * What a deploy must prove, beyond a 200.
 *
 *   node src/deploy-check.mjs [url]
 *
 * task-63: the favicon was "lost" on the live page for a whole day and every check
 * passed, because src/server.mjs falls back to a 119-byte placeholder ICO when
 * img/ is missing and answers 200 with it. A status code cannot tell a deploy that
 * carries the brand icons from one that forgot them; a byte count can.
 *
 * Checks, against the running deployment:
 *   - /health names the brand icons and their sizes (not 'fallback');
 *   - /favicon.png and /favicon.ico are the 32x32 PNG's own bytes;
 *   - /apple-touch-icon.png is the 180x180 icon's own bytes.
 * Exit 0 only when all of them hold. No dependencies: the same shape as the rest
 * of src/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// task-90: WHICH BUILD. A deploy that extracts over the tree but never restarts the
// process serves yesterday's rules and answers 200 while it does, which is exactly what
// happened for several rounds. So the deploy states the commit it shipped and this check
// FAILS when the running build is a different one.
function argValue(name) { const i = process.argv.indexOf(name); return i === -1 ? '' : String(process.argv[i + 1] || ''); }
const positional = process.argv.slice(2).filter((a, i, arr) => a.indexOf('--') !== 0 && arr[i - 1] !== '--expect');
const BASE = String(positional[0] || process.env.DEPLOY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const EXPECT = String(argValue('--expect') || process.env.DEPLOY_BUILD || '').trim();
// A short commit and a full one are the same build: compare one as a prefix of the other.
const sameBuild = (a, b) => !!a && !!b && (a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0);

export function readBrandIcons(dir) {
  const read = f => { try { return fs.readFileSync(path.join(dir || ROOT, 'img', f)); } catch { return null; } };
  return { icon32: read('favicon-32.png'), icon180: read('apple-touch-icon.png') };
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'Accept-Encoding': 'identity' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timed out fetching ' + url)));
  });
}

const local = readBrandIcons();
const failures = [];
const say = (ok, line) => { console.log((ok ? 'ok   ' : 'FAIL ') + line); if (!ok) failures.push(line); };

if (!local.icon32 || !local.icon180) {
  say(false, 'the repo has no img/favicon-32.png or img/apple-touch-icon.png to compare against');
} else {
  say(true, 'local icons: favicon-32.png ' + local.icon32.length + ' B, apple-touch-icon.png ' + local.icon180.length + ' B');
}

const health = await get(BASE + '/health');
let payload = null;
try { payload = JSON.parse(health.body.toString('utf8')); } catch (e) { payload = null; }
const brand = (payload && payload.brand) || null;
say(health.status === 200 && !!brand, '/health answers with a brand field');
// task-90: the build first, because everything else here is a claim about a process that
// may not be the one this deploy started. Read once at boot (src/build-info.mjs).
const build = (payload && payload.build) || null;
if (!build || !build.commit || build.commit === 'unknown') {
  say(false, '/health does not say which build it is' + (build ? ' (commit ' + build.commit + ')' : ' (no build field)') + ': a build that cannot name its commit cannot be measured');
} else if (!EXPECT) {
  say(true, '/health reports build ' + build.commit + ' from ' + (build.source || '?') + ', booted ' + (build.bootedAt || '?'));
  console.log('note  no --expect and no DEPLOY_BUILD: the running build was not compared with the one this deploy shipped');
} else {
  say(sameBuild(String(build.commit), EXPECT), 'the running build is the one this deploy shipped: /health says ' + build.commit + ', the deploy shipped ' + EXPECT + (sameBuild(String(build.commit), EXPECT) ? '' : ' - THE BOX IS SERVING ANOTHER BUILD, so the modules it loaded are not the ones you just extracted'));
}
if (brand) {
  say(brand.favicon !== 'fallback', '/health says the favicon is ' + brand.favicon + (brand.favicon === 'fallback' ? ' (the placeholder is being served)' : ''));
  say(brand.appleTouchIcon !== 'fallback', '/health says the touch icon is ' + brand.appleTouchIcon);
  if (local.icon32) say(brand.faviconBytes === local.icon32.length, '/health faviconBytes ' + brand.faviconBytes + ' equals the real file (' + local.icon32.length + ')');
  if (local.icon180) say(brand.appleTouchIconBytes === local.icon180.length, '/health appleTouchIconBytes ' + brand.appleTouchIconBytes + ' equals the real file (' + local.icon180.length + ')');
}

for (const [route, want] of [['/favicon.png', local.icon32], ['/favicon.ico', local.icon32], ['/apple-touch-icon.png', local.icon180]]) {
  const r = await get(BASE + route);
  const bytes = r.body.length;
  if (!want) { say(false, route + ': nothing to compare against'); continue; }
  say(r.status === 200 && bytes === want.length, route + ' is ' + bytes + ' B' + (bytes === want.length ? '' : ' - expected ' + want.length + ' B (the 119-byte placeholder is a deploy that forgot img/)'));
}

console.log('');
if (failures.length) {
  console.log(failures.length + ' check(s) failed against ' + BASE + ' - the deploy is not proven');
} else {
  console.log('deploy proven against ' + BASE + ': the brand icons are the real files' + (EXPECT ? ' and it runs ' + EXPECT : ''));
}
// An explicit exit: a keep-alive socket to the deployment would otherwise hold the event
// loop open and a deploy script that waits on this check would hang after it had answered.
process.exit(failures.length ? 1 : 0);
