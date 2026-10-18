import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_VOICE_BYTES, VOICE_MAX_TOKENS, VOICE_MIN_WPS, VOICE_MODEL, thinReading, transcriptOf, transcribeClip, voiceFormatOf, voicePrompt, voiceRequestBody, wavSeconds, wordCount } from '../src/voice.mjs';

// task-17 + task-20: the voice route's contract, the two settings keys and their
// defaults, and the page behaviours that must not regress. The network call itself
// is exercised end to end against the local server and the Box; these pins are the
// contract it has to keep.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const good = JSON.stringify(got) === JSON.stringify(want); if (good) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const server = read('src/server.mjs');
const page = read('src/rules.html');
const surface = read('src/wiki-surface.js');

// --- the route contract ------------------------------------------------------
ok('the route is registered on POST /rules/voice', /u\.pathname === '\/rules\/voice'/.test(server) && /async function handleRulesVoice\(req, res\)/.test(server));
ok('a non-audio body is refused before any spend', /voiceFormatOf\(req\.headers\['content-type'\]\)/.test(server) && /return fail\(res, 415/.test(server));
ok('a missing key is refused, and the page can then fall back', /credential\('OPENROUTER_API_KEY'\)/.test(server) && /return fail\(res, 503/.test(server));
ok('the body is read as bytes, not UTF-8 text', /readBinaryBody\(req, MAX_VOICE_BYTES\)/.test(server) && /req\.on\('data', c =>/.test(server));
ok('the route reports the model, the timed call and the usage it billed', /ok: true, text: out\.text, model: out\.model, usage: out\.usage, ms: out\.ms/.test(server));
t('the measured model', VOICE_MODEL, 'google/gemini-2.5-flash');
ok('the endpoint is OpenRouter', /openrouter\.ai\/api\/v1\/chat\/completions/.test(read('src/voice.mjs')));

// --- the request body --------------------------------------------------------
const body = voiceRequestBody('AAAA', { format: 'wav' });
t('the model rides the request', body.model, 'google/gemini-2.5-flash');
ok('the audio is an input_audio part', body.messages[1].content[1].type === 'input_audio' && body.messages[1].content[1].input_audio.data === 'AAAA' && body.messages[1].content[1].input_audio.format === 'wav');
ok('the glossary is the system prefix', /French = English/.test(body.messages[0].content[0].text) && /TYRANNOFEX/.test(body.messages[0].content[0].text) && /ARCHON/.test(body.messages[0].content[0].text));
ok('the prefix is cached with an explicit breakpoint', body.messages[0].content[0].cache_control && body.messages[0].content[0].cache_control.type === 'ephemeral');
ok('the prompt is the 1,710-entry glossary', (voicePrompt().match(/\n/g) || []).length > 1700);
ok('the prompt names the job and the rule', /ONE English question/.test(voicePrompt()) && /official English term/.test(voicePrompt()));

// --- response parsing --------------------------------------------------------
t('the transcript is unwrapped and flattened', transcriptOf({ choices: [{ message: { content: '  "Can a unit\nshoot?"  ' } }] }), 'Can a unit shoot?');
t('an array content is joined', transcriptOf({ choices: [{ message: { content: [{ text: 'Can a unit ' }, { text: 'shoot?' }] } }] }), 'Can a unit shoot?');
t('an empty answer is empty', transcriptOf({ choices: [] }), '');
t('wav and mp3 are understood', [voiceFormatOf('audio/wav'), voiceFormatOf('audio/mpeg; x=1'), voiceFormatOf('application/json')], ['wav', 'mp3', '']);

// --- the completeness guard (task-19) ----------------------------------------
t('a normal reading is not thin', [thinReading('Can a unit shoot after it Fell Back?', 4), thinReading('Can a unit shoot after it Fell Back?', 3)], [false, false]);
ok('an empty reading is thin', thinReading('', 5) && thinReading('   ', 5));
ok('nothing but timestamps is thin', thinReading('00:00 00:01 00:02', 10));
ok('under 0.8 words per second is thin', thinReading('Can a unit shoot?', 10) && !thinReading('Can a unit shoot after it Fell Back and can it charge?', 4));
t('the words are counted', wordCount('  Can a unit  shoot? '), 4);
const wav = Buffer.alloc(44 + 16000 * 2); // one second of 16 kHz mono 16-bit
wav.write('RIFF', 0, 'ascii'); wav.write('WAVE', 8, 'ascii'); wav.writeUInt32LE(32000, 28);
t('a WAV length is read from its header', Math.round(wavSeconds(wav)), 1);
t('an unknown container has no duration', wavSeconds(Buffer.from('not audio')), 0);

const okRes = text => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } }) });
let calls = 0;
const firstThin = await transcribeClip(wav, 'k', { seconds: 30, fetch: async () => { calls++; return calls === 1 ? okRes('Hmm.') : okRes('Can a Tyrannofex shoot after it Fell Back? It cannot shoot unless a rule says otherwise.'); } });
ok('a thin reading is re-asked once, and the longer reading is kept', calls === 2 && firstThin.retried === true && /Tyrannofex shoot after it Fell Back/.test(firstThin.text));
let calls2 = 0;
const fine = await transcribeClip(wav, 'k', { seconds: 4, fetch: async () => { calls2++; return okRes('Can a Tyrannofex shoot after it Fell Back?'); } });
ok('a good reading is not re-asked', calls2 === 1 && fine.retried === false && fine.attempts === 1);
let calls3 = 0;
const capped = await transcribeClip(wav, 'k', { seconds: 4, fetch: async () => { calls3++; const r = okRes('Hmm. Hmm. Hmm.'); return r; } });
ok('a reading cut at the cap counts as thin and is re-asked', capped.attempts === 2);
let calls4 = 0;
let threw = false;
try { await transcribeClip(wav, 'k', { seconds: 30, fetch: async () => { calls4++; return okRes(''); } }); } catch (e) { threw = true; }
ok('two empty readings fail rather than returning nothing', threw && calls4 === 2);
ok('the output cap is 400 tokens, not 4,096', VOICE_MAX_TOKENS === 400 && voiceRequestBody('AA', { format: 'wav', maxTokens: 123 }).max_tokens === 123);
ok('the density floor is 0.8 wps', VOICE_MIN_WPS === 0.8);
ok('the route passes the clip length to the guard and reports the retry', /x-audio-seconds/.test(server) && /attempts: out\.attempts, retried: out\.retried, thin: out\.thin/.test(server));
ok('the page sends the clip length with the clip', /'X-Audio-Seconds'/.test(page) && /return \{ wav: encodeWav16\(mono, audio.sampleRate\), seconds:/.test(page));

// --- the settings (task-20) --------------------------------------------------
ok('the voice key is kept', page.indexOf("var VOICE_KEY = 'mhq.rules.voice'") !== -1);
ok('Gemini is the voice default', /getItem\(VOICE_KEY\) === 'browser' \? 'browser' : 'gemini'/.test(page));
ok('the findings key is kept', page.indexOf("var DOOR_KEY = 'mhq.rules.door'") !== -1);
ok('In the book is the findings default', /getItem\(DOOR_KEY\) === 'quick' \? 'quick' : 'book'/.test(page));
ok('the gear opens one settings sheet, not a second route', /id="settingsbtn"/.test(page) && /id="gearsheet"/.test(page) && /function openSettings\(\)/.test(page));
ok('the sheet holds both choices', /id="voiceseg"/.test(page) && /data-voice="gemini"/.test(page) && /data-voice="browser"/.test(page) && /id="findingsseg"/.test(page) && /data-door="book"/.test(page) && /data-door="quick"/.test(page));
ok('the sheet carries the corpus date and edition line', /id="gearmeta"/.test(page) && /getElementById\('footdata'\)/.test(page));
ok('the sheet applies on the next tap, not by navigating', /function setDoor\(mode\)/.test(page) && /renderFindings\(DOOR_CUR\.state\)/.test(page));

// --- the switches left the record header and the drawer head -----------------
ok('the record header has no door switch', page.indexOf('doorbar') === -1 && page.indexOf('id="voiceGemini"') === -1 && page.indexOf('doorSeg(') === -1);
ok('the drawer head paints no switch', surface.indexOf('doorSwitch') === -1 && surface.indexOf('openRecordInTree: revealInTree') !== -1);
ok('the row path still says where a tap goes', /ctx\.doorMode\(state\) === 'book' \? ctx\.t\('doorBook'\) : ctx\.t\('doorQuick'\)/.test(surface));

// --- the microphone path -----------------------------------------------------
const voiceStart = page.indexOf('// --- voice ---');
const voiceEnd = page.indexOf('// --- asking ---');
const voice = page.slice(voiceStart, voiceEnd);
ok('the clip is recorded with MediaRecorder', /new MediaRecorder\(stream\)/.test(voice) && /recorder\.start\(\)/.test(voice));
ok('it is re-encoded as 16 kHz mono WAV', /function encodeWav16\(samples, inRate\)/.test(voice) && /var outRate = 16000;/.test(voice) && /'audio\/wav'/.test(voice));
ok('the transcript lands in the box, never submitted', /box\.value = \(base \? base \+ ' ' : ''\) \+ said;/.test(voice) && !/\bask\(/.test(voice));
ok('a server failure falls back to the browser recogniser', /function fallbackBrowser\(\)/.test(voice) && /if \(voiceEngine\(\) === 'gemini'\) geminiStart\(\); else browserStart\(\);/.test(voice));
ok('the browser recogniser is kept for the setting', /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/.test(voice));
t('the size cap is a clip, not a film', MAX_VOICE_BYTES, 8 * 1024 * 1024);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
