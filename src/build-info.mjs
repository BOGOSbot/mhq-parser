#!/usr/bin/env node
// task-90: WHICH BUILD IS THIS PROCESS RUNNING.
//
// The Box served an older build for several rounds while every deploy reported success. The
// archive is extracted over the tree, so the FILES were new, but Node had loaded the modules at
// process start and the start step never restarted it - so the old process kept answering, and
// the deploy called that success because the port answered 200.
//
// A build that cannot say which commit it is cannot be measured, so the server says it: read
// ONCE at boot, reported on /health, and compared by the deploy against the commit it shipped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// The order matters: an explicit env var wins (the deploy sets it), then the BUILD file the
// archive carries, then git, then nothing. Read at import, so it is the build THIS PROCESS
// started from and not the one on disk now - which is the whole point.
function readBuild() {
  const fromEnv = String(process.env.RULES_BUILD || '').trim();
  if (fromEnv) return { commit: fromEnv, source: 'env' };
  try {
    const fromFile = String(fs.readFileSync(path.join(ROOT, 'BUILD'), 'utf8')).trim();
    if (fromFile) return { commit: fromFile.split(/\s+/)[0], source: 'file' };
  } catch (e) { /* no BUILD file in the archive */ }
  try {
    const out = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return { commit: out, source: 'git' };
  } catch (e) { /* not a checkout */ }
  return { commit: 'unknown', source: 'none' };
}

const BUILD = readBuild();
const BOOTED_AT = new Date().toISOString();

export function buildInfo() {
  return { commit: BUILD.commit, source: BUILD.source, bootedAt: BOOTED_AT };
}
export function buildCommit() { return BUILD.commit; }
