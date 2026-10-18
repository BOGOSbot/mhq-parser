#!/usr/bin/env node
'use strict';
/**
 * Server-side voice transcription (task-17).
 *
 * The browser's own recogniser is free and fine in conversation, and poor on
 * rules and unit names: it has no glossary, so Tyrannofex, Archon or Aeldari come
 * back as whatever French word sounds closest. Mandal's call is Gemini 2.5 Flash
 * on OpenRouter with the 40k glossary as a STATIC system prefix, which is what
 * BOGOS measured: 78.9% terminology accuracy against 44.7% without it, at
 * $0.0073 a cold call and $0.0011 once the prefix is cached.
 *
 * The glossary is the bill, not the audio, so the request shape is built to keep
 * the prefix identical on every call (implicit caching keys on a stable prefix):
 * the system message is instructions + the glossary and never varies; the audio
 * rides the user message alone. This module is the pure half (prompt, request
 * body, response parsing, the format map) so tests can pin the contract without
 * a network call; the route in server.mjs does the I/O.
 *
 * It returns the question in ENGLISH. A French question is transcribed and
 * translated in the same pass, which is what BOGOS ran and what the page wants:
 * the pipeline, the judge and the corpus all read English. The transcript lands
 * in the question box, never auto-submitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLOSSARY_PATH = path.join(__dirname, 'glossary-fr-en.json');

// The measured route. 2.5 Flash, never the lite tier: the lite tier drops chunks
// (BOGOS's 24 s clip read back as 'Ok.', a 305 s chunk as 322 words of 946).
export const VOICE_MODEL = process.env.RULES_VOICE_MODEL || 'google/gemini-2.5-flash';
export const VOICE_ENDPOINT = process.env.RULES_VOICE_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
export const VOICE_TIMEOUT_MS = Number(process.env.RULES_VOICE_TIMEOUT_MS) || 60000;
// A 30 s clip at 16 kHz mono 16-bit is 960 KB; the client caps at 60 s and the
// route refuses anything over this rather than spending on a runaway upload.
export const MAX_VOICE_BYTES = Number(process.env.RULES_VOICE_MAX_BYTES) || 8 * 1024 * 1024;
// task-19: cap the answer. The benchmark hit a runaway on a 99 s clip that ran to
// the 4,096-token cap repeating 'Hmm.' (~$0.010); a question is under 100 tokens,
// so 400 is generous and the cap is the budget's.
export const VOICE_MAX_TOKENS = Number(process.env.RULES_VOICE_MAX_TOKENS) || 400;
// BOGOS's density guard: a chunk reading under 0.8 words per second of audio, or
// nothing but timestamps, is too thin for its audio and is re-asked once.
export const VOICE_MIN_WPS = Number(process.env.RULES_VOICE_MIN_WPS) || 0.8;

export function glossaryPromptLines(glossary) {
  const entries = (glossary && glossary.entries) || [];
  return entries
    .filter(e => e && e.fr && e.en)
    .map(e => String(e.fr).trim() + ' = ' + String(e.en).trim())
    .join('\n');
}

let PROMPT = null;
// The system prefix. Cached by the provider on the prefix, so it is computed once
// and never varies between calls; nothing per-request may ride in it.
export function voicePrompt(glossary) {
  if (PROMPT && !glossary) return PROMPT;
  const g = glossary || JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf8'));
  const lines = glossaryPromptLines(g);
  PROMPT = [
    'You transcribe a spoken question about Warhammer 40,000 11th edition rules, spoken in French or English, and return it as ONE English question.',
    '',
    'Rules:',
    '- Return only the question, in English, on one line. No preamble, no timestamps, no speaker labels, no notes.',
    '- It is spoken: drop the filler, keep the meaning and the detail.',
    '- A French question is translated into natural English, keeping its whole meaning.',
    '- Use the official English term for every game term the glossary lists, spelled exactly as it is written there. These are unit, weapon, stratagem, detachment and keyword names; a French speaker often says them with French sounds, and the glossary is the spelling authority.',
    '- If a name is not in the glossary, keep the sound you heard. Never replace a name with a common word that looks like it.',
    '',
    'French = English:',
    lines,
  ].join('\n');
  return PROMPT;
}

// The audio formats the route accepts, by content type. The client encodes WAV
// so the format is always the one every provider accepts.
const FORMATS = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mp3': 'mp3', 'audio/mpeg': 'mp3',
};
export function voiceFormatOf(contentType) {
  return FORMATS[String(contentType || '').split(';')[0].trim().toLowerCase()] || '';
}

export function voiceRequestBody(audioBase64, opts) {
  const o = opts || {};
  return {
    model: o.model || VOICE_MODEL,
    // Transcribe, do not riff: a deterministic read and a bound on the answer.
    temperature: 0,
    max_tokens: 400,
    messages: [
      // The breakpoint is what makes the prefix CACHED through OpenRouter:
      // measured, the same request without it bills the full 23.5k prompt every
      // time ($0.0073 a call); with it the call reads 22.5k cached tokens and bills
      // $0.00106 for an 8 s clip, which is the benchmark's $0.0011.
      { role: 'system', content: [{ type: 'text', text: voicePrompt(o.glossary), cache_control: { type: 'ephemeral' } }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: o.userText || 'Transcribe this clip as the English rules question it is.' },
          { type: 'input_audio', input_audio: { data: audioBase64, format: o.format || 'wav' } },
        ],
      },
    ],
    // task-19: a runaway reading is capped, not paid for at 4,096 tokens.
    max_tokens: o.maxTokens || VOICE_MAX_TOKENS,
  };
}

// How many seconds of speech the clip carries, when the header says (16 kHz mono
// 16-bit WAV from the page, or an explicit header for anything else). 0 when it
// cannot be known - the guard then falls back to the length checks alone.
export function wavSeconds(buf) {
  if (!buf || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  const byteRate = buf.readUInt32LE(28);
  if (!byteRate) return 0;
  return Math.max(0, (buf.length - 44) / byteRate);
}
const TIMESTAMPS_ONLY = /^[\s\d:.,;\-\u2013\u2014]+$/;
// Is the reading too thin for its audio? Empty, nothing but timestamps, or under
// 0.8 words per second of a known duration (BOGOS's guard, measured).
export function thinReading(text, seconds) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  if (!words) return true;
  if (TIMESTAMPS_ONLY.test(String(text))) return true;
  return !!(seconds && seconds > 0 && words / seconds < VOICE_MIN_WPS);
}
export function wordCount(text) { return String(text || '').split(/\s+/).filter(Boolean).length; }

// The one string the reader sees. Some routes wrap it in JSON or quotes; the
// transcript is still the question, so unwrap those and flatten line breaks.
export function transcriptOf(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  let text = choice && choice.message ? choice.message.content : '';
  if (Array.isArray(text)) text = text.map(p => (p && (p.text || p.content)) || '').join(' ');
  text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (/^\{/.test(text)) {
    try {
      const obj = JSON.parse(text);
      text = String(obj.text || obj.transcript || obj.question || '').trim();
    } catch { /* not JSON, keep the words */ }
  }
  return text;
}

// One call. The caller owns the key and the timeout; this owns the contract.
// The fetch is injectable so the guard can be tested without a model.
async function transcribeOnce(audio, key, o, userText) {
  const body = voiceRequestBody(audio.toString('base64'), {
    format: o.format || 'wav', model: o.model, glossary: o.glossary, userText, maxTokens: o.maxTokens,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs || VOICE_TIMEOUT_MS);
  let res, text;
  try {
    res = await (o.fetch || fetch)(o.endpoint || VOICE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = JSON.parse(text); } catch { throw new Error('voice route returned a non-JSON response: HTTP ' + res.status + ' ' + text.slice(0, 120)); }
  if (!res.ok) throw new Error('voice route failed: HTTP ' + res.status + ' ' + String((payload && payload.error && (payload.error.message || payload.error)) || text).slice(0, 160));
  const choice = payload.choices && payload.choices[0];
  const finish = (choice && choice.finish_reason) || '';
  return { transcript: transcriptOf(payload), finish: finish, usage: payload.usage || null, model: body.model };
}

// task-19: the completeness guard. A thin reading (empty, timestamps only, under
// 0.8 words per second of audio, or cut off at the output cap) is re-asked ONCE
// with a corrective prompt that says what to do; the longer of the two readings
// is kept, because BOGOS measured that re-asking the same audio can stop in the
// same place and that a whole reading beats a dead end. Both thin and non-empty
// still returns a reading (the reader can correct it); both empty throws.
const CORRECTIVE = 'A previous reading of this clip came back too thin for the audio. Transcribe the whole clip again: it is a spoken Warhammer 40,000 11th edition rules question, and the answer is the English question in full.';

export async function transcribeClip(audio, key, opts) {
  const o = opts || {};
  if (!key) throw new Error('voice transcription is not configured: no OpenRouter key');
  const seconds = o.seconds != null ? Number(o.seconds) : wavSeconds(audio);
  const started = Date.now();
  const first = await transcribeOnce(audio, key, o, '');
  const attempts = [{ words: wordCount(first.transcript), finish: first.finish }];
  const thin = thinReading(first.transcript, seconds) || first.finish === 'length';
  let best = first;
  let retried = false;
  if (thin) {
    retried = true;
    const corrective = CORRECTIVE + (first.transcript ? ' The thin reading was: ' + first.transcript : '');
    const second = await transcribeOnce(audio, key, o, corrective);
    attempts.push({ words: wordCount(second.transcript), finish: second.finish });
    best = wordCount(second.transcript) > wordCount(first.transcript) ? second : first;
  }
  if (!best.transcript) throw new Error('voice route returned no transcript');
  return {
    text: best.transcript,
    model: best.model,
    usage: best.usage,
    ms: Date.now() - started,
    seconds: Math.round(seconds * 10) / 10,
    attempts: attempts.length,
    retried: retried,
    thin: thinReading(best.transcript, seconds),
  };
}

export default { VOICE_MODEL, VOICE_ENDPOINT, VOICE_TIMEOUT_MS, MAX_VOICE_BYTES, VOICE_MAX_TOKENS, VOICE_MIN_WPS, voicePrompt, voiceRequestBody, transcriptOf, voiceFormatOf, wavSeconds, thinReading, wordCount, transcribeClip };
