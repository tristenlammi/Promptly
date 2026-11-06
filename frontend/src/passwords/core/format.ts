// Wire formats (CRYPTO_SPEC.md sections 3 and 4): versioned blobs, AAD, padding,
// signing input.
import { concat, lp, randomBytes, utf8 } from "./bytes";
import { aesGcmDecrypt, aesGcmEncrypt, aesKey, hkdf, x25519Public, x25519Shared } from "./primitives";

export const FORMAT_VERSION = 1;
export const ALG_AES_GCM = 1;
export const ALG_SEALED = 2;
const NONCE = 12;
const TAG = 16;

/** Additional data: ties a ciphertext to exactly one place in the vault. */
export function aad(scope: string, itemId: string, field: string): Uint8Array {
  return concat(new Uint8Array([0x50, 0x57, 0x41, 0x44, FORMAT_VERSION]), lp(scope), lp(itemId), lp(field));
}

export async function sealWithNonce(key: CryptoKey, nonce: Uint8Array, plain: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  const ct = await aesGcmEncrypt(key, nonce, plain, ad);
  return concat(new Uint8Array([FORMAT_VERSION, ALG_AES_GCM]), nonce, ct);
}

export function seal(key: CryptoKey, plain: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  return sealWithNonce(key, randomBytes(NONCE), plain, ad);
}

export async function open(key: CryptoKey, blob: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 2 + NONCE + TAG) throw new Error("blob too short");
  if (blob[0] !== FORMAT_VERSION) throw new Error("unknown format version");
  if (blob[1] !== ALG_AES_GCM) throw new Error("unknown algorithm");
  return aesGcmDecrypt(key, blob.subarray(2, 2 + NONCE), blob.subarray(2 + NONCE), ad);
}

// ---- Sealed box: X25519 + HKDF + AES-GCM. Anonymous, so signed separately. ----

const SEAL_INFO = "promptly-pw/v1/seal";

export async function sealToWith(
  ephSk: Uint8Array,
  nonce: Uint8Array,
  recipientPub: Uint8Array,
  plain: Uint8Array,
  ad: Uint8Array,
): Promise<Uint8Array> {
  const ephPub = x25519Public(ephSk);
  const key = await aesKey(await hkdf(x25519Shared(ephSk, recipientPub), concat(ephPub, recipientPub), SEAL_INFO));
  const ct = await aesGcmEncrypt(key, nonce, plain, ad);
  return concat(new Uint8Array([FORMAT_VERSION, ALG_SEALED]), ephPub, nonce, ct);
}

export function sealTo(recipientPub: Uint8Array, plain: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  return sealToWith(randomBytes(32), randomBytes(NONCE), recipientPub, plain, ad);
}

export async function openSealed(sk: Uint8Array, blob: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 2 + 32 + NONCE + TAG) throw new Error("blob too short");
  if (blob[0] !== FORMAT_VERSION) throw new Error("unknown format version");
  if (blob[1] !== ALG_SEALED) throw new Error("unknown algorithm");
  const ephPub = blob.subarray(2, 34);
  const key = await aesKey(await hkdf(x25519Shared(sk, ephPub), concat(ephPub, x25519Public(sk)), SEAL_INFO));
  return aesGcmDecrypt(key, blob.subarray(34, 34 + NONCE), blob.subarray(34 + NONCE), ad);
}

// ---- Padding: hide plaintext size in buckets. ----

const MIN_BUCKET = 256;
const LINEAR_FROM = 1 << 20;
const LINEAR_STEP = 1 << 18;

/** The padded size for a payload: powers of two to 1 MiB, then 256 KiB steps. */
export function bucketFor(payload: number): number {
  const need = payload + 4;
  if (need > LINEAR_FROM) return Math.ceil(need / LINEAR_STEP) * LINEAR_STEP;
  let size = MIN_BUCKET;
  while (size < need) size *= 2;
  return size;
}

export function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(bucketFor(data.length));
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new Error("bad padding");
  const n = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (n > padded.length - 4) throw new Error("bad padding");
  for (let i = 4 + n; i < padded.length; i++) if (padded[i] !== 0) throw new Error("bad padding");
  return padded.slice(4, 4 + n);
}

/** Bytes an Ed25519 signature covers: a purpose label plus length-prefixed fields. */
export function signingInput(purpose: string, fields: (string | Uint8Array)[]): Uint8Array {
  return concat(utf8("promptly-pw/v1/sig"), new Uint8Array([0]), lp(purpose), ...fields.map(lp));
}
