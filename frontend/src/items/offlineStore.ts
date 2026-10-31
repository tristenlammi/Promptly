/*
 * Items on this device (IndexedDB), so an item opens and keeps working with
 * no connection — the gym basement, a plane, the supermarket:
 *
 *   docs    the last state the server confirmed, per file (opens offline)
 *   outbox  changes not yet saved: a JSON patch against the revision they
 *           were made on — survives the phone killing the app; sent (or
 *           replayed onto a newer state) next time the file opens online
 *
 * Keyed by user + file, and wiped with the rest of a person's data when
 * someone else signs in on this browser (lib/session.ts).
 */
import type { ItemDoc } from "./api";
import type { PatchOp } from "./jsonpatch";

const DB = "promptly-items";
const VERSION = 1;

export interface Outbox {
  base_revision: number;
  ops: PatchOp[];
  at: string;
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs");
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode / storage blocked: online-only, as before
    }
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const key = (userId: string, fileId: string) => `${userId}:${fileId}`;

export const offlineStore = {
  getDoc: <T>(userId: string, fileId: string) =>
    run<ItemDoc<T>>("docs", "readonly", (s) => s.get(key(userId, fileId))),
  putDoc: (userId: string, doc: ItemDoc<unknown>) =>
    run("docs", "readwrite", (s) => s.put(doc, key(userId, doc.file_id))),
  getOutbox: (userId: string, fileId: string) => run<Outbox>("outbox", "readonly", (s) => s.get(key(userId, fileId))),
  putOutbox: (userId: string, fileId: string, box: Outbox) => run("outbox", "readwrite", (s) => s.put(box, key(userId, fileId))),
  clearOutbox: (userId: string, fileId: string) => run("outbox", "readwrite", (s) => s.delete(key(userId, fileId))),
  /** Everything, for everyone — a different person signed in. */
  async wipe(): Promise<void> {
    opening = null;
    try {
      indexedDB.deleteDatabase(DB);
    } catch {
      /* nothing stored */
    }
  },
};

/** True when a failed request means "no connection", not "refused". */
export function isOffline(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const e = err as { response?: { status?: number }; code?: string; message?: string } | undefined;
  if (!e) return false;
  // The proxy answering for a server that's down counts as offline too.
  if (e.response) return [502, 503, 504].includes(e.response.status ?? 0);
  return e.code === "ERR_NETWORK" || /network/i.test(e.message ?? "");
}
