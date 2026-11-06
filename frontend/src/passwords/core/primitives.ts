// The only primitives the vault uses (CRYPTO_SPEC.md section 2). Platform
// WebCrypto for AES-GCM and HKDF, hash-wasm for Argon2id, @noble/curves for
// X25519 and Ed25519.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { argon2id } from "hash-wasm";

import { buf, utf8 } from "./bytes";

export type KdfParams = { alg: "argon2id"; m: number; t: number; p: number };

/** Below this we refuse: a hostile server can't talk a client into a weak KDF. */
export const KDF_FLOOR: KdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1 };
/** Above this we refuse too: a hostile server can't hang a client on unlock. */
export const KDF_CEILING = { m: 4 * 1024 * 1024, t: 32, p: 8 };

export function checkKdf(p: KdfParams): void {
  const ok =
    p.alg === "argon2id" &&
    [p.m, p.t, p.p].every((v) => Number.isInteger(v) && v > 0) &&
    p.m >= KDF_FLOOR.m &&
    p.t >= KDF_FLOOR.t &&
    p.p >= KDF_FLOOR.p &&
    p.m <= KDF_CEILING.m &&
    p.t <= KDF_CEILING.t &&
    p.p <= KDF_CEILING.p;
  if (!ok) throw new Error("KDF parameters outside the allowed range");
}

export async function argon2(password: Uint8Array, salt: Uint8Array, p: KdfParams, length = 32): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    memorySize: p.m,
    iterations: p.t,
    parallelism: p.p,
    hashLength: length,
    outputType: "binary",
  });
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8(info)) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(data)));
}

/** A key the page's JS can use but can't read back out. */
export async function aesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("AES-256 key must be 32 bytes");
  return crypto.subtle.importKey("raw", buf(raw), "AES-GCM", extractable, ["encrypt", "decrypt"]);
}

export async function aesGcmEncrypt(key: CryptoKey, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad), tagLength: 128 }, key, buf(plain)),
  );
}

export async function aesGcmDecrypt(key: CryptoKey, nonce: Uint8Array, ct: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad), tagLength: 128 }, key, buf(ct)),
  );
}

export function x25519Public(sk: Uint8Array): Uint8Array {
  return x25519.getPublicKey(sk);
}

export function x25519Shared(sk: Uint8Array, pub: Uint8Array): Uint8Array {
  // noble throws on the all-zero output (low-order public keys).
  return x25519.getSharedSecret(sk, pub);
}

export function ed25519Public(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

export function ed25519Sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, seed);
}

export function ed25519Verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}
