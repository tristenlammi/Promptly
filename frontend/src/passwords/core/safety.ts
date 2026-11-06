// Safety words (CRYPTO_SPEC.md section 7): both sides of a key exchange show the
// same words only if nobody swapped a key in the middle.
import { concat, lp, utf8 } from "./bytes";
import WORDS from "./eff_large_wordlist.json";
import { sha256 } from "./primitives";

export const WORDLIST: readonly string[] = WORDS as string[];

/** Each word takes two digest bytes, modulo the list length. The small bias
 *  doesn't matter for a string people compare by eye. */
export function wordsFromHash(digest: Uint8Array, count: number): string[] {
  if (count * 2 > digest.length) throw new Error("hash too short");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(WORDLIST[((digest[i * 2] << 8) | digest[i * 2 + 1]) % WORDLIST.length]);
  }
  return out;
}

export async function deviceSafetyWords(newDevicePub: Uint8Array, approverPub: Uint8Array): Promise<string[]> {
  const input = concat(utf8("promptly-pw/v1/device-words"), new Uint8Array([0]), lp(newDevicePub), lp(approverPub));
  return wordsFromHash(await sha256(input), 5);
}

export async function identityWords(userId: string, x25519Pub: Uint8Array, ed25519Pub: Uint8Array): Promise<string[]> {
  const input = concat(utf8("promptly-pw/v1/identity-words"), new Uint8Array([0]), lp(userId), lp(x25519Pub), lp(ed25519Pub));
  return wordsFromHash(await sha256(input), 6);
}
