// The encrypted offline copy every client keeps. Only ciphertext, wrapped keys and
// bookkeeping go in here, never a decrypted field. Web and extension use the
// IndexedDB version; tests use the in-memory one; Android and Windows have their own.

export type CachedAccount = {
  accountId: string;
  userId: string;
  kdf: { alg: "argon2id"; m: number; t: number; p: number };
  salt: string;
  wrappedKeyset: string;
  x25519Pub: string;
  ed25519Pub: string;
  kitConfirmed: boolean;
  kitCheckedAt: string | null;
};

export type CachedVault = {
  id: string;
  kind: "personal" | "shared";
  revision: number;
  /** The highest revision this device has ever seen. A lower one from the server
   *  is a rollback, and raises a warning instead of being accepted. */
  highWater: number;
  generation: number;
  name: string;
  role: string;
  wrappedKey: string;
  signature: string;
  grantedBy: string | null;
  memberGeneration: number;
  accepted: boolean;
  memberCount: number;
};

export type CachedItem = {
  id: string;
  vaultId: string;
  revision: number;
  blob: string | null;
  deleted: boolean;
  purged: boolean;
  updatedAt: string;
  /** Local edits not yet on the server. */
  dirty?: boolean;
  /** The blob this edit started from, for a three-way merge. */
  baseBlob?: string | null;
  purgeRequested?: boolean;
};

export interface LocalStore {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  getAccount(): Promise<CachedAccount | undefined>;
  putAccount(a: CachedAccount): Promise<void>;
  getVaults(): Promise<CachedVault[]>;
  putVault(v: CachedVault): Promise<void>;
  deleteVault(id: string): Promise<void>;
  getItems(vaultId: string): Promise<CachedItem[]>;
  getItem(id: string): Promise<CachedItem | undefined>;
  putItems(items: CachedItem[]): Promise<void>;
  deleteItem(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStore implements LocalStore {
  meta = new Map<string, unknown>();
  account?: CachedAccount;
  vaults = new Map<string, CachedVault>();
  items = new Map<string, CachedItem>();
  async getMeta<T>(key: string) {
    return this.meta.get(key) as T | undefined;
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
  }
  async deleteMeta(key: string) {
    this.meta.delete(key);
  }
  async getAccount() {
    return this.account;
  }
  async putAccount(a: CachedAccount) {
    this.account = a;
  }
  async getVaults() {
    return [...this.vaults.values()];
  }
  async putVault(v: CachedVault) {
    this.vaults.set(v.id, v);
  }
  async deleteVault(id: string) {
    this.vaults.delete(id);
    for (const [k, i] of this.items) if (i.vaultId === id) this.items.delete(k);
  }
  async getItems(vaultId: string) {
    return [...this.items.values()].filter((i) => i.vaultId === vaultId);
  }
  async getItem(id: string) {
    return this.items.get(id);
  }
  async putItems(items: CachedItem[]) {
    for (const i of items) this.items.set(i.id, i);
  }
  async deleteItem(id: string) {
    this.items.delete(id);
  }
  async clear() {
    this.meta.clear();
    this.account = undefined;
    this.vaults.clear();
    this.items.clear();
  }
}

const DB_VERSION = 1;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Its own database name, separate from anything the main app keeps. */
export class IdbStore implements LocalStore {
  private db: Promise<IDBDatabase>;

  constructor(name = "promptly-vault") {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore("meta");
        db.createObjectStore("vaults", { keyPath: "id" });
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("vaultId", "vaultId");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async tx(stores: string | string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    return (await this.db).transaction(stores, mode);
  }

  async getMeta<T>(key: string) {
    return (await promisify((await this.tx("meta", "readonly")).objectStore("meta").get(key))) as T | undefined;
  }
  async setMeta(key: string, value: unknown) {
    await promisify((await this.tx("meta", "readwrite")).objectStore("meta").put(value, key));
  }
  async deleteMeta(key: string) {
    await promisify((await this.tx("meta", "readwrite")).objectStore("meta").delete(key));
  }
  getAccount() {
    return this.getMeta<CachedAccount>("account");
  }
  putAccount(a: CachedAccount) {
    return this.setMeta("account", a);
  }
  async getVaults() {
    return (await promisify((await this.tx("vaults", "readonly")).objectStore("vaults").getAll())) as CachedVault[];
  }
  async putVault(v: CachedVault) {
    await promisify((await this.tx("vaults", "readwrite")).objectStore("vaults").put(v));
  }
  async deleteVault(id: string) {
    const tx = await this.tx(["vaults", "items"], "readwrite");
    tx.objectStore("vaults").delete(id);
    const items = tx.objectStore("items");
    const keys = await promisify(items.index("vaultId").getAllKeys(id));
    for (const k of keys) items.delete(k);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async getItems(vaultId: string) {
    return (await promisify((await this.tx("items", "readonly")).objectStore("items").index("vaultId").getAll(vaultId))) as CachedItem[];
  }
  async getItem(id: string) {
    return (await promisify((await this.tx("items", "readonly")).objectStore("items").get(id))) as CachedItem | undefined;
  }
  async putItems(list: CachedItem[]) {
    if (!list.length) return;
    const tx = await this.tx("items", "readwrite");
    const items = tx.objectStore("items");
    for (const i of list) items.put(i);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async deleteItem(id: string) {
    await promisify((await this.tx("items", "readwrite")).objectStore("items").delete(id));
  }
  async clear() {
    const tx = await this.tx(["meta", "vaults", "items"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("vaults").clear();
    tx.objectStore("items").clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
