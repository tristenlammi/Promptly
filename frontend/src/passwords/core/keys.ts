// The key hierarchy (CRYPTO_SPEC.md section 5): master password + Secret Key.
import { b64u, concat, fromB64u, fromUtf8, lp, randomBytes, utf8 } from "./bytes";
import { aad, open, openSealed, pad, seal, sealTo, signingInput, unpad } from "./format";
import {
  aesKey,
  argon2,
  checkKdf,
  ed25519Public,
  ed25519Sign,
  ed25519Verify,
  hkdf,
  type KdfParams,
  sha256,
  x25519Public,
} from "./primitives";

const EMPTY = new Uint8Array(0);

// ---- Secret Key: 128 random bits, shown as PWK1-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX ----

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(data: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

async function secretKeyCheck(raw: Uint8Array): Promise<string> {
  const d = await sha256(concat(utf8("promptly-pw/v1/sk"), raw));
  const ten = (d[0] << 2) | (d[1] >> 6);
  return CROCKFORD[ten >> 5] + CROCKFORD[ten & 31];
}

export async function encodeSecretKey(raw: Uint8Array): Promise<string> {
  if (raw.length !== 16) throw new Error("Secret Key is 16 bytes");
  const body = base32(raw) + (await secretKeyCheck(raw));
  return `PWK1-${body.slice(0, 7)}-${body.slice(7, 14)}-${body.slice(14, 21)}-${body.slice(21, 28)}`;
}

/** Forgiving about case, spaces, dashes and look-alike letters; strict about
 *  the check digits, so a typo says so rather than failing the unlock later. */
export async function parseSecretKey(text: string): Promise<Uint8Array> {
  let s = text.toUpperCase().replace(/[\s-]/g, "");
  if (s.startsWith("PWK1")) s = s.slice(4);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== 28) throw new Error("That Secret Key is the wrong length");
  const raw = new Uint8Array(16);
  let value = 0;
  let bits = 0;
  let at = 0;
  for (const c of s.slice(0, 26)) {
    const v = CROCKFORD.indexOf(c);
    if (v < 0) throw new Error("That Secret Key has a character that isn't used");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      raw[at++] = (value >> (bits - 8)) & 255;
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  if ((await secretKeyCheck(raw)) !== s.slice(26)) throw new Error("That Secret Key has a typo in it");
  return raw;
}

export const newSecretKey = (): Uint8Array => randomBytes(16);

/** The group the user types back to prove they saved the kit. */
export const lastGroup = (encoded: string): string => encoded.slice(encoded.lastIndexOf("-") + 1);

// ---- Password + Secret Key -> keys ----

export type RootKeys = {
  /** Wraps the account keyset. Never leaves the device. */
  unlockKey: CryptoKey;
  /** Proves knowledge to the server. The server stores only a salted hash. */
  authKey: Uint8Array;
};

export function normalizePassword(password: string): Uint8Array {
  return utf8(password.normalize("NFKC"));
}

export async function deriveRootRaw(
  password: string,
  secretKey: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
): Promise<{ unlock: Uint8Array; auth: Uint8Array }> {
  checkKdf(params);
  if (salt.length !== 16) throw new Error("KDF salt must be 16 bytes");
  if (secretKey.length !== 16) throw new Error("Secret Key is 16 bytes");
  const stretched = await argon2(normalizePassword(password), salt, params);
  const ikm = await hkdf(concat(stretched, secretKey), EMPTY, "promptly-pw/v1/root");
  return {
    unlock: await hkdf(ikm, EMPTY, "promptly-pw/v1/unlock"),
    auth: await hkdf(ikm, EMPTY, "promptly-pw/v1/auth"),
  };
}

export async function deriveRoot(password: string, secretKey: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<RootKeys> {
  const { unlock, auth } = await deriveRootRaw(password, secretKey, salt, params);
  return { unlockKey: await aesKey(unlock), authKey: auth };
}

// ---- Account keyset ----

export type Keyset = {
  /** X25519 private key. */
  x25519: Uint8Array;
  /** Ed25519 seed. */
  ed25519: Uint8Array;
};

export type PublicKeys = { x25519: Uint8Array; ed25519: Uint8Array };

export const publicKeysOf = (k: Keyset): PublicKeys => ({ x25519: x25519Public(k.x25519), ed25519: ed25519Public(k.ed25519) });

export const newKeyset = (): Keyset => ({ x25519: randomBytes(32), ed25519: randomBytes(32) });

export function encodeKeyset(k: Keyset): Uint8Array {
  return concat(new Uint8Array([1]), k.x25519, k.ed25519);
}

export function decodeKeyset(b: Uint8Array): Keyset {
  if (b.length !== 65 || b[0] !== 1) throw new Error("bad keyset");
  return { x25519: b.slice(1, 33), ed25519: b.slice(33) };
}

export function wrapKeyset(unlockKey: CryptoKey, accountId: string, k: Keyset): Promise<Uint8Array> {
  return seal(unlockKey, encodeKeyset(k), aad(accountId, "", "keyset"));
}

export async function unwrapKeyset(unlockKey: CryptoKey, accountId: string, blob: Uint8Array): Promise<Keyset> {
  return decodeKeyset(await open(unlockKey, blob, aad(accountId, "", "keyset")));
}

// ---- Vault keys: sealed per member, signed by whoever granted them ----

export type MemberGrant = { wrapped: Uint8Array; signature: Uint8Array; grantedBy: string };

const vaultKeyAad = (vaultId: string, userId: string) => aad(vaultId, "", `vault_key:${userId}`);

export function grantInput(vaultId: string, userId: string, generation: number, wrapped: Uint8Array): Uint8Array {
  return signingInput("vault_key", [vaultId, userId, String(generation), wrapped]);
}

export async function grantVaultKey(
  grantor: { userId: string; keyset: Keyset },
  vaultId: string,
  member: { userId: string; x25519: Uint8Array },
  generation: number,
  vaultKey: Uint8Array,
): Promise<MemberGrant> {
  const wrapped = await sealTo(member.x25519, vaultKey, vaultKeyAad(vaultId, member.userId));
  const signature = ed25519Sign(grantor.keyset.ed25519, grantInput(vaultId, member.userId, generation, wrapped));
  return { wrapped, signature, grantedBy: grantor.userId };
}

/** Sealed boxes are anonymous, so the signature is what stops a hostile server
 *  handing someone a vault key it knows. The caller supplies the grantor's
 *  Ed25519 key from its own trust store, not from the same server response. */
export async function openVaultKey(
  me: { userId: string; keyset: Keyset },
  vaultId: string,
  generation: number,
  grant: MemberGrant,
  grantorEd25519: Uint8Array,
): Promise<Uint8Array> {
  if (!ed25519Verify(grant.signature, grantInput(vaultId, me.userId, generation, grant.wrapped), grantorEd25519)) {
    throw new Error("That vault key isn't signed by the person it claims to be from");
  }
  const raw = await openSealed(me.keyset.x25519, grant.wrapped, vaultKeyAad(vaultId, me.userId));
  if (raw.length !== 32) throw new Error("bad vault key");
  return raw;
}

// ---- Items: a random key per item, wrapped by the vault key ----

export async function sealItem(vaultKey: CryptoKey, vaultId: string, itemId: string, itemKeyRaw: Uint8Array, body: unknown): Promise<Uint8Array> {
  const wrapped = await seal(vaultKey, itemKeyRaw, aad(vaultId, itemId, "item_key"));
  const bodyBlob = await seal(await aesKey(itemKeyRaw), pad(utf8(JSON.stringify(body))), aad(vaultId, itemId, "body"));
  return concat(new Uint8Array([1]), lp(wrapped), bodyBlob);
}

export function encryptItem(vaultKey: CryptoKey, vaultId: string, itemId: string, body: unknown): Promise<Uint8Array> {
  return sealItem(vaultKey, vaultId, itemId, randomBytes(32), body);
}

export async function decryptItem<T = unknown>(vaultKey: CryptoKey, vaultId: string, itemId: string, blob: Uint8Array): Promise<T> {
  if (blob.length < 3 || blob[0] !== 1) throw new Error("unknown item format");
  const n = (blob[1] << 8) | blob[2];
  if (blob.length < 3 + n) throw new Error("item blob too short");
  const itemKeyRaw = await open(vaultKey, blob.subarray(3, 3 + n), aad(vaultId, itemId, "item_key"));
  const plain = await open(await aesKey(itemKeyRaw), blob.subarray(3 + n), aad(vaultId, itemId, "body"));
  return JSON.parse(fromUtf8(unpad(plain))) as T;
}

/** Encrypt a small named value (a vault's name, say) directly under a key. */
export async function sealField(key: CryptoKey, scope: string, field: string, value: unknown): Promise<string> {
  return b64u(await seal(key, pad(utf8(JSON.stringify(value))), aad(scope, "", field)));
}

export async function openField<T = unknown>(key: CryptoKey, scope: string, field: string, blob: string): Promise<T> {
  return JSON.parse(fromUtf8(unpad(await open(key, fromB64u(blob), aad(scope, "", field))))) as T;
}
