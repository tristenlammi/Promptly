// Export: an encrypted file by default (CRYPTO_SPEC.md section 11), or plain text
// behind a warning. Made on the device; the server only hears that it happened.
import { b64u, fromB64u, fromUtf8, randomBytes, utf8 } from "./bytes";
import { aad, open, seal } from "./format";
import type { ImportResult } from "./importers";
import { normalizePassword } from "./keys";
import type { Item, ItemBody } from "./model";
import { aesKey, argon2, checkKdf, hkdf, KDF_FLOOR, type KdfParams } from "./primitives";

const EMPTY = new Uint8Array(0);

async function exportKey(password: string, salt: Uint8Array, kdf: KdfParams): Promise<CryptoKey> {
  checkKdf(kdf);
  const stretched = await argon2(normalizePassword(password), salt, kdf);
  return aesKey(await hkdf(stretched, EMPTY, "promptly-pw/v1/export"));
}

export async function encryptedExport(items: Item[], password: string, kdf: KdfParams = KDF_FLOOR): Promise<string> {
  const salt = randomBytes(16);
  const key = await exportKey(password, salt, kdf);
  const payload = { items: items.map((i) => i.body) };
  const blob = await seal(key, utf8(JSON.stringify(payload)), aad("export", "", "payload"));
  return JSON.stringify({ format: "promptly-pw-export", version: 1, kdf, salt: b64u(salt), data: b64u(blob) }, null, 1);
}

export async function readEncryptedExport(data: Record<string, unknown>, password: string): Promise<ImportResult> {
  if (data.version !== 1) throw new Error("That export is from a newer version");
  const key = await exportKey(password, fromB64u(String(data.salt)), data.kdf as KdfParams);
  let plain: Uint8Array;
  try {
    plain = await open(key, fromB64u(String(data.data)), aad("export", "", "payload"));
  } catch {
    throw new Error("That password didn't open the file");
  }
  const payload = JSON.parse(fromUtf8(plain)) as { items: ItemBody[] };
  return { format: "Promptly", items: payload.items.map((body) => ({ body })), warnings: [] };
}

export function plainJsonExport(items: Item[]): string {
  return JSON.stringify({ format: "promptly-pw-plain", version: 1, items: items.map((i) => i.body) }, null, 1);
}

function csvCell(v: string): string {
  // A leading =, +, - or @ would run as a formula if someone opens this in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Logins as CSV, in the column names other managers read. */
export function plainCsvExport(items: Item[]): string {
  const rows = [["name", "url", "username", "password", "otpauth", "notes"]];
  for (const i of items) {
    const b = i.body;
    if (b.kind !== "login") continue;
    rows.push([b.title, b.urls?.[0]?.url ?? "", b.username ?? "", b.password ?? "", b.totp?.secret ?? "", b.notes ?? ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
