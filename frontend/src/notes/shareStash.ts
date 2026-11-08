/**
 * Text, pictures and recordings shared into the installed Notes app ("Share → Promptly Notes"). The
 * service worker receives the share (a POST, so the shared words never
 * sit in a URL or a server log), keeps it here and sends the app to
 * ``/notes/?shared=1``; the page makes it into a note. Used from both
 * sides, so no DOM or React imports.
 */

const DB = "promptly-notes-share";
const STORE = "shared";

export interface SharedText {
  /** Pictures and recordings shared along (or alone). */
  files?: File[];
  title: string;
  text: string;
  url: string;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Service worker side. */
export async function stashSharedText(s: Omit<SharedText, "at">): Promise<void> {
  if (!s.title && !s.text && !s.url && !s.files?.length) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ ...s, at: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Page side: everything shared, oldest first, and the stash emptied. */
export async function takeSharedText(): Promise<SharedText[]> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return [];
  }
  const rows = await new Promise<SharedText[]>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      store.clear();
      resolve((req.result as SharedText[]) ?? []);
    };
    req.onerror = () => resolve([]);
  });
  db.close();
  return rows.sort((a, b) => a.at - b.at);
}
