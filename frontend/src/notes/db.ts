/*
 * Notes on this device (IndexedDB), so Notes opens and keeps working with no
 * connection — the supermarket with no signal, a plane:
 *
 *   known   the last copy of each note the server confirmed (cards and
 *           whole notes), plus notes still being written on this device
 *   outbox  changes not yet saved, in order — survives the phone killing
 *           the app; sent when the connection is back
 *   meta    small things (when the lists last loaded)
 *   uploads pictures and recordings not yet uploaded (their bytes too), so
 *           a recording made with no signal survives a closed tab
 *
 * Keyed by user, and wiped with the rest of a person's data when someone
 * else signs in on this browser (lib/session.ts). Same pattern as
 * ``items/offlineStore.ts``.
 */
import type { Known } from "./types";
import type { QueuedOp } from "./ops";

const DB = "promptly-notes";
const VERSION = 2;

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ["known", "outbox", "meta", "uploads"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode / storage blocked: online only
    }
  });
  return opening;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const t = db.transaction(store, mode);
          const req = fn(t.objectStore(store));
          t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
          t.onerror = () => resolve(undefined);
          t.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

/** Every value whose key starts with ``prefix``. */
function allWithPrefix<T>(store: string, prefix: string): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll(IDBKeyRange.bound(prefix, prefix + "￿"))).then((r) => r ?? []);
}

const seqKey = (uid: string, seq: number) => `${uid}:${String(seq).padStart(12, "0")}`;

export const notesDb = {
  loadKnown: (uid: string) => allWithPrefix<Known>("known", `${uid}:`),
  putKnown: (uid: string, k: Known) => tx("known", "readwrite", (s) => s.put(k, `${uid}:${k.note.id}`)),
  putKnownMany: (uid: string, ks: Known[]) =>
    tx("known", "readwrite", (s) => {
      for (const k of ks) s.put(k, `${uid}:${k.note.id}`);
    }),
  deleteKnown: (uid: string, ids: string[]) =>
    tx("known", "readwrite", (s) => {
      for (const id of ids) s.delete(`${uid}:${id}`);
    }),
  loadOutbox: (uid: string) => allWithPrefix<QueuedOp>("outbox", `${uid}:`),
  putOp: (uid: string, op: QueuedOp) => tx("outbox", "readwrite", (s) => s.put(op, seqKey(uid, op.seq))),
  deleteOps: (uid: string, seqs: number[]) =>
    tx("outbox", "readwrite", (s) => {
      for (const q of seqs) s.delete(seqKey(uid, q));
    }),
  /** Pictures and recordings still to upload (the File itself is kept). */
  loadUploads: <T>(uid: string) => allWithPrefix<T>("uploads", `${uid}:`),
  putUpload: (uid: string, aid: string, rec: unknown) => tx("uploads", "readwrite", (s) => s.put(rec, `${uid}:${aid}`)),
  deleteUpload: (uid: string, aid: string) => tx("uploads", "readwrite", (s) => s.delete(`${uid}:${aid}`)),
  getMeta: <T>(uid: string, key: string) => tx<T>("meta", "readonly", (s) => s.get(`${uid}:${key}`)),
  putMeta: (uid: string, key: string, value: unknown) => tx("meta", "readwrite", (s) => s.put(value, `${uid}:${key}`)),
  /** Everything, for everyone — a different person signed in. */
  async wipe(): Promise<void> {
    const db = await opening?.catch(() => null);
    db?.close();
    opening = null;
    try {
      indexedDB.deleteDatabase(DB);
    } catch {
      /* nothing stored */
    }
  },
};
