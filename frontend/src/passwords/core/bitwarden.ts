// Bitwarden's password-protected JSON export, from Bitwarden's public help pages and
// notes on the observed format (no client code; those clients are GPL). Bitwarden
// publishes no byte-level spec, and notes disagree on whether the salt is its base64
// text or the decoded bytes, so both are tried: the MAC decides. Not yet checked
// against a real export: see passwords/REPORT.md.
import { argon2d, argon2id } from "hash-wasm";

import { buf, concat, equalBytes, fromUtf8, utf8 } from "./bytes";

type Any = Record<string, unknown>;

function b64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function hkdfExpand(prk: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(prk), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(length);
  let t = new Uint8Array(0);
  let at = 0;
  for (let i = 1; at < length; i++) {
    t = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf(concat(t, utf8(info), new Uint8Array([i])))));
    out.set(t.subarray(0, Math.min(t.length, length - at)), at);
    at += t.length;
  }
  return out;
}

async function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, k, 256));
}

async function masterKey(password: string, salt: Uint8Array, data: Any): Promise<Uint8Array> {
  const kdfType = Number(data.kdfType ?? 0);
  const iterations = Number(data.kdfIterations ?? 0);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000_000) throw new Error("Unusual KDF settings in that file");
  if (kdfType === 0) return pbkdf2(utf8(password), salt, iterations);
  if (kdfType === 1) {
    const memory = Number(data.kdfMemory ?? 64);
    const parallelism = Number(data.kdfParallelism ?? 4);
    if (memory < 1 || memory > 4096 || parallelism < 1 || parallelism > 16) throw new Error("Unusual KDF settings in that file");
    // Bitwarden runs Argon2 with SHA-256 of the salt.
    const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(salt)));
    const opts = { password: utf8(password), salt: hashed, iterations, parallelism, memorySize: memory * 1024, hashLength: 32, outputType: "binary" as const };
    return argon2id(opts);
  }
  throw new Error("That file uses a key setting we don't know");
}

/** ``2.<iv>|<ct>|<mac>``: AES-256-CBC with HMAC-SHA256 over iv + ct, checked first. */
export async function decryptCipherString(s: string, enc: Uint8Array, mac: Uint8Array): Promise<Uint8Array> {
  const dot = s.indexOf(".");
  if (dot < 0 || s.slice(0, dot) !== "2") throw new Error("Unknown Bitwarden cipher type");
  const [iv, ct, tag] = s.slice(dot + 1).split("|").map(b64);
  if (!iv || !ct || !tag || iv.length !== 16 || tag.length !== 32) throw new Error("Damaged Bitwarden data");
  const hk = await crypto.subtle.importKey("raw", buf(mac), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", hk, buf(concat(iv, ct))));
  if (!equalBytes(expected, tag)) throw new Error("wrong password");
  const ak = await crypto.subtle.importKey("raw", buf(enc), "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: buf(iv) }, ak, buf(ct)));
}

export async function decryptBitwardenExport(data: Any, password: string): Promise<Any> {
  const saltText = String(data.salt ?? "");
  const validation = String(data.encKeyValidation_DO_NOT_EDIT ?? "");
  const payload = String(data.data ?? "");
  if (!saltText || !validation || !payload) throw new Error("That Bitwarden file is missing parts");
  const salts: Uint8Array[] = [utf8(saltText)];
  try {
    salts.push(b64(saltText));
  } catch {
    /* only the text form */
  }
  for (const salt of salts) {
    const master = await masterKey(password, salt, data);
    const enc = await hkdfExpand(master, "enc");
    const mac = await hkdfExpand(master, "mac");
    try {
      await decryptCipherString(validation, enc, mac);
    } catch {
      continue;
    }
    return JSON.parse(fromUtf8(await decryptCipherString(payload, enc, mac))) as Any;
  }
  throw new Error("That password didn't open the file");
}

export const _keep = argon2d;
