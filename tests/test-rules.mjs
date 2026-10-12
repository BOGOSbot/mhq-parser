import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAST_ENDPOINT, FAST_MODEL, FAST_REASONING, JEV_ENDPOINT, JEV_MODEL, MODEL, MODEL_ENDPOINT, MODEL_REASONING, RULES_EDITION, RULES_EDITION_LABEL,
  anchorFor, credential, credentialFromFile, credentials, credentialsPath, editionOf, fastKeyName, keyState, modelKeyName,
  RulesError,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- anchorFor: how a heading becomes a citation -----------------------------
// A citation is built from the heading the passage came from, never from
// anything a model wrote, so this function is the only thing standing between a
// chunk and a link a reader can follow.
t('the rule id is dropped from the anchor', anchorFor('1. Hit Roll 05.01'), '1.-Hit-Roll');
t('a hyphen in the heading survives', anchorFor('Battle-shock Rolls 01.07'), 'Battle-shock-Rolls');
t('a deeper rule id is dropped whole', anchorFor('Revived and Adding Models to a Unit 01.02.03'), 'Revived-and-Adding-Models-to-a-Unit');
t('a heading with no rule id is kept', anchorFor('Measuring Distances'), 'Measuring-Distances');
t('an entity in the heading is decoded first', anchorFor('Commands &amp; Orders 01.04'), 'Commands-&-Orders');
t('surrounding space is trimmed', anchorFor('  Coherency   03.03  '), 'Coherency');
t('runs of space become one hyphen', anchorFor('As Close   As Possible'), 'As-Close-As-Possible');
t('an empty heading makes an empty anchor', anchorFor(''), '');
t('a null heading makes an empty anchor', anchorFor(null), '');
t('a two-digit id is not mistaken for a rule id', anchorFor('Phase 2'), 'Phase-2');

// --- editionOf: the corpus holds exactly one edition -------------------------
// Two editions answer the same question differently. Mixing them is not a worse
// answer, it is a wrong one, so the edition is named once and everything else
// reads it from here.
t('11th', editionOf('wh40k11ed'), '11th edition');
t('10th', editionOf('wh40k10ed'), '10th edition');
t('9th', editionOf('wh40k9ed'), '9th edition');
t('8th', editionOf('wh40k8ed'), '8th edition');
t('1st takes st', editionOf('wh40k1ed'), '1st edition');
t('2nd takes nd', editionOf('wh40k2ed'), '2nd edition');
t('3rd takes rd', editionOf('wh40k3ed'), '3rd edition');
t('12th takes th, not nd', editionOf('wh40k12ed'), '12th edition');
t('13th takes th, not rd', editionOf('wh40k13ed'), '13th edition');
t('a slug with no edition is empty', editionOf('kill-team'), '');
t('nothing is empty', editionOf(null), '');
t('the label describes the configured edition', RULES_EDITION_LABEL, editionOf(RULES_EDITION));

// --- credentials ------------------------------------------------------------
// Environment first, then the machine-global store. A public deployment sets
// the variables and never has the file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-rules-test-'));
const store = path.join(dir, '.credentials.yaml');
fs.writeFileSync(store, [
  '# a comment that must not be read as a key',
  'OPENCODE_GO_API_KEY: jev-from-file',
  'MISTRAL_API_KEY:  mistral-from-file  ',
  'EMPTYISH:',
  'NOT_THIS: commented  # trailing',
].join('\n'));

t('a value is read from the store', credentialFromFile('OPENCODE_GO_API_KEY', store), 'jev-from-file');
t('surrounding space is trimmed', credentialFromFile('MISTRAL_API_KEY', store), 'mistral-from-file');
t('an absent name is empty', credentialFromFile('TINYFISH_API_KEY', store), '');
t('a key with no value is empty', credentialFromFile('EMPTYISH', store), '');
t('a missing file is empty, not a throw', credentialFromFile('ANY', path.join(dir, 'nope.yaml')), '');
t('a name is matched whole, not as a prefix', credentialFromFile('NOT', store), '');
t('the environment wins over the store', credential('OPENCODE_GO_API_KEY', { OPENCODE_GO_API_KEY: 'from-env' }, store), 'from-env');
t('the store is the fallback', credential('OPENCODE_GO_API_KEY', {}, store), 'jev-from-file');
t('an empty environment value falls through to the store', credential('OPENCODE_GO_API_KEY', { OPENCODE_GO_API_KEY: '   ' }, store), 'jev-from-file');
t('an unset key in both is empty', credential('ABSENT_KEY', {}, store), '');

t('credentials reports the four services', Object.keys(credentials()).sort(), ['fast', 'jev', 'model', 'tinyfish']);
t('keyState reports both routes and their names', Object.keys(keyState()).sort(), ['fast', 'fastName', 'jev', 'model', 'modelName', 'tinyfish']);
t('the writer key is named', modelKeyName().length > 3, true);
t('the fast key is named', fastKeyName().length > 3, true);
t('the credentials path ends at the store', credentialsPath().endsWith(path.join('.dsh', '.credentials.yaml')), true);
fs.rmSync(dir, { recursive: true, force: true });

// --- the shared constants ---------------------------------------------------
t('the edition is a wahapedia slug', /^wh40k\d+ed$/.test(RULES_EDITION), true);
t('the jev endpoint is a url', /^https:\/\//.test(JEV_ENDPOINT), true);
t('the writer endpoint is a url', /^https:\/\//.test(MODEL_ENDPOINT), true);
t('the writer is named', MODEL.length > 3, true);
t('the fast endpoint is a url', /^https:\/\//.test(FAST_ENDPOINT), true);
t('the fast model is named', FAST_MODEL.length > 3, true);
t('one route by default: the fast route is the writer', FAST_ENDPOINT === MODEL_ENDPOINT && FAST_MODEL === MODEL, true);
t('the judge keeps its thinking by default', FAST_REASONING, 'medium');
t('the writer keeps its own reasoning by default', MODEL_REASONING, '');
t('the jev model is named', JEV_MODEL.length > 3, true);
t('RulesError carries a status', new RulesError('nope', 400).status, 400);
t('RulesError defaults to 500', new RulesError('nope').status, 500);
t('RulesError is an Error', new RulesError('nope') instanceof Error, true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
