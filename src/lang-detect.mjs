// A cheap guess at the language of a short text, shared so the server and the
// renderer cannot disagree about which pane a ruling belongs in. The heuristic is
// diacritics plus the function words French rules text is made of; on text this
// short it can be fooled, so it is only ever used to label, never to translate.
const FR = /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|une|un|est|que|qui|pour|avec|sur|dans|je|peut|doit|figurine|unité|règle|test|combien)\b/i;
export function looksFrench(text) { return FR.test(String(text == null ? '' : text)); }
export default { looksFrench };
