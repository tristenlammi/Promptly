// Byte helpers shared by every client. No React, no DOM beyond WebCrypto.
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (i + 1 < b.length) s += B64URL[(n >> 6) & 63];
    if (i + 2 < b.length) s += B64URL[n & 63];
  }
  return s;
}

export function fromB64u(s: string): Uint8Array {
  // Accept standard base64 as well: imports and QR payloads use it.
  const clean = s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (clean.length % 4 === 1) throw new Error("bad base64");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of clean) {
    const v = B64URL.indexOf(c);
    if (v < 0) throw new Error("bad base64");
    value = ((value << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out;
}

/** Length-prefixed (u16 big-endian) field, the building block of every
 *  canonical encoding. Refuses anything that wouldn't fit rather than wrapping. */
export function lp(field: string | Uint8Array): Uint8Array {
  const raw = typeof field === "string" ? utf8(field) : field;
  if (raw.length > 0xffff) throw new Error("field too long");
  return concat(new Uint8Array([raw.length >> 8, raw.length & 255]), raw);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues caps at 64 KiB per call.
  for (let at = 0; at < n; at += 65536) {
    crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65536)));
  }
  return out;
}

export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** An unbiased random integer in [0, max). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 0x100000000) throw new Error("bad range");
  const limit = Math.floor(0x100000000 / max) * max;
  const word = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    if (word[0] < limit) return word[0] % max;
  }
}

/** WebCrypto's types want an ArrayBuffer-backed view. */
export const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => b as Uint8Array<ArrayBuffer>;
