/**
 * Street addresses in ordinary writing, for any app that shows text someone
 * else wrote (Rooms messages, Mail). Pure functions, unit-tested
 * (addresses.test.ts).
 *
 * Deliberately narrow: a number, capitalised words, a road word ("342
 * Palmwoods-Montville Road", "12 Smith St, Baringa"), so ordinary sentences
 * aren't turned into links. The short road words that are also titles ("Dr",
 * "St") don't count before a name.
 */
const ADDRESS_SOURCE =
  "\\b\\d{1,5}[A-Za-z]?(?:[-/]\\d{1,5})?\\s+(?:[A-Z][A-Za-z']+[ -]){1,4}(?:Street|Road|Rd|Avenue|Ave|Drive|Court|Place|Lane|Ln|Terrace|Tce|Parade|Pde|Boulevard|Blvd|Crescent|Cres|Highway|Hwy|Circuit|Cct|Close|(?:St|Dr|Ct|Pl|Cl|Way)(?!\\s+[A-Z][a-z]))\\b(?:,\\s*[A-Z][A-Za-z]+(?:\\s[A-Z][A-Za-z]+)?)?";

/** A fresh matcher each time: a shared global one would carry its place between callers. */
export function addressPattern(): RegExp {
  return new RegExp(ADDRESS_SOURCE, "g");
}

/** The different addresses in a piece of text, in the order they appear. */
export function findAddresses(text: string, limit = 3): string[] {
  if (!text || !/\d/.test(text)) return [];
  const found: string[] = [];
  // Web addresses and email addresses can hold a number and a capital: skip them.
  for (const part of text.split(/https?:\/\/\S+|\S+@\S+/g)) {
    for (const m of part.matchAll(addressPattern())) {
      const address = m[0].replace(/\s+/g, " ").trim();
      if (!found.some((f) => f.toLowerCase() === address.toLowerCase())) found.push(address);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/** The text in pieces, so the addresses in it can be drawn as buttons. */
export function splitAddresses(text: string): { text: string; address: boolean }[] {
  if (!text || !/\d/.test(text)) return [{ text, address: false }];
  const out: { text: string; address: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(addressPattern())) {
    const start = m.index ?? 0;
    // Inside a web or email address: not a place.
    const before = text.slice(Math.max(0, start - 200), start);
    if (/(?:https?:\/\/|@)\S*$/.test(before)) continue;
    if (start > at) out.push({ text: text.slice(at, start), address: false });
    out.push({ text: m[0], address: true });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), address: false });
  return out;
}
