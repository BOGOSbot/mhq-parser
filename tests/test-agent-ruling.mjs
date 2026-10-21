import { agentPrompt, rulingSlots, traceRuling } from '../src/rules-corpus.mjs';

// task-24 (J4): the prompt's field contract and the trace check. The client renders
// the slots; these two are the server half, and they are pure so they are pinned
// here rather than through a live agent call. The rendering itself (no chip, no
// verdict line, the cited/residue split) is pinned in test-wiki-surface.mjs.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const good = JSON.stringify(got) === JSON.stringify(want); if (good) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } };

const P = [
  { set: 'rules', heading: '09.06 ADVANCE MOVE', ruleId: '09.06', text: 'Until the end of the turn, unless otherwise stated, your unit is not eligible to shoot, declare a charge or start an action.' },
  { set: 'rules', heading: '10.04 NORMAL SHOOTING', ruleId: '10.04', text: 'Each time a unit shoots, 170 pts of wargear may be selected.' },
  { set: 'rules', heading: '13.01 CHARGING', text: 'A unit that made an Advance move cannot declare a charge.' },
  { set: 'factions', heading: 'Wazdakka Gutsmek', text: 'Pulse Jet. In your Movement phase, this unit can make a pulse jet move.' },
];

// --- the prompt asks for the fields, in the page's language -------------------
const en = agentPrompt('Can a unit shoot after it Fell Back?', P, { lang: 'en' });
for (const field of ['"answer"', '"quote"', '"from"', '"exceptions"', '"missing"']) ok('the schema names ' + field, en.indexOf(field) !== -1);
ok('the prompt asks for why as well (the trace and the dataset keep it)', en.indexOf('- why') !== -1);
ok('the quote is required to be verbatim and from the named passage', /quote:.*VERBATIM.*from/s.test(en) && /no paraphrase/.test(en));
ok('an answered ruling does not explain what is absent', /missing: only when answered is false/.test(en));
ok('an answer is one sentence in the reader\'s terms', /answer: one sentence/.test(en));
const fr = agentPrompt('Une unite peut-elle tirer apres un Fall Back ?', P, { lang: 'fr' });
ok('the French prompt asks for the fields in French', /answer : une phrase/.test(fr) && /quote : des mots copi/.test(fr) && /missing : seulement quand answered est false/.test(fr));
ok('and says the quote stays in the passage\'s English', /VERBATIM/.test(fr));

// --- the trace: a figure the cited passage does not carry is fabricated --------
const good = rulingSlots({ answer: 'No - the unit cannot shoot. 170 pts is the wargear figure.', quote: 'Until the end of the turn, unless otherwise stated, your unit is not eligible to shoot, declare a charge or start an action.', from: 1, exceptions: [2], missing: null }, true, P);
t('a ruling whose figures are in the passages it names drops nothing', good.trace, { total: 2, dropped: 0, bad: [], quoteOk: true });
const fabricated = rulingSlots({ answer: 'No - the unit cannot shoot, and 120 pts of wargear is chosen.', quote: 'Until the end of the turn, unless otherwise stated, your unit is not eligible to shoot, declare a charge or start an action.', from: 1, exceptions: [], missing: null }, true, P);
t('a fabricated figure is dropped and named', fabricated.trace.bad, ['120']);
t('and the count follows', [fabricated.trace.total, fabricated.trace.dropped], [2, 1]);
ok('the quote itself still reads as sound', fabricated.trace.quoteOk === true);

// --- the quote must be in the passage it NAMES --------------------------------
const wrongPassage = rulingSlots({ answer: 'A unit that advanced cannot charge.', quote: 'A unit that made an Advance move cannot declare a charge.', from: 1, exceptions: [], missing: null }, true, P);
ok('a quote copied from another passage is not sound', wrongPassage.trace.quoteOk === false);
t('and it counts as one dropped claim', wrongPassage.trace.dropped, 1);
const rightPassage = rulingSlots({ answer: 'A unit that advanced cannot charge.', quote: 'A unit that made an Advance move cannot declare a charge.', from: 3, exceptions: [], missing: null }, true, P);
ok('the same quote from the passage it came from is sound', rightPassage.trace.quoteOk === true && rightPassage.trace.dropped === 0);
// A passage is truncated for the prompt, so a shared 40-character prefix is found.
const longText = 'A'.repeat(60) + ' tail that the prompt never shows because the passage was cut';
const truncated = traceRuling({ answer: '', quote: 'A'.repeat(60) + ' tail that the prompt never shows', from: 1, exceptions: [], passages: [1] }, [{ text: longText }]);
ok('a quote against a truncated passage is still sound', truncated.quoteOk === true && truncated.dropped === 0);

// --- quoted strings in the answer are claims too ------------------------------
const quoted = traceRuling({ answer: 'The rule says "a unit that made an Advance move cannot declare a charge" and that is final.', quote: null, from: null, exceptions: [], passages: [3] }, P);
t('a quoted stretch of 12+ characters is checked against the cited passages', quoted.dropped, 0);
const quotedBad = traceRuling({ answer: 'It says "a unit that Fell Back may still shoot" outright.', quote: null, from: null, exceptions: [], passages: [3] }, P);
t('a quoted stretch the cited passages do not carry is dropped', quotedBad.bad.length, 1);
const shortQuote = traceRuling({ answer: 'It says "move" and nothing else.', quote: null, from: null, exceptions: [], passages: [3] }, P);
t('a quoted stretch under 12 characters is not a claim', shortQuote.total, 0);

// --- the fallbacks, as an interface -------------------------------------------
const noQuote = rulingSlots({ answer: 'Nothing covers it.', quote: '', from: null, exceptions: [], missing: null }, true, P);
t('no quote renders no quote slot', noQuote.quote, null);
t('and no figure to check', noQuote.trace.total, 0);
const noAnswer = rulingSlots({ quote: 'Until the end of the turn', from: 1 }, true, P);
t('no answer is the empty string (the client falls back to the recommendation line)', noAnswer.answer, '');
const refused = rulingSlots({ answer: 'Nothing in the indexed rules covers Kill Team.', quote: 'a quote the model wrote anyway', from: 1, exceptions: [2], missing: 'The Kill Team game system is not part of these rules.' }, false, P);
t('answered:false never carries a quote', [refused.quote, refused.from], [null, null]);
t('and never carries exceptions', refused.exceptions, []);
t('the refusal keeps its missing diagnosis', refused.missing, 'The Kill Team game system is not part of these rules.');
t('an answered ruling carries no missing', noQuote.missing, null);

// --- passage numbers are checked against the list the agent was shown ---------
const outOfRange = rulingSlots({ answer: 'x', quote: null, from: 99, exceptions: [0, 2, 99, '2'], missing: null }, true, P);
t('an out-of-range from is null', outOfRange.from, null);
t('out-of-range exceptions are filtered and strings are accepted', outOfRange.exceptions, [2]);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;