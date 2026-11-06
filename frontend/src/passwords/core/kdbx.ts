// KeePass KDBX 4 reader, from the format's public documentation. Read-only. The
// fixture in tests was written by pykeepass, an independent implementation. KDBX 3
// files get a message asking to export XML or re-save as 4.
import { chacha20 } from "@noble/ciphers/chacha.js";
import { strFromU8, gunzipSync } from "fflate";
import { argon2d, argon2id } from "hash-wasm";

import { buf, concat, equalBytes, utf8 } from "./bytes";
import type { ImportResult, Imported } from "./importers";
import { keepassItem } from "./importers";

const AES_KDF = "c9d9f39a628a4460bf740d08c18a4fea";
const ARGON2D = "ef636ddf8c29444b91f7a9a403e30a0c";
const ARGON2ID = "9e298b1956db4773b23dfc3ec6f0a1e6";
const CIPHER_AES = "31c1f2e6bf714350be5805216afc5aff";
const CIPHER_CHACHA = "d6038a2b8b6f4cb5a524339a31dbb59a";

const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", buf(d)));
const sha512 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-512", buf(d)));

function u32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
}

/** KDBX's variant dictionary. */
function variantDict(b: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let i = 2;
  while (i < b.length) {
    const type = b[i++];
    if (type === 0) break;
    const keyLen = u32(b, i);
    i += 4;
    if (keyLen > 1024 || i + keyLen > b.length) throw new Error("Damaged KeePass header");
    const key = strFromU8(b.subarray(i, i + keyLen));
    i += keyLen;
    const valLen = u32(b, i);
    i += 4;
    if (i + valLen > b.length) throw new Error("Damaged KeePass header");
    out.set(key, b.subarray(i, i + valLen));
    i += valLen;
  }
  return out;
}

const num = (v: Uint8Array | undefined): number => {
  if (!v) throw new Error("Damaged KeePass header");
  const d = new DataView(v.buffer, v.byteOffset, v.byteLength);
  if (v.length === 8) return Number(d.getBigUint64(0, true));
  return d.getUint32(0, true);
};

async function aesKdf(key: Uint8Array, seed: Uint8Array, rounds: number): Promise<Uint8Array> {
  if (rounds > 200_000_000) throw new Error("Unusual KDF settings in that file");
  // AES-ECB rounds through CBC with a zero IV, one 16-byte block at a time would be
  // too slow in WebCrypto; KDBX 4's default is Argon2, so this path is rare.
  const k = await crypto.subtle.importKey("raw", buf(seed), "AES-CBC", false, ["encrypt"]);
  const iv = new Uint8Array(16);
  let block: Uint8Array = key.slice();
  for (let i = 0; i < rounds; i++) {
    const left = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, k, buf(block.subarray(0, 16))));
    const right = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, k, buf(block.subarray(16, 32))));
    block = concat(left.subarray(0, 16), right.subarray(0, 16));
  }
  return sha256(block);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

export async function fromKdbx(file: Uint8Array, password: string): Promise<ImportResult> {
  if (file.length < 12 || u32(file, 0) !== 0x9aa2d903 || u32(file, 4) !== 0xb54bfb67) throw new Error("That isn't a KeePass database");
  const major = (file[10] | (file[11] << 8)) >>> 0;
  if (major !== 4) throw new Error("That's an older KeePass format. Open it in KeePass, save as KDBX 4 or export XML, and try again.");

  let at = 12;
  let cipher = "";
  let compression = 0;
  let masterSeed: Uint8Array | null = null;
  let iv: Uint8Array | null = null;
  let kdf: Map<string, Uint8Array> | null = null;
  for (;;) {
    const id = file[at++];
    const len = u32(file, at);
    at += 4;
    if (at + len > file.length) throw new Error("Damaged KeePass header");
    const v = file.subarray(at, at + len);
    at += len;
    if (id === 0) break;
    if (id === 2) cipher = hexOf(v);
    else if (id === 3) compression = u32(v, 0);
    else if (id === 4) masterSeed = v;
    else if (id === 7) iv = v;
    else if (id === 11) kdf = variantDict(v);
  }
  if (!masterSeed || !iv || !kdf || !cipher) throw new Error("Damaged KeePass header");
  const headerEnd = at;
  const headerHash = file.subarray(at, at + 32);
  const headerMac = file.subarray(at + 32, at + 64);
  at += 64;
  if (!equalBytes(await sha256(file.subarray(0, headerEnd)), headerHash)) throw new Error("That KeePass file is damaged");

  const composite = await sha256(await sha256(utf8(password.normalize("NFC"))));
  const uuid = hexOf(kdf.get("$UUID") ?? new Uint8Array(0));
  let transformed: Uint8Array;
  if (uuid === ARGON2D || uuid === ARGON2ID) {
    const m = num(kdf.get("M"));
    const t = num(kdf.get("I"));
    const p = num(kdf.get("P"));
    if (m > 8 * 1024 * 1024 * 1024 || t > 100_000 || p > 64) throw new Error("Unusual KDF settings in that file");
    const opts = { password: composite, salt: kdf.get("S")!, memorySize: Math.floor(m / 1024), iterations: t, parallelism: p, hashLength: 32, outputType: "binary" as const };
    transformed = uuid === ARGON2D ? await argon2d(opts) : await argon2id(opts);
  } else if (uuid === AES_KDF) {
    transformed = await aesKdf(composite, kdf.get("S")!, num(kdf.get("R")));
  } else {
    throw new Error("That file uses a key setting we don't know");
  }

  const encKey = await sha256(concat(masterSeed, transformed));
  const hmacBase = await sha512(concat(masterSeed, transformed, new Uint8Array([1])));

  const blockKey = async (index: bigint) => {
    const n = new Uint8Array(8);
    new DataView(n.buffer).setBigUint64(0, index, true);
    return sha512(concat(n, hmacBase));
  };
  // The header's MAC says whether the password was right, before anything else.
  if (!equalBytes(await hmacSha256(await blockKey(0xffffffffffffffffn), file.subarray(0, headerEnd)), headerMac)) {
    throw new Error("That password didn't open the file");
  }

  const blocks: Uint8Array[] = [];
  let index = 0n;
  for (;;) {
    const mac = file.subarray(at, at + 32);
    const len = u32(file, at + 32);
    const data = file.subarray(at + 36, at + 36 + len);
    if (at + 36 + len > file.length) throw new Error("That KeePass file is damaged");
    const indexBytes = new Uint8Array(8);
    new DataView(indexBytes.buffer).setBigUint64(0, index, true);
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, len, true);
    if (!equalBytes(await hmacSha256(await blockKey(index), concat(indexBytes, lenBytes, data)), mac)) throw new Error("That KeePass file is damaged");
    at += 36 + len;
    if (len === 0) break;
    blocks.push(data);
    index++;
  }
  const ct = concat(...blocks);

  let plain: Uint8Array;
  if (cipher === CIPHER_AES) {
    const k = await crypto.subtle.importKey("raw", buf(encKey), "AES-CBC", false, ["decrypt"]);
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: buf(iv) }, k, buf(ct)));
  } else if (cipher === CIPHER_CHACHA) {
    plain = chacha20(encKey, iv, ct);
  } else {
    throw new Error("That file uses a cipher we don't know");
  }
  if (compression === 1) plain = gunzipSync(plain);

  // Inner header: the inner stream's key.
  let p = 0;
  let innerId = 0;
  let innerKey: Uint8Array | null = null;
  for (;;) {
    const id = plain[p++];
    const len = u32(plain, p);
    p += 4;
    const v = plain.subarray(p, p + len);
    p += len;
    if (id === 0) break;
    if (id === 1) innerId = u32(v, 0);
    else if (id === 2) innerKey = v;
  }
  if (innerId !== 3 || !innerKey) throw new Error("That file's inner protection isn't ChaCha20, which we need.");
  const inner = await sha512(innerKey);
  const stream = { key: inner.subarray(0, 32), nonce: inner.subarray(32, 44), used: 0, buffer: new Uint8Array(0) as Uint8Array };

  const xmlText = strFromU8(plain.subarray(p));
  if (/<!ENTITY/i.test(xmlText)) throw new Error("That file defines its own XML entities, which we don't accept.");
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file's contents couldn't be read");

  const takeKeystream = (n: number): Uint8Array => {
    // The inner stream runs continuously over every protected value in document order.
    while (stream.buffer.length < n) {
      const more = chacha20(stream.key, stream.nonce, new Uint8Array(4096 + n), undefined, stream.used);
      stream.used += Math.ceil(more.length / 64);
      stream.buffer = concat(stream.buffer, more);
    }
    const out = stream.buffer.subarray(0, n);
    stream.buffer = stream.buffer.subarray(n);
    return out;
  };

  const items: Imported[] = [];
  const decodeProtected = (value: Element): string => {
    const raw = Uint8Array.from(atob(value.textContent ?? ""), (c) => c.charCodeAt(0));
    const ks = takeKeystream(raw.length);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ ks[i];
    return strFromU8(out);
  };

  // Depth first in document order, because of the stream.
  const walk = (el: Element, path: string[], depth: number, record: boolean) => {
    if (depth > 64) throw new Error("Those groups nest too deeply");
    for (const child of [...el.children]) {
      if (child.tagName === "Group") {
        const name = [...child.children].find((c) => c.tagName === "Name")?.textContent ?? "";
        walk(child, depth === 0 ? [] : [...path, name], depth + 1, record);
      } else if (child.tagName === "Entry") {
        const strings = new Map<string, string>();
        for (const c of [...child.children]) {
          if (c.tagName === "String") {
            const key = [...c.children].find((x) => x.tagName === "Key")?.textContent ?? "";
            const value = [...c.children].find((x) => x.tagName === "Value");
            if (!value) continue;
            strings.set(key, value.getAttribute("Protected") === "True" ? decodeProtected(value) : value.textContent ?? "");
          } else if (c.tagName === "History") {
            // History entries consume the stream but aren't imported.
            walk(c, path, depth + 1, false);
          }
        }
        if (record) items.push(keepassItem(strings, path.join("/") || undefined));
      }
    }
  };
  const root = doc.querySelector("KeePassFile > Root");
  if (!root) throw new Error("That file's contents couldn't be read");
  walk(root, [], 0, true);
  return { format: "KeePass", items, warnings: [] };
}
