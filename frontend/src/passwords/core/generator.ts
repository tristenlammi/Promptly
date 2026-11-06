// Password, passphrase, PIN and username generators. All randomness is unbiased
// and from the OS. Site rules follow the format of Apple's password-manager-resources
// quirks (MIT; see passwords/THIRD_PARTY.md); the parser here is our own.
import { randomInt } from "./bytes";
import { WORDLIST } from "./safety";
import RULES from "./data/password-rules.json";

const SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  symbol: "!@#$%^&*-_=+?.,:;",
};
const AMBIGUOUS = /[O0oIl1|`'"]/g;

export type PasswordOptions = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
};

export const DEFAULT_PASSWORD: PasswordOptions = { length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true };

const pick = (s: string): string => s[randomInt(s.length)];

function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

/** One character from each required set, the rest from the union, then shuffled. */
function assemble(length: number, required: string[], allowed: string, maxConsecutive?: number): string {
  if (!allowed) throw new Error("No characters allowed");
  for (let attempt = 0; attempt < 200; attempt++) {
    const chars = required.map(pick);
    while (chars.length < length) chars.push(pick(allowed));
    const out = shuffle(chars).join("");
    if (!maxConsecutive || !hasRun(out, maxConsecutive)) return out;
  }
  throw new Error("Couldn't satisfy those password rules");
}

function hasRun(s: string, max: number): boolean {
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    run = s[i] === s[i - 1] ? run + 1 : 1;
    if (run > max) return true;
  }
  return false;
}

export function generatePassword(opts: PasswordOptions = DEFAULT_PASSWORD): string {
  const clean = (s: string) => (opts.avoidAmbiguous ? s.replace(AMBIGUOUS, "") : s);
  const required: string[] = [];
  if (opts.lower) required.push(clean(SETS.lower));
  if (opts.upper) required.push(clean(SETS.upper));
  if (opts.digits) required.push(clean(SETS.digit));
  if (opts.symbols) required.push(clean(SETS.symbol));
  if (!required.length) throw new Error("Pick at least one kind of character");
  const length = Math.max(opts.length, required.length);
  return assemble(length, required, required.join(""));
}

export function generatePin(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomInt(10));
  return out;
}

export type PassphraseOptions = { words: number; separator: string; capitalize: boolean; includeNumber: boolean };
export const DEFAULT_PASSPHRASE: PassphraseOptions = { words: 5, separator: "-", capitalize: false, includeNumber: false };

export function generatePassphrase(opts: PassphraseOptions = DEFAULT_PASSPHRASE): string {
  const words: string[] = [];
  for (let i = 0; i < Math.max(3, opts.words); i++) {
    let w = WORDLIST[randomInt(WORDLIST.length)];
    if (opts.capitalize) w = w[0].toUpperCase() + w.slice(1);
    words.push(w);
  }
  if (opts.includeNumber) {
    const at = randomInt(words.length);
    words[at] += String(randomInt(10));
  }
  return words.join(opts.separator);
}

export function generateUsername(style: "words" | "random" = "words"): string {
  if (style === "random") {
    let out = "";
    for (let i = 0; i < 12; i++) out += pick(SETS.lower + SETS.digit);
    return out;
  }
  return `${WORDLIST[randomInt(WORDLIST.length)]}.${WORDLIST[randomInt(WORDLIST.length)]}${randomInt(100)}`.replace(/-/g, "");
}

/** "me@x.com" + "shop" = "me+shop@x.com". Only works where the provider allows it. */
export function plusAddress(email: string, tag: string): string {
  const at = email.indexOf("@");
  if (at < 1) throw new Error("That isn't an email address");
  const clean = tag.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || generateUsername("random").slice(0, 6);
  return `${email.slice(0, at).split("+")[0]}+${clean}${email.slice(at)}`;
}

// ---- Site rules -------------------------------------------------------------

export type SiteRules = {
  minLength?: number;
  maxLength?: number;
  required: string[];
  allowed: string;
  maxConsecutive?: number;
};

function classOf(token: string): string {
  const t = token.trim();
  if (t === "lower") return SETS.lower;
  if (t === "upper") return SETS.upper;
  if (t === "digit") return SETS.digit;
  // "special" in Apple's format: ASCII printable punctuation.
  if (t === "special") return "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?/ ]".replace(/[ "'`\\]/g, "");
  if (t === "ascii-printable") return SETS.lower + SETS.upper + SETS.digit + SETS.symbol;
  if (t === "unicode") return SETS.lower + SETS.upper + SETS.digit + SETS.symbol;
  const custom = /^\[(.*)\]$/.exec(t);
  return custom ? custom[1] : "";
}

/** Split on a separator, except inside a [character class]. */
function splitOutsideBrackets(text: string, sep: string): string[] {
  const out: string[] = [];
  let at = "";
  let depth = 0;
  for (const c of text) {
    if (c === "[") depth = 1;
    else if (c === "]") depth = 0;
    if (c === sep && depth === 0) {
      out.push(at);
      at = "";
    } else at += c;
  }
  out.push(at);
  return out;
}

/** Reads a rule string such as ``minlength: 8; required: lower; allowed: [-_];``. */
export function parseRules(text: string): SiteRules {
  const out: SiteRules = { required: [], allowed: "" };
  const allowed = new Set<string>();
  const clean = text.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const part of splitOutsideBrackets(clean, ";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name === "minlength") out.minLength = Number(value);
    else if (name === "maxlength") out.maxLength = Number(value);
    else if (name === "max-consecutive") out.maxConsecutive = Number(value);
    else if (name === "required" || name === "allowed") {
      const union = splitOutsideBrackets(value, ",").map(classOf).join("");
      if (!union) continue;
      if (name === "required") out.required.push(union);
      for (const c of union) allowed.add(c);
    }
  }
  out.allowed = [...allowed].join("");
  return out;
}

export function rulesForHost(host: string): SiteRules | null {
  const table = RULES as Record<string, { "password-rules": string }>;
  const parts = host.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const hit = table[parts.slice(i).join(".")];
    if (hit) return parseRules(hit["password-rules"]);
  }
  return null;
}

/** A password this site will accept, as long as its rules allow, up to 20 by default. */
export function generateForRules(rules: SiteRules, wanted = 20): string {
  const min = rules.minLength ?? 1;
  const max = rules.maxLength ?? 64;
  const length = Math.min(Math.max(wanted, min), max);
  const allowed = rules.allowed || SETS.lower + SETS.upper + SETS.digit + SETS.symbol;
  const required = rules.required.length ? rules.required : [];
  // Required classes count against the length, so the length must fit them.
  return assemble(Math.max(length, required.length), required, allowed, rules.maxConsecutive);
}

export function generateForSite(host: string | null | undefined, opts: PasswordOptions = DEFAULT_PASSWORD): string {
  const rules = host ? rulesForHost(host) : null;
  return rules ? generateForRules(rules, opts.length) : generatePassword(opts);
}
