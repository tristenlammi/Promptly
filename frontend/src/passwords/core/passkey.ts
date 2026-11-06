// WebAuthn authenticator logic, in plain functions: ES256 keys in portable PKCS#8 form,
// authenticator data, attestation "none", assertions. Written from the W3C WebAuthn
// spec. Any client can use a passkey made by any other, so they sync, and iOS later.
import { getDomain } from "tldts";

import { b64u, buf, concat, fromB64u, randomBytes, utf8 } from "./bytes";
import type { Passkey } from "./model";

// ---- Which site may use which RP ID -------------------------------------------------

/** An RP ID must be the page's host, or a parent domain of it, and never a public
 *  suffix. Checked here, in the background, never in the page's world. */
export function rpIdAllowed(rpId: string, origin: string): boolean {
  let host: string;
  let scheme: string;
  try {
    const u = new URL(origin);
    host = u.hostname.toLowerCase();
    scheme = u.protocol;
  } catch {
    return false;
  }
  const rp = rpId.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost");
  if (scheme !== "https:" && !(scheme === "http:" && local)) return false;
  if (!rp || rp.includes("/") || rp.includes(":") || rp.startsWith(".")) return false;
  if (host !== rp && !host.endsWith(`.${rp}`)) return false;
  if (local) return rp === host || rp === "localhost" || host.endsWith(`.${rp}`);
  // Parent domains stop at the registrable domain.
  const registrable = getDomain(host, { allowPrivateDomains: true });
  if (!registrable) return rp === host;
  return rp === registrable || rp.endsWith(`.${registrable}`);
}

// ---- A tiny CBOR writer: only what attestation objects and COSE keys need ------------

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

export function cborInt(n: number): Uint8Array {
  return n >= 0 ? head(0, n) : head(1, -1 - n);
}
const cborBytes = (b: Uint8Array) => concat(head(2, b.length), b);
const cborText = (s: string) => {
  const u = utf8(s);
  return concat(head(3, u.length), u);
};

// ---- Keys ---------------------------------------------------------------------------

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

export async function newEs256Key(): Promise<{ pkcs8: Uint8Array; x: Uint8Array; y: Uint8Array }> {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pkcs8, x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

export async function publicKeyOf(pkcs8: Uint8Array): Promise<{ x: Uint8Array; y: Uint8Array; spki: Uint8Array }> {
  const priv = await crypto.subtle.importKey("pkcs8", buf(pkcs8), ALG, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }, ALG, true, ["verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pub));
  return { x: raw.slice(1, 33), y: raw.slice(33, 65), spki: new Uint8Array(await crypto.subtle.exportKey("spki", pub)) };
}

function coseEs256(x: Uint8Array, y: Uint8Array): Uint8Array {
  // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}, in canonical order.
  return concat(new Uint8Array([0xa5]), cborInt(1), cborInt(2), cborInt(3), cborInt(-7), cborInt(-1), cborInt(1), cborInt(-2), cborBytes(x), cborInt(-3), cborBytes(y));
}

/** WebCrypto gives r||s; WebAuthn wants ASN.1 DER. */
export function derSignature(rs: Uint8Array): Uint8Array {
  const part = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const t = b.slice(i);
    return t[0] & 0x80 ? concat(new Uint8Array([0]), t) : t;
  };
  const r = part(rs.slice(0, 32));
  const s = part(rs.slice(32, 64));
  const body = concat(new Uint8Array([2, r.length]), r, new Uint8Array([2, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function sha256(d: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(d)));
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08; // backup eligible: passkeys here sync
const FLAG_BS = 0x10; // backed up
const FLAG_AT = 0x40;

/** A passkey that syncs reports a counter of 0, as the spec expects of multi-device keys. */
async function authData(rpId: string, opts: { uv: boolean; attested?: Uint8Array }): Promise<Uint8Array> {
  const flags = FLAG_UP | (opts.uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | (opts.attested ? FLAG_AT : 0);
  return concat(await sha256(utf8(rpId)), new Uint8Array([flags, 0, 0, 0, 0]), opts.attested ?? new Uint8Array(0));
}

export type ClientData = { type: "webauthn.create" | "webauthn.get"; challenge: string; origin: string; crossOrigin: boolean; topOrigin?: string };

/** Key order and shape as the spec's serialization asks. */
export function clientDataJson(c: ClientData): string {
  const parts = [`"type":${JSON.stringify(c.type)}`, `"challenge":${JSON.stringify(c.challenge)}`, `"origin":${JSON.stringify(c.origin)}`, `"crossOrigin":${c.crossOrigin ? "true" : "false"}`];
  if (c.crossOrigin && c.topOrigin) parts.push(`"topOrigin":${JSON.stringify(c.topOrigin)}`);
  return `{${parts.join(",")}}`;
}

export type MakeRequest = { rpId: string; rpName?: string; userHandle: string; userName: string; userDisplayName?: string; challenge: string; origin: string; crossOrigin: boolean; topOrigin?: string; uv: boolean; discoverable: boolean };

export type MakeResult = {
  passkey: Passkey;
  credentialId: string;
  clientDataJSON: string;
  attestationObject: string;
  authenticatorData: string;
  publicKey: string; // SPKI
  publicKeyAlgorithm: number;
};

export async function makeCredential(req: MakeRequest, now = new Date()): Promise<MakeResult> {
  const key = await newEs256Key();
  const credId = randomBytes(32);
  const aaguid = new Uint8Array(16); // No make or model is claimed.
  const cose = coseEs256(key.x, key.y);
  const attested = concat(aaguid, new Uint8Array([0, credId.length]), credId, cose);
  const auth = await authData(req.rpId, { uv: req.uv, attested });
  const attestationObject = concat(new Uint8Array([0xa3]), cborText("fmt"), cborText("none"), cborText("attStmt"), new Uint8Array([0xa0]), cborText("authData"), cborBytes(auth));
  const { spki } = await publicKeyOf(key.pkcs8);
  const clientData = clientDataJson({ type: "webauthn.create", challenge: req.challenge, origin: req.origin, crossOrigin: req.crossOrigin, topOrigin: req.topOrigin });
  return {
    passkey: {
      credentialId: b64u(credId),
      rpId: req.rpId,
      rpName: req.rpName,
      userHandle: req.userHandle,
      userName: req.userName,
      userDisplayName: req.userDisplayName,
      key: b64u(key.pkcs8),
      alg: -7,
      signCount: 0,
      createdAt: now.toISOString(),
      discoverable: req.discoverable,
    },
    credentialId: b64u(credId),
    clientDataJSON: b64u(utf8(clientData)),
    attestationObject: b64u(attestationObject),
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    publicKeyAlgorithm: -7,
  };
}

export type AssertRequest = { passkey: Passkey; challenge: string; origin: string; crossOrigin: boolean; topOrigin?: string; uv: boolean };

export type AssertResult = { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string };

export async function getAssertion(req: AssertRequest): Promise<AssertResult> {
  const clientData = clientDataJson({ type: "webauthn.get", challenge: req.challenge, origin: req.origin, crossOrigin: req.crossOrigin, topOrigin: req.topOrigin });
  const clientBytes = utf8(clientData);
  const auth = await authData(req.passkey.rpId, { uv: req.uv });
  const key = await crypto.subtle.importKey("pkcs8", buf(fromB64u(req.passkey.key)), ALG, false, ["sign"]);
  const signed = concat(auth, await sha256(clientBytes));
  const rs = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(signed)));
  return {
    credentialId: req.passkey.credentialId,
    clientDataJSON: b64u(clientBytes),
    authenticatorData: b64u(auth),
    signature: b64u(derSignature(rs)),
    userHandle: req.passkey.userHandle,
  };
}

/** Passkeys in the vault this request may use: right RP, and on the allow list if given. */
export function usablePasskeys(all: { itemId: string; passkey: Passkey; title: string }[], rpId: string, allow: string[] | undefined) {
  return all.filter(({ passkey }) => passkey.rpId === rpId && (!allow?.length ? passkey.discoverable : allow.includes(passkey.credentialId)));
}
