// The attachment path with a fake server: what goes up comes down in order, one chunk at a time,
// and a damaged or moved chunk never reaches whatever's being written to.
import { describe, expect, it } from "vitest";

import type { VaultApi } from "./api";
import { CHUNK, downloadAttachment, moveAttachment, streamAttachment, uploadAttachment } from "./attachments";

function fakeServer() {
  const blobs = new Map<string, Uint8Array>();
  let gets = 0;
  const api = {
    attachmentStart: async () => ({ received: [] as number[] }),
    attachmentPut: async (_v: string, id: string, i: number, blob: Uint8Array) => {
      blobs.set(`${id}:${i}`, new Uint8Array(blob));
      return {};
    },
    attachmentFinish: async () => ({}),
    attachmentGet: async (_v: string, id: string, i: number) => {
      gets++;
      const b = blobs.get(`${id}:${i}`);
      if (!b) throw new Error("missing");
      return b.slice().buffer;
    },
  } as unknown as VaultApi;
  return { api, blobs, gets: () => gets };
}

function fileOf(bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart]);
  return { name: "scan.pdf", size: bytes.length, slice: (a: number, b: number) => blob.slice(a, b) };
}

const sample = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) % 251);

describe("attachments", () => {
  it("streams chunk by chunk, fetching each only after the last was written", async () => {
    const s = fakeServer();
    const data = sample(CHUNK * 2 + 123);
    const ref = await uploadAttachment(s.api, "v1", "i1", fileOf(data));
    expect(ref.chunks).toBe(3);

    const seenAtWrite: number[] = [];
    const parts: Uint8Array[] = [];
    await streamAttachment(s.api, "v1", "i1", ref, async (p) => {
      seenAtWrite.push(s.gets());
      parts.push(p.slice());
    });
    expect(seenAtWrite).toEqual([1, 2, 3]);
    expect(parts.map((p) => p.length)).toEqual([CHUNK, CHUNK, 123]);
    expect(Buffer.concat(parts).equals(Buffer.from(data))).toBe(true);
  });

  it("gives the same bytes through the in-memory path", async () => {
    const s = fakeServer();
    const data = sample(5000);
    const ref = await uploadAttachment(s.api, "v1", "i1", fileOf(data));
    expect(Buffer.from(await downloadAttachment(s.api, "v1", "i1", ref)).equals(Buffer.from(data))).toBe(true);
  });

  it("stops at a damaged chunk, having written only what came before it", async () => {
    const s = fakeServer();
    const ref = await uploadAttachment(s.api, "v1", "i1", fileOf(sample(CHUNK + 10)));
    s.blobs.get(`${ref.id}:1`)![40] ^= 1;
    const written: number[] = [];
    await expect(streamAttachment(s.api, "v1", "i1", ref, (p) => void written.push(p.length))).rejects.toThrow();
    expect(written).toEqual([CHUNK]);
  });

  it("a reference copied to another item doesn't open, and a moved one does", async () => {
    const s = fakeServer();
    const data = sample(CHUNK + 50);
    const ref = await uploadAttachment(s.api, "v1", "old-item", fileOf(data));
    await expect(downloadAttachment(s.api, "v1", "kept-item", ref)).rejects.toThrow();
    const moved = await moveAttachment(s.api, { vaultId: "v1", itemId: "old-item" }, { vaultId: "v2", itemId: "kept-item" }, ref);
    expect(moved.id).not.toBe(ref.id);
    expect(moved.key).not.toBe(ref.key);
    expect(Buffer.from(await downloadAttachment(s.api, "v2", "kept-item", moved)).equals(Buffer.from(data))).toBe(true);
  });

  it("refuses chunks swapped by the server, a file moved to another item, and a short file", async () => {
    const s = fakeServer();
    const ref = await uploadAttachment(s.api, "v1", "i1", fileOf(sample(CHUNK + 10)));
    await expect(streamAttachment(s.api, "v1", "other-item", ref, () => undefined)).rejects.toThrow();
    await expect(streamAttachment(s.api, "other-vault", "i1", ref, () => undefined)).rejects.toThrow();

    const a = s.blobs.get(`${ref.id}:0`)!;
    s.blobs.set(`${ref.id}:0`, s.blobs.get(`${ref.id}:1`)!);
    s.blobs.set(`${ref.id}:1`, a);
    await expect(streamAttachment(s.api, "v1", "i1", ref, () => undefined)).rejects.toThrow();

    const t = fakeServer();
    const ref2 = await uploadAttachment(t.api, "v1", "i1", fileOf(sample(100)));
    await expect(streamAttachment(t.api, "v1", "i1", { ...ref2, size: 200 }, () => undefined)).rejects.toThrow(/damaged/);
    await expect(streamAttachment(t.api, "v1", "i1", { ...ref2, size: 50 }, () => undefined)).rejects.toThrow(/damaged/);
  });
});
