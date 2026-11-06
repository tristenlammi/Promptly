// Encrypted attachments (CRYPTO_SPEC.md section 9): 1 MiB chunks under a key of their
// own, recorded inside the item's body, so the server holds blobs it can't place.
import type { VaultApi } from "./api";
import { b64u, fromB64u, randomBytes, randomUuid } from "./bytes";
import { aad, open, seal } from "./format";
import type { AttachmentRef } from "./model";
import { aesKey } from "./primitives";

export const CHUNK = 1024 * 1024;

const chunkAad = (vaultId: string, itemId: string, id: string, i: number, total: number) => aad(vaultId, itemId, `att:${id}:${i}:${total}`);

export async function uploadAttachment(
  api: VaultApi,
  vaultId: string,
  itemId: string,
  file: { name: string; type?: string; size: number; slice: (a: number, b: number) => Blob },
  onProgress?: (done: number, total: number) => void,
  resume?: { id: string; key: string },
): Promise<AttachmentRef> {
  const id = resume?.id ?? randomUuid();
  const raw = resume ? fromB64u(resume.key) : randomBytes(32);
  const key = await aesKey(raw);
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK));
  const started = await api.attachmentStart(vaultId, { id, item_id: itemId, chunk_count: chunks });
  const have = new Set(started.received);
  for (let i = 0; i < chunks; i++) {
    if (have.has(i)) continue;
    const part = new Uint8Array(await file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK)).arrayBuffer());
    // Every chunk's the same size on the wire, the last one padded.
    const plain = new Uint8Array(CHUNK + 4);
    new DataView(plain.buffer).setUint32(0, part.length);
    plain.set(part, 4);
    const blob = await seal(key, plain, chunkAad(vaultId, itemId, id, i, chunks));
    await api.attachmentPut(vaultId, id, i, blob);
    onProgress?.(i + 1, chunks);
  }
  await api.attachmentFinish(vaultId, id);
  return { id, name: file.name, size: file.size, key: b64u(raw), chunks, mime: file.type || undefined };
}

/** Decrypts one chunk at a time, handing each on before the next is fetched. So a big file
 *  needn't fit in memory if `write` puts it on disk. A damaged chunk throws before it's written. */
export async function streamAttachment(api: VaultApi, vaultId: string, itemId: string, ref: AttachmentRef, write: (part: Uint8Array) => Promise<void> | void, onProgress?: (done: number, total: number) => void): Promise<void> {
  const key = await aesKey(fromB64u(ref.key));
  let at = 0;
  for (let i = 0; i < ref.chunks; i++) {
    const blob = await api.attachmentGet(vaultId, ref.id, i);
    const plain = await open(key, new Uint8Array(blob), chunkAad(vaultId, itemId, ref.id, i, ref.chunks));
    const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
    if (n > plain.length - 4 || at + n > ref.size) throw new Error("That attachment is damaged");
    await write(plain.subarray(4, 4 + n));
    at += n;
    onProgress?.(i + 1, ref.chunks);
  }
  if (at !== ref.size) throw new Error("That attachment is damaged");
}

export async function downloadAttachment(api: VaultApi, vaultId: string, itemId: string, ref: AttachmentRef, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const out = new Uint8Array(ref.size);
  let at = 0;
  await streamAttachment(api, vaultId, itemId, ref, (part) => {
    out.set(part, at);
    at += part.length;
  }, onProgress);
  return out;
}
