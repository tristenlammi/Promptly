// TOTP (RFC 6238), Steam Guard, otpauth:// links, and Google Authenticator's
// migration QR. Implemented from the RFCs and format notes, no third-party code.
import { buf, utf8 } from "./bytes";
import type { TotpConfig } from "./model";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEAM = "23456789BCDFGHJKMNPQRTVWXY";

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean) throw new Error("That secret is empty");
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error("That secret has characters base32 doesn't use");
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out;
}

export function base32Encode(data: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

async function hmac(hash: string, key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(msg)));
}

function counterBytes(counter: number): Uint8Array {
  const b = new Uint8Array(8);
  const view = new DataView(b.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  return b;
}

function truncate(mac: Uint8Array): number {
  const offset = mac[mac.length - 1] & 15;
  return ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
}

export function periodOf(cfg: TotpConfig): number {
  return cfg.steam ? 30 : cfg.period || 30;
}

export function secondsLeft(cfg: TotpConfig, now = Date.now()): number {
  const p = periodOf(cfg);
  return p - Math.floor(now / 1000) % p;
}

/** The code at a moment. ``clockDriftMs`` comes from comparing with the server's clock. */
export async function totpCode(cfg: TotpConfig, now = Date.now()): Promise<string> {
  const period = periodOf(cfg);
  const counter = Math.floor(now / 1000 / period);
  const key = cfg.steam ? base64Any(cfg.secret) : base32Decode(cfg.secret);
  if (cfg.steam) {
    let n = truncate(await hmac("SHA-1", key, counterBytes(counter)));
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += STEAM[n % STEAM.length];
      n = Math.floor(n / STEAM.length);
    }
    return code;
  }
  const alg = cfg.algorithm ?? "SHA1";
  const hash = alg === "SHA256" ? "SHA-256" : alg === "SHA512" ? "SHA-512" : "SHA-1";
  const digits = cfg.digits ?? 6;
  if (digits < 6 || digits > 8) throw new Error("TOTP digits must be 6 to 8");
  const n = truncate(await hmac(hash, key, counterBytes(counter)));
  return String(n % 10 ** digits).padStart(digits, "0");
}

function base64Any(s: string): Uint8Array {
  // Steam secrets are base64; some exports give base32. Base32's alphabet is
  // upper case and digits 2-7 with no padding worries, so try base64 only when
  // it clearly isn't base32.
  if (/^[A-Z2-7]+=*$/.test(s) && s.replace(/=+$/, "").length % 8 !== 1 && s.length % 4 !== 0) return base32Decode(s);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function parseOtpauth(uri: string): TotpConfig {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw new Error("That isn't a valid otpauth link");
  }
  if (u.protocol === "steam:") return { secret: uri.trim().slice("steam://".length), steam: true, issuer: "Steam" };
  if (u.protocol !== "otpauth:") throw new Error("That isn't an otpauth link");
  const type = u.hostname.toLowerCase();
  if (type !== "totp") throw new Error(type === "hotp" ? "Counter-based (HOTP) codes aren't supported yet" : "Unknown code type");
  const secret = u.searchParams.get("secret");
  if (!secret) throw new Error("That link has no secret");
  base32Decode(secret);
  const label = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const colon = label.indexOf(":");
  const issuer = u.searchParams.get("issuer") || (colon > 0 ? label.slice(0, colon).trim() : undefined);
  const alg = (u.searchParams.get("algorithm") || "SHA1").toUpperCase();
  const digits = Number(u.searchParams.get("digits") || 6);
  const period = Number(u.searchParams.get("period") || 30);
  if (!["SHA1", "SHA256", "SHA512"].includes(alg)) throw new Error("Unsupported algorithm");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("Unsupported number of digits");
  if (!Number.isInteger(period) || period < 1 || period > 3600) throw new Error("Unsupported period");
  return {
    secret: secret.toUpperCase().replace(/\s/g, ""),
    algorithm: alg as TotpConfig["algorithm"],
    digits,
    period,
    issuer,
    label: colon > 0 ? label.slice(colon + 1).trim() : label,
  };
}

export function toOtpauth(cfg: TotpConfig): string {
  const name = encodeURIComponent([cfg.issuer, cfg.label].filter(Boolean).join(":") || "code");
  const q = new URLSearchParams({ secret: cfg.secret });
  if (cfg.issuer) q.set("issuer", cfg.issuer);
  if (cfg.algorithm && cfg.algorithm !== "SHA1") q.set("algorithm", cfg.algorithm);
  if (cfg.digits && cfg.digits !== 6) q.set("digits", String(cfg.digits));
  if (cfg.period && cfg.period !== 30) q.set("period", String(cfg.period));
  return `otpauth://totp/${name}?${q}`;
}

// ---- otpauth-migration:// (a small protobuf, read by hand) ----

function* protoFields(data: Uint8Array): Generator<{ field: number; wire: number; varint?: number; bytes?: Uint8Array }> {
  let i = 0;
  const varint = (): number => {
    let shift = 0;
    let out = 0;
    for (;;) {
      if (i >= data.length) throw new Error("Truncated migration data");
      const b = data[i++];
      out += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return out;
      shift += 7;
      if (shift > 63) throw new Error("Bad migration data");
    }
  };
  while (i < data.length) {
    const tag = varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) yield { field, wire, varint: varint() };
    else if (wire === 2) {
      const n = varint();
      if (i + n > data.length) throw new Error("Truncated migration data");
      yield { field, wire, bytes: data.subarray(i, i + n) };
      i += n;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error("Bad migration data");
  }
}

/** All the TOTP entries in one migration QR. HOTP entries are returned in
 *  ``skipped``, since counter codes aren't supported yet. */
export function parseMigrationUri(uri: string): { codes: TotpConfig[]; skipped: number } {
  const u = new URL(uri.trim());
  if (u.protocol !== "otpauth-migration:") throw new Error("That isn't a migration link");
  const data = u.searchParams.get("data");
  if (!data) throw new Error("That link has no data");
  const bin = atob(data.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/"));
  const payload = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const codes: TotpConfig[] = [];
  let skipped = 0;
  const td = new TextDecoder();
  for (const f of protoFields(payload)) {
    if (f.field !== 1 || !f.bytes) continue;
    let secret: Uint8Array | null = null;
    let name = "";
    let issuer = "";
    let algorithm = 1;
    let digits = 1;
    let type = 2;
    for (const p of protoFields(f.bytes)) {
      if (p.field === 1 && p.bytes) secret = p.bytes;
      else if (p.field === 2 && p.bytes) name = td.decode(p.bytes);
      else if (p.field === 3 && p.bytes) issuer = td.decode(p.bytes);
      else if (p.field === 4) algorithm = p.varint ?? 1;
      else if (p.field === 5) digits = p.varint ?? 1;
      else if (p.field === 6) type = p.varint ?? 2;
    }
    if (!secret || type !== 2) {
      skipped++;
      continue;
    }
    const colon = name.indexOf(":");
    codes.push({
      secret: base32Encode(secret),
      algorithm: algorithm === 2 ? "SHA256" : algorithm === 3 ? "SHA512" : "SHA1",
      digits: digits === 2 ? 8 : 6,
      period: 30,
      issuer: issuer || (colon > 0 ? name.slice(0, colon) : undefined),
      label: colon > 0 ? name.slice(colon + 1).trim() : name,
    });
  }
  return { codes, skipped };
}

export const _test = { utf8 };
