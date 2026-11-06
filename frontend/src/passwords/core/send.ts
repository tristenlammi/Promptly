// Secure Send (CRYPTO_SPEC.md section 10). The key travels in the link's fragment,
// which browsers don't send to servers.
import type { VaultApi } from "./api";
import { b64u, fromB64u, fromUtf8, randomBytes, randomUuid, utf8 } from "./bytes";
import { aad, open, pad, seal, unpad } from "./format";
import { aesKey, argon2, hkdf, KDF_FLOOR } from "./primitives";

export type SendPayload =
  | { kind: "text"; title: string; text: string }
  | { kind: "file"; title: string; name: string; mime?: string; data: string };

export type SendCreateOptions = { days: number; views: number | null; password?: string };

export type SendMetaOut = { has_password: boolean; password_salt: string | null };

/** A file becomes base64 inside the blob, and the blob's limit is 10 MB. */
export const MAX_SEND_FILE = 7 * 1024 * 1024;

const EMPTY: Uint8Array = new Uint8Array(0);

async function fromPassword(password: string, salt: Uint8Array): Promise<{ proof: Uint8Array; mix: Uint8Array }> {
  const stretched = await argon2(utf8(password.normalize("NFKC")), salt, KDF_FLOOR);
  // Two separate outputs: what the server checks can't open anything.
  const proof = await hkdf(stretched, salt, "promptly-pw/v1/send-auth");
  const mix = await hkdf(stretched, salt, "promptly-pw/v1/send-mix");
  stretched.fill(0);
  return { proof, mix };
}

async function contentKey(sendKey: Uint8Array, mix: Uint8Array): Promise<CryptoKey> {
  return aesKey(await hkdf(sendKey, mix, "promptly-pw/v1/send"));
}

export async function createSend(api: VaultApi, baseUrl: string, payload: SendPayload, opts: SendCreateOptions): Promise<{ id: string; link: string }> {
  const id = randomUuid();
  const sendKey = randomBytes(32);
  let salt: Uint8Array | null = null;
  let proof: Uint8Array | null = null;
  let mix = EMPTY;
  if (opts.password) {
    salt = randomBytes(16);
    ({ proof, mix } = await fromPassword(opts.password, salt));
  }
  const blob = await seal(await contentKey(sendKey, mix), pad(utf8(JSON.stringify(payload))), aad(id, "", "send"));
  await api.request("POST", "/sends", {
    id,
    blob: b64u(blob),
    days: opts.days,
    views: opts.views,
    password_salt: salt ? b64u(salt) : null,
    password_proof: proof ? b64u(proof) : null,
  });
  return { id, link: `${baseUrl}/passwords/send/${id}#${b64u(sendKey)}` };
}

export function parseSendLink(pathname: string, hash: string): { id: string; key: string } | null {
  const m = /^\/passwords\/send\/([0-9a-f-]{36})\/?$/.exec(pathname);
  const key = hash.replace(/^#/, "");
  if (!m || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  return { id: m[1], key };
}

export function sendMeta(api: VaultApi, id: string): Promise<SendMetaOut> {
  return api.request<SendMetaOut>("GET", `/public/sends/${id}`, undefined, { public: true });
}

/** Uses up one view. */
export async function openSend(api: VaultApi, id: string, keyText: string, meta: SendMetaOut, password?: string): Promise<{ payload: SendPayload; viewsLeft: number | null }> {
  let proof: Uint8Array | null = null;
  let mix = EMPTY;
  if (meta.has_password) {
    if (!password || !meta.password_salt) throw new Error("This Send needs its password.");
    ({ proof, mix } = await fromPassword(password, fromB64u(meta.password_salt)));
  }
  const out = await api.request<{ blob: string; views_left: number | null }>("POST", `/public/sends/${id}/open`, { proof: proof ? b64u(proof) : null }, { public: true });
  const plain = await open(await contentKey(fromB64u(keyText), mix), fromB64u(out.blob), aad(id, "", "send"));
  return { payload: JSON.parse(fromUtf8(unpad(plain))) as SendPayload, viewsLeft: out.views_left };
}
