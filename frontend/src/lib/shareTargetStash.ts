/**
 * Files shared into the installed Files PWA ("Share → Promptly Files",
 * R-211). The service worker receives the share POST, puts the files here
 * and redirects to Files; the page then hands them to the upload queue.
 *
 * IndexedDB because it's the one store both the worker and the page can
 * write Blobs to. Used from both sides, so no DOM or React imports.
 */

const DB_NAME = "promptly-share-target";
const STORE = "files";

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

/** Stash shared files (service worker side). */
export async function stashSharedFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const f of files) {
    // A File survives structured clone, but keep the name/type explicit
    // in case a browser hands back a bare Blob.
    store.add({ blob: f, name: f.name, type: f.type, at: Date.now() });
  }
  await done(tx);
  db.close();
}

/** Take every stashed file and clear the stash (page side). */
export async function takeSharedFiles(): Promise<File[]> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return [];
  }
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const rows: { blob: Blob; name: string; type: string }[] = await new Promise(
    (resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as never);
      req.onerror = () => reject(req.error);
    }
  );
  store.clear();
  await done(tx);
  db.close();
  return rows.map((r) =>
    r.blob instanceof File ? r.blob : new File([r.blob], r.name || "shared-file", { type: r.type })
  );
}
