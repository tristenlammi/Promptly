/**
 * Is a spoken answer to "shall I open the garage door?" a clear yes?
 *
 * The safe reading of anything ambiguous is no. This used to be a regex
 * anchored only at the start, so "Okay, cancel that", "Sure, wait no" and
 * "Do it later" all ran the command (R-131). Now the whole answer has to
 * be made of yes-words, and any stop word anywhere makes it a no.
 *
 * Kept free of imports so it can be unit-tested directly.
 */

/** Any of these anywhere means no. */
const STOP_WORDS = new Set([
  "no",
  "nope",
  "nah",
  "not",
  "dont",
  "cancel",
  "stop",
  "wait",
  "hold",
  "never",
  "later",
  "abort",
  "negative",
]);

/** Words a yes may be built from ("yes please", "okay do it", "go ahead"). */
const YES_WORDS = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "confirm",
  "confirmed",
  "affirmative",
  "absolutely",
  "definitely",
  "please",
  "go",
  "ahead",
  "do",
  "it",
  "for",
  "that",
  "thing",
]);

/** At least one of these must be present — "it" or "please" alone isn't a yes. */
const CORE_YES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "confirm",
  "confirmed",
  "affirmative",
  "absolutely",
  "definitely",
]);
const CORE_PHRASES = ["go ahead", "do it", "go for it"];

export function normaliseAnswer(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSpokenYes(utterance: string): boolean {
  const said = normaliseAnswer(utterance);
  if (!said) return false;
  const words = said.split(" ");
  if (words.some((w) => STOP_WORDS.has(w))) return false;
  if (!words.every((w) => YES_WORDS.has(w))) return false;
  return words.some((w) => CORE_YES.has(w)) || CORE_PHRASES.some((p) => said.includes(p));
}

const BARE_NO = new Set(["no", "nope", "nah", "no thanks", "no thank you", "not that", "no not that"]);

/** Just "no" — declining, with nothing else to say. */
export function isBareNo(utterance: string): boolean {
  return BARE_NO.has(normaliseAnswer(utterance));
}
