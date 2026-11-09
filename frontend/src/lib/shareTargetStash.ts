/**
 * What was shared into an installed Promptly app from the phone's share
 * sheet: "Share → Promptly Files" (R-211) and "Share → Porch" (WP-P1.4).
 * The service worker receives the share POST, puts what came here under the
 * app's key, and redirects to that app; the page then takes its own things
 * (Files uploads them, Porch opens the composer with them). Each app takes
 * only what was shared to it, so a Files share never turns up in Porch.
 *
 * IndexedDB because it's the one store both the worker and the page can
 * write Blobs to. Used from both sides, so no DOM or React imports.
 */

const DB_NAME = "promptly-share-target";
const STORE = "files";

/** The installed apps that take shares. Rows from before the key existed are Files'. */
export type ShareApp = "files" | "porch";

interface Row {
  app?: ShareApp;
  /** A shared file (absent on a row that only carries text). */
  blob?: Blob;
  name?: string;
  type?: string;
  /** The shared title, text and link (Porch's caption). */
  text?: string;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Stash shared files, and any shared words, for ``app`` (service worker side). */
export async function stashSharedFiles(files: File[], app: ShareApp = "files", text = ""): Promise<void> {
  if (!files.length && !text) return;
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const at = Date.now();
  for (const f of files) {
    // A File survives structured clone, but keep the name/type explicit
    // in case a browser hands back a bare Blob.
    store.add({ app, blob: f, name: f.name, type: f.type, at } satisfies Row);
  }
  if (text) store.add({ app, text, at } satisfies Row);
  await done(tx);
  db.close();
}

/** Take everything stashed for ``app`` and clear it (page side). */
export async function takeShared(app: ShareApp): Promise<{ files: File[]; text: string }> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return { files: [], text: "" };
  }
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const rows: Row[] = await new Promise((resolve, reject) => {
    const out: Row[] = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve(out);
        return;
      }
      const row = cur.value as Row;
      if ((row.app ?? "files") === app) {
        out.push(row);
        cur.delete();
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await done(tx);
  db.close();
  const files = rows
    .filter((r) => r.blob)
    .map((r) => (r.blob instanceof File ? r.blob : new File([r.blob as Blob], r.name || "shared-file", { type: r.type })));
  const text = rows
    .map((r) => r.text?.trim())
    .filter(Boolean)
    .join("\n");
  return { files, text };
}

/** Take every file shared to Files and clear them (page side). */
export async function takeSharedFiles(): Promise<File[]> {
  return (await takeShared("files")).files;
}
