// The vault client, shared by web, extension and desktop. No React, no DOM. Keys
// live in this object's memory only; lock() drops them. See CRYPTO_SPEC.md.
import { ApiError, OfflineError, type SessionOut, type VaultApi, type VaultOut } from "./api";
import { b64u, fromB64u, hex, randomBytes, randomUuid, utf8, fromUtf8 } from "./bytes";
import { aad, openSealed, sealTo } from "./format";
import {
  decryptItem,
  deriveRoot,
  deriveRootRaw,
  encodeKeyset,
  encryptItem,
  grantVaultKey,
  type Keyset,
  newKeyset,
  newSecretKey,
  openField,
  openVaultKey,
  publicKeysOf,
  sealField,
  unwrapKeyset,
  wrapKeyset,
} from "./keys";
import { isSystem, type Item, type ItemBody, mergeBodies, newBody, searchText, touch, type TrustBook, type TrustEntry } from "./model";
import { aesKey, KDF_FLOOR, type KdfParams, x25519Public } from "./primitives";
import { deviceSafetyWords, identityWords } from "./safety";
import type { CachedAccount, CachedItem, CachedVault, LocalStore } from "./store";

export type VaultInfo = CachedVault & { displayName: string };
export type SyncResult = { pulled: number; pushed: number; conflicts: number; offline: boolean; rollback: string[] };

type Unlocked = {
  keyset: Keyset;
  authKey: Uint8Array;
  userId: string;
  accountId: string;
  /** Raw vault keys stay out of JS where they can: CryptoKeys are non-extractable. */
  vaultKeys: Map<string, CryptoKey>;
  items: Map<string, Item>;
  search: Map<string, string>;
};

const SECRET_META = "secret_key";
const DEVICE_KEY_META = "device_key";

export class WrongPasswordError extends Error {
  constructor() {
    super("That master password or Secret Key isn't right");
  }
}

export class VaultClient {
  private state: Unlocked | null = null;
  onChange?: () => void;
  serverTimeOffsetMs = 0;
  minKdf: KdfParams | null = null;
  /** Vaults that can't open because whoever gave us the key now has a different one. */
  keyChanges = new Map<string, KeyChangedError>();
  private roles = new Map<string, string>();
  lastSyncAt: number | null = null;
  rollbackWarnings: string[] = [];

  constructor(
    public api: VaultApi,
    public store: LocalStore,
    public platform = "web",
  ) {}

  get unlocked(): boolean {
    return this.state !== null;
  }

  get userId(): string | null {
    return this.state?.userId ?? null;
  }

  private need(): Unlocked {
    if (!this.state) throw new Error("The vault is locked");
    return this.state;
  }

  // ---- Secret Key on this device ------------------------------------------

  /** Wrapped under a non-extractable key that only this browser profile holds,
   *  so a copied IndexedDB file alone doesn't give the Secret Key. Script running
   *  on this origin could still use the key: see SECURITY.md. */
  async saveSecretKey(raw: Uint8Array): Promise<void> {
    let key = await this.store.getMeta<CryptoKey>(DEVICE_KEY_META);
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await this.store.setMeta(DEVICE_KEY_META, key);
    }
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, key, raw as Uint8Array<ArrayBuffer>);
    await this.store.setMeta(SECRET_META, { iv: b64u(iv), ct: b64u(new Uint8Array(ct)) });
  }

  async loadSecretKey(): Promise<Uint8Array | null> {
    const stored = await this.store.getMeta<{ iv: string; ct: string }>(SECRET_META);
    const key = await this.store.getMeta<CryptoKey>(DEVICE_KEY_META);
    if (!stored || !key) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(stored.iv) as Uint8Array<ArrayBuffer> }, key, fromB64u(stored.ct) as Uint8Array<ArrayBuffer>);
    return new Uint8Array(plain);
  }

  async hasDeviceKit(): Promise<boolean> {
    return (await this.store.getMeta(SECRET_META)) !== undefined;
  }

  // ---- Setup and unlock ----------------------------------------------------

  /** Create the account. Returns the Secret Key's raw bytes for the recovery kit. */
  async setup(password: string, wanted: KdfParams = KDF_FLOOR): Promise<{ secretKey: Uint8Array }> {
    await this.refreshServerFacts();
    const kdf = this.strongerKdf(wanted);
    const secretKey = newSecretKey();
    const salt = randomBytes(16);
    const accountId = randomUuid();
    const vaultId = randomUuid();
    const { unlockKey, authKey } = await deriveRoot(password, secretKey, salt, kdf);
    const keyset = newKeyset();
    const pub = publicKeysOf(keyset);
    const vaultKeyRaw = randomBytes(32);
    const vaultKey = await aesKey(vaultKeyRaw);
    // The grant is bound to the user id, which prelogin tells us.
    const userId = (await this.api.prelogin()).user_id;
    const me = { userId, keyset };
    const grant = await grantVaultKey(me, vaultId, { userId, x25519: pub.x25519 }, 1, vaultKeyRaw);
    const session = await this.api.createAccount({
      account_id: accountId,
      kdf,
      salt: b64u(salt),
      auth_key: b64u(authKey),
      wrapped_keyset: b64u(await wrapKeyset(unlockKey, accountId, keyset)),
      x25519_pub: b64u(pub.x25519),
      ed25519_pub: b64u(pub.ed25519),
      personal_vault_id: vaultId,
      personal_vault_name: await sealField(vaultKey, vaultId, "name", "Personal"),
      personal_vault_grant: { wrapped_key: b64u(grant.wrapped), signature: b64u(grant.signature) },
    });
    this.api.session = session.token;
    await this.saveSecretKey(secretKey);
    await this.cacheAccount(session, { setup: true });
    this.state = { keyset, authKey, userId, accountId, vaultKeys: new Map(), items: new Map(), search: new Map() };
    await this.store.setMeta("personal_vault", vaultId);
    await this.sync();
    return { secretKey };
  }

  /** A different account here means someone else signed in, or a server trying to wipe this
   *  device's trust and unsynced edits. It only counts if the new keyset really opens. */
  private async cacheAccount(s: SessionOut, opts: { unlockKey?: CryptoKey; setup?: boolean } = {}): Promise<void> {
    const prev = await this.store.getAccount();
    if (prev && prev.accountId !== s.account_id && !opts.setup) {
      if (!opts.unlockKey) throw new Error("The server says this is a different account. Lock and unlock again to check.");
      try {
        await unwrapKeyset(opts.unlockKey, s.account_id, fromB64u(s.wrapped_keyset));
      } catch {
        throw new WrongPasswordError();
      }
    }
    const account: CachedAccount = {
      accountId: s.account_id,
      userId: s.user_id,
      kdf: s.kdf,
      salt: s.salt,
      wrappedKeyset: s.wrapped_keyset,
      x25519Pub: s.x25519_pub,
      ed25519Pub: s.ed25519_pub,
      kitConfirmed: s.kit_confirmed,
      kitCheckedAt: s.kit_checked_at,
    };
    // A different account signed in on this device: don't mix their data.
    if (prev && prev.accountId !== account.accountId) {
      await this.store.clear();
    }
    await this.store.putAccount(account);
  }

  /** Unlock with the master password. Online, this also proves ``auth_key`` for a
   *  session; offline, the local copy opens with no server at all. */
  async unlock(password: string, secretKeyOverride?: Uint8Array, opts: { keepSecret?: boolean } = {}): Promise<{ offline: boolean; secret?: Uint8Array }> {
    const secretKey = secretKeyOverride ?? (await this.loadSecretKey());
    if (!secretKey) throw new Error("This device doesn't have your Secret Key yet");
    let cached = await this.store.getAccount();
    let kdf = cached?.kdf;
    let salt = cached?.salt;
    let offline = false;
    let preWrapped: string | null = null;
    let preAccount: string | null = null;
    try {
      const pre = await this.api.prelogin();
      this.serverTimeOffsetMs = new Date(pre.server_time).getTime() - Date.now();
      this.minKdf = pre.min_kdf;
      if (pre.exists && pre.kdf && pre.salt) {
        // Settings can only ever go up. A server asking for weaker ones wants easier guessing.
        if (cached && (pre.kdf.m < cached.kdf.m || pre.kdf.t < cached.kdf.t)) throw new Error("The server is asking for weaker key settings than this device has seen, so this device won't unlock with them.");
        kdf = pre.kdf;
        salt = pre.salt;
        preWrapped = pre.wrapped_keyset ?? null;
        preAccount = pre.account_id ?? null;
      }
      if (!pre.exists) throw new Error("There's no vault on this account yet");
    } catch (e) {
      if (!(e instanceof OfflineError) && !(e instanceof ApiError && e.status >= 500)) throw e;
      offline = true;
    }
    if (!kdf || !salt) throw new Error("This device has no offline copy, and the server can't be reached");
    const raw = await deriveRootRaw(password, secretKey, fromB64u(salt), kdf);
    const unlockKey = await aesKey(raw.unlock);
    const authKey = raw.auth;

    // Open the keyset here before anything derived from the password goes anywhere. If a
    // server handed this device a Secret Key of its own choosing, what it would get back is
    // something it could guess the master password from, so nothing goes unless this works.
    if (!offline && preWrapped && preAccount) {
      try {
        await unwrapKeyset(unlockKey, preAccount, fromB64u(preWrapped));
      } catch {
        throw new WrongPasswordError();
      }
    }

    if (!offline) {
      try {
        const session = await this.api.createSession(b64u(authKey));
        this.api.session = session.token;
        await this.cacheAccount(session, { unlockKey });
        cached = await this.store.getAccount();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) throw new WrongPasswordError();
        if (e instanceof OfflineError) offline = true;
        else throw e;
      }
    }
    if (!cached) throw new Error("This device has no offline copy, and the server can't be reached");

    let keyset: Keyset;
    try {
      keyset = await unwrapKeyset(unlockKey, cached.accountId, fromB64u(cached.wrappedKeyset));
    } catch {
      throw new WrongPasswordError();
    }
    if (secretKeyOverride) await this.saveSecretKey(secretKey);
    this.state = {
      keyset,
      authKey,
      userId: cached.userId,
      accountId: cached.accountId,
      vaultKeys: new Map(),
      items: new Map(),
      search: new Map(),
    };
    await this.loadLocal();
    if (!offline) await this.sync();
    if (opts.keepSecret) {
      const secret = new Uint8Array(64);
      secret.set(raw.unlock, 0);
      secret.set(raw.auth, 32);
      return { offline, secret };
    }
    return { offline };
  }

  /** Pick up where an unlocked session left off, with no KDF and no network: for an
   *  extension's background being restarted, or another of its pages opening. */
  async restoreSession(secret: Uint8Array, sessionToken: string | null): Promise<void> {
    if (secret.length !== 64) throw new Error("bad unlock secret");
    const cached = await this.store.getAccount();
    if (!cached) throw new Error("This device has no offline copy");
    const unlockKey = await aesKey(secret.slice(0, 32));
    let keyset: Keyset;
    try {
      keyset = await unwrapKeyset(unlockKey, cached.accountId, fromB64u(cached.wrappedKeyset));
    } catch {
      throw new WrongPasswordError();
    }
    this.api.session = sessionToken;
    this.state = { keyset, authKey: secret.slice(32), userId: cached.userId, accountId: cached.accountId, vaultKeys: new Map(), items: new Map(), search: new Map() };
    await this.loadLocal();
    void this.refreshServerFacts();
  }

  /** The session ended while we still hold the keys: prove again without the password. */
  async reprove(): Promise<void> {
    const s = this.need();
    const session = await this.api.createSession(b64u(s.authKey));
    this.api.session = session.token;
    await this.cacheAccount(session);
  }

  /** For "reprompt" items: is this the master password? Local, no server. */
  async checkPassword(password: string): Promise<boolean> {
    const s = this.need();
    const secretKey = await this.loadSecretKey();
    const account = await this.store.getAccount();
    if (!secretKey || !account) return false;
    try {
      const { unlockKey } = await deriveRoot(password, secretKey, fromB64u(account.salt), account.kdf);
      await unwrapKeyset(unlockKey, s.accountId, fromB64u(account.wrappedKeyset));
      return true;
    } catch {
      return false;
    }
  }

  /** The derived unlock and auth keys, for a platform that can hold them behind
   *  the OS (Windows Hello, Android biometrics). Never the master password. */
  async exportUnlockSecret(password: string): Promise<Uint8Array> {
    const secretKey = await this.loadSecretKey();
    const account = await this.store.getAccount();
    if (!secretKey || !account) throw new Error("This device isn't set up");
    const { unlock, auth } = await deriveRootRaw(password, secretKey, fromB64u(account.salt), account.kdf);
    const { unlockKey } = await deriveRoot(password, secretKey, fromB64u(account.salt), account.kdf);
    await unwrapKeyset(unlockKey, account.accountId, fromB64u(account.wrappedKeyset));
    const out = new Uint8Array(64);
    out.set(unlock, 0);
    out.set(auth, 32);
    return out;
  }

  /** Unlock with what ``exportUnlockSecret`` gave, handed back by the OS. */
  async unlockWithSecret(secret: Uint8Array): Promise<{ offline: boolean }> {
    if (secret.length !== 64) throw new Error("bad unlock secret");
    let cached = await this.store.getAccount();
    const unlockKey = await aesKey(secret.slice(0, 32));
    const authKey = secret.slice(32);
    let offline = false;
    try {
      const session = await this.api.createSession(b64u(authKey));
      this.api.session = session.token;
      await this.cacheAccount(session, { unlockKey });
      cached = await this.store.getAccount();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new WrongPasswordError();
      if (e instanceof OfflineError || (e instanceof ApiError && e.status >= 500)) offline = true;
      else throw e;
    }
    if (!cached) throw new Error("This device has no offline copy");
    let keyset: Keyset;
    try {
      keyset = await unwrapKeyset(unlockKey, cached.accountId, fromB64u(cached.wrappedKeyset));
    } catch {
      throw new WrongPasswordError();
    }
    this.state = { keyset, authKey, userId: cached.userId, accountId: cached.accountId, vaultKeys: new Map(), items: new Map(), search: new Map() };
    await this.loadLocal();
    if (!offline) await this.sync();
    void this.refreshServerFacts();
    return { offline };
  }

  /** Forget every key. The offline copy stays, encrypted. */
  async lock(): Promise<void> {
    this.book = { people: {}, accepted: [], contacts: [], generations: {} };
    if (this.state) {
      this.state.keyset.x25519.fill(0);
      this.state.keyset.ed25519.fill(0);
      this.state.authKey.fill(0);
    }
    this.state = null;
    const session = this.api.session;
    this.api.session = null;
    if (session) {
      try {
        this.api.session = session;
        await this.api.endSession();
      } catch {
        /* an expired or unreachable session is fine */
      } finally {
        this.api.session = null;
      }
    }
    this.onChange?.();
  }

  // ---- Change the master password ------------------------------------------

  /** Stretching settings at least as strong as they are now and as the server asks for. */
  private strongerKdf(current: KdfParams, wanted?: KdfParams): KdfParams {
    // (never below the floor, whatever's asked)
    const a = wanted ?? current;
    const min = this.minKdf;
    return { alg: "argon2id", m: Math.max(a.m, current.m, min?.m ?? 0), t: Math.max(a.t, current.t, min?.t ?? 0), p: a.p };
  }

  /** The server's clock and minimum settings, when unlocking didn't already fetch them. */
  private async refreshServerFacts(): Promise<void> {
    try {
      const pre = await this.api.prelogin();
      this.serverTimeOffsetMs = new Date(pre.server_time).getTime() - Date.now();
      this.minKdf = pre.min_kdf;
    } catch {
      /* offline: nothing to compare with */
    }
  }

  /** True if this device's copy is below what the server now asks for. */
  kdfBelowMinimum(account: { kdf: KdfParams }): boolean {
    const min = this.minKdf;
    return !!min && (account.kdf.m < min.m || account.kdf.t < min.t);
  }

  async changePassword(current: string, next: string, kdf?: KdfParams): Promise<void> {
    await this.rekeyWith(current, next, kdf, null);
  }

  /** A new Secret Key, same master password. Other devices have to join again, and the
   *  old kit stops working. Returns the new key for a new kit. */
  async rotateSecretKey(password: string): Promise<Uint8Array> {
    const fresh = newSecretKey();
    await this.rekeyWith(password, password, undefined, fresh);
    return fresh;
  }

  /** Raise the stretching settings without changing anything else. */
  async upgradeKdf(password: string, kdf?: KdfParams): Promise<void> {
    await this.rekeyWith(password, password, kdf, null);
  }

  private async rekeyWith(current: string, next: string, kdf: KdfParams | undefined, newKey: Uint8Array | null): Promise<void> {
    const s = this.need();
    const secretKey = await this.loadSecretKey();
    const account = await this.store.getAccount();
    if (!secretKey || !account) throw new Error("This device isn't set up");
    const { authKey: currentAuth } = await deriveRoot(current, secretKey, fromB64u(account.salt), account.kdf);
    const salt = randomBytes(16);
    const params = this.strongerKdf(account.kdf, kdf);
    const { unlockKey, authKey } = await deriveRoot(next, newKey ?? secretKey, salt, params);
    const wrapped = await wrapKeyset(unlockKey, s.accountId, s.keyset);
    await this.api.rekey({
      auth_key: b64u(currentAuth),
      new_kdf: params,
      new_salt: b64u(salt),
      new_auth_key: b64u(authKey),
      new_wrapped_keyset: b64u(wrapped),
    });
    await this.store.putAccount({ ...account, kdf: params, salt: b64u(salt), wrappedKeyset: b64u(wrapped) });
    if (newKey) await this.saveSecretKey(newKey);
    s.authKey = authKey;
    // A shortcut in that wraps the old secret would just say the password's wrong.
    await this.store.deleteMeta("passkey_unlock");
  }

  // ---- Local data ----------------------------------------------------------

  private async vaultKey(v: CachedVault): Promise<CryptoKey> {
    const s = this.need();
    const known = s.vaultKeys.get(v.id);
    if (known) return known;
    const grantorEd = await this.grantorKey(v.grantedBy);
    const raw = await openVaultKey(
      { userId: s.userId, keyset: s.keyset },
      v.id,
      v.memberGeneration,
      { wrapped: fromB64u(v.wrappedKey), signature: fromB64u(v.signature), grantedBy: v.grantedBy ?? "" },
      grantorEd,
    );
    const key = await aesKey(raw);
    raw.fill(0);
    s.vaultKeys.set(v.id, key);
    return key;
  }

  private async rawVaultKey(v: CachedVault): Promise<Uint8Array> {
    const s = this.need();
    return openVaultKey(
      { userId: s.userId, keyset: s.keyset },
      v.id,
      v.memberGeneration,
      { wrapped: fromB64u(v.wrappedKey), signature: fromB64u(v.signature), grantedBy: v.grantedBy ?? "" },
      await this.grantorKey(v.grantedBy),
    );
  }

  /** The key a grant must be signed with: ours, or one from the local trust store.
   *  A stranger is trusted on first use, and remembered. A *changed* key is refused
   *  until the person looks at it (see acceptChangedKey). */
  private async grantorKey(grantedBy: string | null): Promise<Uint8Array> {
    const s = this.need();
    if (!grantedBy || grantedBy === s.userId) return publicKeysOf(s.keyset).ed25519;
    const trust = (await this.store.getMeta<Record<string, TrustEntry>>("trust")) ?? {};
    const known = trust[grantedBy];
    if (known) {
      try {
        const live = await this.api.userKeys(grantedBy);
        if (live.ed25519_pub !== known.ed25519 || live.x25519_pub !== known.x25519) {
          throw new KeyChangedError(grantedBy, live.username);
        }
      } catch (e) {
        if (e instanceof KeyChangedError) throw e;
        // Offline, or that person has left: what we saved still verifies old grants.
      }
      return fromB64u(known.ed25519);
    }
    // Nobody we've chosen to trust. The server names who signed a grant, so it could name
    // anyone, with keys of its own. A vault from a stranger stays shut until the person looks.
    const live = await this.api.userKeys(grantedBy).catch(() => null);
    throw new KeyChangedError(grantedBy, live?.username ?? "");
  }

  // ---- What this person decided, kept where a server can't touch it ---------

  private book: TrustBook = { people: {}, accepted: [], contacts: [], generations: {} };

  private isOwnVault(v: { kind: string; grantedBy: string | null }): boolean {
    const s = this.need();
    return v.kind === "personal" && (!v.grantedBy || v.grantedBy === s.userId);
  }

  /** A vault opens if it's your own, or you chose to accept it. What the server says about
   *  who accepted what doesn't come into it. */
  private mayOpen(v: { id: string; kind: string; grantedBy: string | null }): boolean {
    const s = this.need();
    return this.isOwnVault(v) || !v.grantedBy || v.grantedBy === s.userId || this.book.accepted.includes(v.id);
  }

  /** Your own vault's only. A member of a shared vault could plant one there, naming themselves
   *  a contact, so anywhere else doesn't count. Two devices can each make one while offline. */
  private trustItems(): Item[] {
    const s = this.need();
    const own = this.ownVaultIds;
    return [...s.items.values()].filter((i) => i.body.kind === "trust" && i.body.trustBook && own.has(i.vaultId));
  }

  private trustItem(): Item | undefined {
    return this.trustItems()[0];
  }

  private ownVaultIds = new Set<string>();

  /** Bring in what other devices decided. Union, and never a key change without a prompt. */
  private async mergeTrustBook(): Promise<void> {
    const local = (await this.store.getMeta<Record<string, TrustEntry>>("trust")) ?? {};
    this.ownVaultIds = new Set((await this.store.getVaults()).filter((v) => this.isOwnVault(v)).map((v) => v.id));
    const books = this.trustItems().map((i) => i.body.trustBook!);
    const remote: TrustBook = {
      people: Object.assign({}, ...books.map((b) => b.people)),
      accepted: books.flatMap((b) => b.accepted ?? []),
      contacts: books.flatMap((b) => b.contacts ?? []),
      generations: {},
      personalVaultId: books.find((b) => b.personalVaultId)?.personalVaultId,
    };
    for (const b of books) for (const [k, n] of Object.entries(b.generations ?? {})) remote.generations[k] = Math.max(remote.generations[k] ?? 0, n);
    const accepted = (await this.store.getMeta<string[]>("trust_accepted")) ?? [];
    const contacts = (await this.store.getMeta<string[]>("trust_contacts")) ?? [];
    const generations = (await this.store.getMeta<Record<string, number>>("trust_generations")) ?? {};
    const people = { ...(remote?.people ?? {}), ...local };
    for (const [id, e] of Object.entries(remote?.people ?? {})) {
      if (people[id] && e.verified) people[id] = { ...people[id], verified: people[id].ed25519 === e.ed25519 ? true : people[id].verified };
    }
    this.book = {
      people,
      accepted: [...new Set([...(remote?.accepted ?? []), ...accepted])],
      contacts: [...new Set([...(remote?.contacts ?? []), ...contacts])],
      generations: { ...(remote?.generations ?? {}), ...generations },
      personalVaultId: remote?.personalVaultId,
    };
    for (const [k, n] of Object.entries(remote?.generations ?? {})) this.book.generations[k] = Math.max(this.book.generations[k] ?? 0, n);
    await this.store.setMeta("trust", people);
  }

  /** Saved locally now, and to the personal vault so other devices know too. */
  private async saveTrustBook(): Promise<void> {
    await this.store.setMeta("trust", this.book.people);
    await this.store.setMeta("trust_accepted", this.book.accepted);
    await this.store.setMeta("trust_contacts", this.book.contacts);
    await this.store.setMeta("trust_generations", this.book.generations);
    if (!this.state) return;
    const item = this.trustItem();
    const body = { ...(item?.body ?? newBody("trust", "trust-book")), trustBook: this.book };
    if (item) await this.update(item.id, body);
    else {
      const personal = (await this.store.getVaults()).find((v) => this.isOwnVault(v));
      if (personal) await this.saveNew(personal.id, body);
    }
  }

  async trustEntries(): Promise<Record<string, TrustEntry>> {
    return (await this.store.getMeta<Record<string, TrustEntry>>("trust")) ?? {};
  }

  async identityWordsFor(userId: string): Promise<string[]> {
    const trust = await this.trustEntries();
    const e = trust[userId];
    if (e) return identityWords(userId, fromB64u(e.x25519), fromB64u(e.ed25519));
    // Looking isn't trusting: nothing's remembered until the person acts on it.
    const live = await this.api.userKeys(userId);
    return identityWords(userId, fromB64u(live.x25519_pub), fromB64u(live.ed25519_pub));
  }

  /** Remember this person's keys, because the person just chose to deal with them. Warns if
   *  someone with that name is already known under other keys, since a server picks the
   *  ids as well as the names. */
  private async pin(userId: string): Promise<TrustEntry> {
    const live = await this.api.userKeys(userId);
    const trust = await this.trustEntries();
    const known = trust[userId];
    if (known) {
      if (known.ed25519 !== live.ed25519_pub || known.x25519 !== live.x25519_pub) throw new KeyChangedError(userId, live.username);
      return known;
    }
    const twin = Object.entries(trust).find(([id, e]) => id !== userId && e.username && e.username === live.username);
    if (twin) throw new KeyChangedError(userId, live.username);
    const entry: TrustEntry = { x25519: live.x25519_pub, ed25519: live.ed25519_pub, firstSeen: new Date().toISOString(), username: live.username };
    this.book.people[userId] = entry;
    await this.saveTrustBook();
    return entry;
  }

  /** Accept a vault someone shared. Only this opens it, whatever the server says. */
  async acceptVault(vaultId: string): Promise<void> {
    if (!(await this.store.getVaults()).some((x) => x.id === vaultId)) await this.sync();
    const v = await this.cachedVault(vaultId);
    if (v.grantedBy && v.grantedBy !== this.need().userId) await this.pin(v.grantedBy);
    if (!this.book.accepted.includes(vaultId)) this.book.accepted.push(vaultId);
    await this.saveTrustBook();
    await this.api.acceptVault(vaultId);
    await this.sync();
  }

  /** Who an invitation is from, without trusting them yet. */
  async inviterInfo(userId: string): Promise<{ username: string; words: string[]; twin: boolean; changed: boolean }> {
    const live = await this.api.userKeys(userId);
    const trust = await this.trustEntries();
    const known = trust[userId];
    const changed = !!known && (known.ed25519 !== live.ed25519_pub || known.x25519 !== live.x25519_pub);
    const twin = !known && Object.entries(trust).some(([id, e]) => id !== userId && e.username === live.username);
    return { username: live.username, words: await identityWords(userId, fromB64u(live.x25519_pub), fromB64u(live.ed25519_pub)), twin, changed };
  }

  async myIdentityWords(): Promise<string[]> {
    const s = this.need();
    const pub = publicKeysOf(s.keyset);
    return identityWords(s.userId, pub.x25519, pub.ed25519);
  }

  async markVerified(userId: string): Promise<void> {
    if (!this.book.people[userId]) await this.pin(userId);
    this.book.people[userId].verified = true;
    await this.saveTrustBook();
  }

  /** The person's looked into it: use these keys from now on. */
  async acceptChangedKey(userId: string): Promise<void> {
    const live = await this.api.userKeys(userId);
    this.book.people[userId] = { x25519: live.x25519_pub, ed25519: live.ed25519_pub, firstSeen: new Date().toISOString(), username: live.username };
    await this.saveTrustBook();
    this.need().vaultKeys.clear();
    await this.loadLocal();
  }

  private async decode(c: CachedItem, v: CachedVault): Promise<Item | null> {
    if (!c.blob || c.purged) return null;
    const key = await this.vaultKey(v);
    const body = await decryptItem<ItemBody>(key, v.id, c.id, fromB64u(c.blob));
    return { id: c.id, vaultId: c.vaultId, revision: c.revision, deleted: c.deleted, updatedAt: c.updatedAt, body };
  }

  /** Decrypt the whole offline copy into memory for search and listing. */
  private async loadLocal(): Promise<void> {
    const s = this.need();
    // Built aside and swapped in at the end: another part of the app may be reading the list
    // meanwhile, and it shouldn't see it empty.
    const fresh: Item[] = [];
    this.keyChanges.clear();
    this.roles.clear();
    const all = await this.store.getVaults();
    const ownFirst = [...all.filter((v) => this.isOwnVault(v)), ...all.filter((v) => !this.isOwnVault(v))];
    // Their own vault has their decisions in it, so it opens before anything else is judged.
    await this.mergeTrustBook();
    let merged = false;
    for (const v of ownFirst) {
      if (!merged && !this.isOwnVault(v)) {
        merged = true;
        await this.mergeTrustBook();
      }
      this.roles.set(v.id, v.role);
      if (!this.mayOpen(v)) continue;
      try {
        await this.vaultKey(v);
      } catch (e) {
        // One person's changed key can't stop everything else opening. That vault stays
        // shut, and the Shared vaults screen asks what to do about it.
        if (e instanceof KeyChangedError) this.keyChanges.set(v.id, e);
        continue;
      }
      if (v.hidden) continue;
      for (const c of await this.store.getItems(v.id)) {
        try {
          const item = await this.decode(c, v);
          if (item) {
            fresh.push(item);
            // The trust book's needed before the shared vaults are judged.
            if (item.body.kind === "trust") this.index(item);
          }
        } catch {
          // A blob that fails to open is reported by health checks, not by a crash.
          this.undecryptable.add(c.id);
        }
      }
    }
    s.items.clear();
    s.search.clear();
    for (const item of fresh) this.index(item);
  }

  /** Another client sharing this offline copy changed it (extension pages do). */
  async reload(): Promise<void> {
    if (this.state) await this.loadLocal();
  }

  undecryptable = new Set<string>();

  private index(item: Item): void {
    const s = this.need();
    s.items.set(item.id, item);
    s.search.set(item.id, searchText(item.body));
  }

  private unindex(id: string): void {
    const s = this.need();
    s.items.delete(id);
    s.search.delete(id);
  }

  // ---- Sync ----------------------------------------------------------------

  private cacheVault(v: VaultOut, prev: CachedVault | undefined): CachedVault {
    return {
      id: v.id,
      kind: v.kind,
      revision: prev?.revision ?? 0,
      highWater: prev?.highWater ?? 0,
      generation: v.generation,
      name: v.name,
      role: v.role,
      wrappedKey: v.wrapped_key,
      signature: v.signature,
      grantedBy: v.granted_by,
      memberGeneration: v.member_generation,
      accepted: v.accepted,
      memberCount: v.member_count,
      hidden: prev?.hidden,
      rotateNeeded: v.rotate_needed,
    };
  }

  /** Delta sync: push local edits first (a conflict is merged, nothing is lost),
   *  then pull what changed. Safe to call any time; offline it just says so. */
  async sync(): Promise<SyncResult> {
    const s = this.need();
    const out: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, offline: false, rollback: [] };
    let generationsMoved = false;
    try {
      const remote = await this.api.vaults();
      const known = new Map((await this.store.getVaults()).map((v) => [v.id, v]));
      const seen = new Set<string>();
      // Their own vault first: it holds what they've decided about the others. A "personal"
      // vault not signed by them is somebody else's, whatever the server calls it.
      const ordered = [...remote].map((rv) => (rv.kind === "personal" && rv.granted_by && rv.granted_by !== s.userId ? { ...rv, kind: "shared" as const } : rv));
      ordered.sort((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"));
      let trustFresh = false;
      for (const rv of ordered) {
        if (!trustFresh && rv.kind !== "personal") {
          trustFresh = true;
          await this.mergeTrustBook();
        }
        seen.add(rv.id);
        const prev = known.get(rv.id);
        const next = this.cacheVault(rv, prev);
        // Your own vault's key is signed by you. Being told otherwise isn't a reason to believe it.
        if (prev && this.isOwnVault(prev) && rv.granted_by && rv.granted_by !== s.userId) {
          out.rollback.push(rv.id);
          this.rollbackWarnings.push(rv.id);
          continue;
        }
        const highest = Math.max(prev?.memberGeneration ?? 0, this.book.generations[rv.id] ?? 0);
        // An older key brought back, or an older state: an old grant still has a good signature,
        // so this is the only thing that can catch it. Stay on what we have.
        if ((prev && rv.revision < prev.highWater) || rv.member_generation < highest) {
          out.rollback.push(rv.id);
          this.rollbackWarnings.push(rv.id);
          if (prev && rv.member_generation >= highest) await this.store.putVault({ ...next, revision: prev.revision, highWater: prev.highWater });
          continue;
        }
        if (prev && prev.memberGeneration !== rv.member_generation && this.mayOpen({ id: next.id, kind: next.kind, grantedBy: next.grantedBy })) {
          // A new key has to prove itself before it replaces the one that works, or a forged
          // generation 999 would lock this vault for good.
          try {
            (await this.rawVaultKey(next)).fill(0);
          } catch (e) {
            if (e instanceof KeyChangedError) this.keyChanges.set(next.id, e);
            else {
              out.rollback.push(rv.id);
              this.rollbackWarnings.push(rv.id);
            }
            continue;
          }
        }
        if (prev && prev.memberGeneration !== rv.member_generation) {
          await this.rekeyDirty(prev, next);
          s.vaultKeys.delete(rv.id);
          // Everything was re-encrypted: start this vault over.
          next.revision = 0;
        }
        // Worth remembering once a key has actually changed: an old one can't be replayed before that.
        if (rv.member_generation > 1 && rv.member_generation > (this.book.generations[rv.id] ?? 0) && this.mayOpen({ id: rv.id, kind: rv.kind, grantedBy: rv.granted_by })) {
          this.book.generations[rv.id] = rv.member_generation;
          generationsMoved = true;
        }
        await this.store.putVault(next);
        this.roles.set(next.id, next.role);
        if (next.hidden) continue;
        // Only what they've chosen to open. An invitation just sits here until then.
        if (this.mayOpen({ id: next.id, kind: next.kind, grantedBy: next.grantedBy })) {
          await this.pushVault(next, out);
          await this.pullVault(next, out);
        }
      }
      // Only your own vault: what other devices decided still has to be read before saving over it.
      if (!trustFresh) await this.mergeTrustBook();
      if (generationsMoved) await this.saveTrustBook();
      for (const v of known.values()) {
        if (!seen.has(v.id) && this.isOwnVault(v)) {
          out.rollback.push(v.id);
          this.rollbackWarnings.push(v.id);
          continue;
        }
        if (!seen.has(v.id)) {
          // Removed from this vault: drop the local copy and keys.
          for (const c of await this.store.getItems(v.id)) this.unindex(c.id);
          await this.store.deleteVault(v.id);
          s.vaultKeys.delete(v.id);
        }
      }
      // Keep what an emergency contact holds up to date, and finish setting one up.
      await this.refreshEmergency().catch(() => undefined);
      this.lastSyncAt = Date.now();
      await this.store.setMeta("last_sync", this.lastSyncAt);
      this.lastSyncAt = Date.now();
    } catch (e) {
      if (e instanceof OfflineError || (e instanceof ApiError && e.status >= 500)) out.offline = true;
      else throw e;
    }
    this.onChange?.();
    return out;
  }

  /** A new vault key arrived while this device had unsynced edits: move them under it, so
   *  they don't go up under the key of someone who's been removed. */
  private async rekeyDirty(prev: CachedVault, next: CachedVault): Promise<void> {
    const dirty = (await this.store.getItems(prev.id)).filter((i) => i.dirty && i.blob);
    if (!dirty.length) return;
    let oldKey: CryptoKey;
    try {
      oldKey = await this.vaultKey(prev);
    } catch {
      return;
    }
    this.need().vaultKeys.delete(prev.id);
    const newKey = await this.vaultKey(next);
    const writes: CachedItem[] = [];
    for (const c of dirty) {
      try {
        const body = await decryptItem<ItemBody>(oldKey, prev.id, c.id, fromB64u(c.blob!));
        writes.push({ ...c, blob: b64u(await encryptItem(newKey, prev.id, c.id, body)), baseBlob: null });
      } catch {
        this.undecryptable.add(c.id);
      }
    }
    await this.store.putItems(writes);
  }

  private async pullVault(v: CachedVault, out: SyncResult): Promise<void> {
    let since = v.revision;
    let top = v.revision;
    for (;;) {
      const page = await this.api.changes(v.id, since);
      top = Math.max(top, page.revision);
      const writes: CachedItem[] = [];
      for (const r of page.items) {
        since = Math.max(since, r.revision);
        const local = await this.store.getItem(r.id);
        // A local edit still waiting wins for now: the next push merges them.
        if (local?.dirty) continue;
        const c: CachedItem = {
          id: r.id,
          vaultId: v.id,
          revision: r.revision,
          blob: r.blob,
          deleted: r.deleted,
          purged: r.purged,
          updatedAt: r.updated_at,
        };
        writes.push(c);
        if (r.purged) {
          this.unindex(r.id);
        } else {
          try {
            const item = await this.decode(c, v);
            const known = this.need().items.get(r.id);
            // The revision's the server's word. The number inside the encryption isn't.
            if (item && known && (item.body.seq ?? 0) < (known.body.seq ?? 0)) {
              writes.pop();
              out.rollback.push(v.id);
              this.rollbackWarnings.push(v.id);
              continue;
            }
            if (item) this.index(item);
            this.undecryptable.delete(r.id);
          } catch {
            this.undecryptable.add(r.id);
          }
        }
        out.pulled++;
      }
      await this.store.putItems(writes);
      if (!page.more) break;
    }
    await this.store.putVault({ ...v, revision: top, highWater: Math.max(v.highWater, top) });
  }

  private async pushVault(v: CachedVault, out: SyncResult): Promise<void> {
    const dirty = (await this.store.getItems(v.id)).filter((i) => i.dirty);
    if (!dirty.length || !["manage", "edit"].includes(v.role)) return;
    const key = await this.vaultKey(v);
    for (let i = 0; i < dirty.length; i += 200) {
      const chunk = dirty.slice(i, i + 200);
      let res;
      try {
        res = await this.api.writeItems(
          v.id,
          chunk.map((c) => ({
            id: c.id,
            base_revision: c.revision,
            blob: c.purgeRequested ? undefined : c.blob,
            deleted: c.deleted,
            purge: c.purgeRequested ?? false,
          })),
          v.generation,
        );
      } catch (e) {
        // A new key we haven't seen yet. The next sync re-encrypts these and tries again.
        if (e instanceof ApiError && e.status === 409) return;
        throw e;
      }
      const byId = new Map(chunk.map((c) => [c.id, c]));
      const writes: CachedItem[] = [];
      for (const id of res.applied) {
        const c = byId.get(id)!;
        writes.push({ ...c, revision: res.revision, dirty: false, baseBlob: null, purged: c.purgeRequested ?? false, blob: c.purgeRequested ? null : c.blob, purgeRequested: false });
        const known = this.need().items.get(id);
        if (known) known.revision = res.revision;
        out.pushed++;
      }
      await this.store.putItems(writes);
      for (const conflict of res.conflicts) {
        const c = byId.get(conflict.id);
        if (!c || conflict.reason !== "changed") continue;
        out.conflicts++;
        try {
          await this.resolveConflict(v, key, c, conflict.blob ?? null, conflict.revision ?? 0, conflict.deleted ?? false);
        } catch {
          // Junk from someone else in the vault can't stop everyone's sync. It's listed.
          this.undecryptable.add(c.id);
        }
      }
      // The merges left items dirty on top of the server's revision; send them too.
      const merged = res.conflicts.filter((x) => x.reason === "changed").map((x) => x.id);
      if (merged.length) {
        const again = (await Promise.all(merged.map((id) => this.store.getItem(id)))).filter((x): x is CachedItem => !!x && !!x.dirty);
        if (again.length) {
          const second = await this.api.writeItems(
            v.id,
            again.map((c) => ({ id: c.id, base_revision: c.revision, blob: c.blob, deleted: c.deleted })),
            v.generation,
          );
          const writes2: CachedItem[] = [];
          for (const id of second.applied) {
            const c = again.find((x) => x.id === id)!;
            writes2.push({ ...c, revision: second.revision, dirty: false, baseBlob: null });
            out.pushed++;
          }
          await this.store.putItems(writes2);
        }
      }
    }
  }

  private async resolveConflict(v: CachedVault, key: CryptoKey, local: CachedItem, serverBlob: string | null, serverRevision: number, serverDeleted: boolean): Promise<void> {
    if (!serverBlob) {
      // Purged elsewhere, edited here: the edit comes back as a new item rather
      // than vanish without a trace.
      const body = local.blob ? await decryptItem<ItemBody>(key, v.id, local.id, fromB64u(local.blob)) : null;
      await this.store.deleteItem(local.id);
      this.unindex(local.id);
      if (body && !local.purgeRequested) await this.saveNew(v.id, body);
      return;
    }
    const server = await decryptItem<ItemBody>(key, v.id, local.id, fromB64u(serverBlob));
    if (local.purgeRequested) {
      // Deleted here, changed there: keep the change. A purge can be repeated.
      await this.store.putItems([{ ...local, blob: serverBlob, revision: serverRevision, deleted: serverDeleted, dirty: false, purgeRequested: false, baseBlob: null }]);
      this.index({ id: local.id, vaultId: v.id, revision: serverRevision, deleted: serverDeleted, updatedAt: server.updatedAt, body: server });
      return;
    }
    const localBody = local.blob ? await decryptItem<ItemBody>(key, v.id, local.id, fromB64u(local.blob)) : server;
    const base = local.baseBlob ? await decryptItem<ItemBody>(key, v.id, local.id, fromB64u(local.baseBlob)) : null;
    const { body } = mergeBodies(base, localBody, server);
    body.seq = Math.max(localBody.seq ?? 0, server.seq ?? 0) + 1;
    const blob = b64u(await encryptItem(key, v.id, local.id, body));
    const merged: CachedItem = {
      ...local,
      blob,
      baseBlob: serverBlob,
      revision: serverRevision,
      deleted: local.deleted && serverDeleted,
      dirty: true,
    };
    await this.store.putItems([merged]);
    this.index({ id: local.id, vaultId: v.id, revision: serverRevision, deleted: merged.deleted, updatedAt: body.updatedAt, body });
  }

  // ---- Reading -------------------------------------------------------------

  async vaults(): Promise<VaultInfo[]> {
    const out: VaultInfo[] = [];
    for (const v of await this.store.getVaults()) {
      let displayName = "(can't open)";
      try {
        displayName = await openField<string>(await this.vaultKey(v), v.id, "name", v.name);
      } catch {
        /* a grant we can't verify yet */
      }
      out.push({ ...v, displayName });
    }
    return out;
  }

  allItems(opts: { includeSystem?: boolean; includeDeleted?: boolean } = {}): Item[] {
    const s = this.need();
    const out: Item[] = [];
    for (const item of s.items.values()) {
      if (!opts.includeSystem && isSystem(item.body)) continue;
      if (!opts.includeDeleted && item.deleted) continue;
      out.push(item);
    }
    return out.sort((a, b) => a.body.title.localeCompare(b.body.title));
  }

  trash(): Item[] {
    return this.allItems({ includeDeleted: true }).filter((i) => i.deleted);
  }

  get(id: string): Item | undefined {
    return this.need().items.get(id);
  }

  /** Search over decrypted text in memory. Every word must match. */
  search(query: string): Item[] {
    const s = this.need();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.allItems();
    const out: Item[] = [];
    for (const [id, text] of s.search) {
      const item = s.items.get(id);
      if (!item || item.deleted || isSystem(item.body)) continue;
      if (words.every((w) => text.includes(w))) out.push(item);
    }
    return out.sort((a, b) => a.body.title.localeCompare(b.body.title));
  }

  // ---- Writing -------------------------------------------------------------

  private async cachedVault(id: string): Promise<CachedVault> {
    const v = (await this.store.getVaults()).find((x) => x.id === id);
    if (!v) throw new Error("Unknown vault");
    return v;
  }

  async personalVaultId(): Promise<string> {
    const vaults = await this.store.getVaults();
    const pinned = (await this.store.getMeta<string>("personal_vault")) ?? this.book.personalVaultId;
    const v = (pinned && vaults.find((x) => x.id === pinned && this.isOwnVault(x))) || vaults.find((x) => this.isOwnVault(x));
    if (!v) throw new Error("No personal vault");
    if (!pinned) await this.store.setMeta("personal_vault", v.id);
    return v.id;
  }

  /** Save locally first, so it works offline, then sync. */
  async saveNew(vaultId: string, body: ItemBody, id = randomUuid()): Promise<Item> {
    const v = await this.cachedVault(vaultId);
    const key = await this.vaultKey(v);
    const clean = touch(null, body);
    const blob = b64u(await encryptItem(key, vaultId, id, clean));
    const at = new Date().toISOString();
    await this.store.putItems([{ id, vaultId, revision: 0, blob, deleted: false, purged: false, updatedAt: at, dirty: true, baseBlob: null }]);
    const item: Item = { id, vaultId, revision: 0, deleted: false, updatedAt: at, body: clean };
    this.index(item);
    this.onChange?.();
    return item;
  }

  async update(id: string, body: ItemBody): Promise<Item> {
    const prev = this.get(id);
    if (!prev) throw new Error("Unknown item");
    const v = await this.cachedVault(prev.vaultId);
    const key = await this.vaultKey(v);
    const clean = touch(prev.body, body);
    const blob = b64u(await encryptItem(key, v.id, id, clean));
    const cached = await this.store.getItem(id);
    const at = new Date().toISOString();
    await this.store.putItems([
      {
        id,
        vaultId: v.id,
        revision: cached?.revision ?? prev.revision,
        blob,
        deleted: cached?.deleted ?? false,
        purged: false,
        updatedAt: at,
        dirty: true,
        // The first edit since the last sync is what a merge compares against.
        baseBlob: cached?.dirty ? cached.baseBlob : cached?.blob ?? null,
      },
    ]);
    const item: Item = { ...prev, deleted: cached?.deleted ?? false, updatedAt: at, body: clean };
    this.index(item);
    this.onChange?.();
    return item;
  }

  private async setDeleted(id: string, deleted: boolean): Promise<void> {
    const cached = await this.store.getItem(id);
    if (!cached) throw new Error("Unknown item");
    await this.store.putItems([{ ...cached, deleted, dirty: true, baseBlob: cached.dirty ? cached.baseBlob : cached.blob }]);
    const item = this.get(id);
    if (item) item.deleted = deleted;
    this.onChange?.();
  }

  trashItem = (id: string) => this.setDeleted(id, true);
  restoreItem = (id: string) => this.setDeleted(id, false);

  async purgeItem(id: string): Promise<void> {
    const cached = await this.store.getItem(id);
    if (!cached) throw new Error("Unknown item");
    if (cached.revision === 0) {
      await this.store.deleteItem(id);
    } else {
      await this.store.putItems([{ ...cached, dirty: true, purgeRequested: true }]);
    }
    this.unindex(id);
    this.onChange?.();
  }

  /** Earlier versions, decrypted here. Failures are skipped: a version from before
   *  a key rotation that wasn't re-encrypted can't be opened by anyone. */
  async versions(id: string): Promise<{ revision: number; createdAt: string; body: ItemBody }[]> {
    const item = this.get(id);
    if (!item) return [];
    const v = await this.cachedVault(item.vaultId);
    const key = await this.vaultKey(v);
    const out: { revision: number; createdAt: string; body: ItemBody }[] = [];
    for (const row of await this.api.versions(v.id, id)) {
      try {
        out.push({ revision: row.revision, createdAt: row.created_at, body: await decryptItem<ItemBody>(key, v.id, id, fromB64u(row.blob)) });
      } catch {
        /* skipped */
      }
    }
    return out;
  }

  // ---- Shared vaults -------------------------------------------------------

  async createSharedVault(name: string): Promise<string> {
    const s = this.need();
    const id = randomUuid();
    const raw = randomBytes(32);
    const key = await aesKey(raw);
    const pub = publicKeysOf(s.keyset);
    const grant = await grantVaultKey({ userId: s.userId, keyset: s.keyset }, id, { userId: s.userId, x25519: pub.x25519 }, 1, raw);
    await this.api.createVault({ id, name: await sealField(key, id, "name", name), grant: { wrapped_key: b64u(grant.wrapped), signature: b64u(grant.signature) } });
    raw.fill(0);
    await this.sync();
    return id;
  }

  async addMember(vaultId: string, userId: string, role: string): Promise<void> {
    const s = this.need();
    const v = await this.cachedVault(vaultId);
    // Picking someone is the person's own act, and this is when their keys get remembered.
    const keys = await this.pin(userId);
    const raw = await this.rawVaultKey(v);
    const grant = await grantVaultKey({ userId: s.userId, keyset: s.keyset }, vaultId, { userId, x25519: fromB64u(keys.x25519) }, v.generation, raw);
    raw.fill(0);
    await this.api.addMember(vaultId, { user_id: userId, role, grant: { wrapped_key: b64u(grant.wrapped), signature: b64u(grant.signature) } });
  }

  /** Who'd get the new key if these people were removed. A server can add names to a list, so
   *  anyone not already trusted needs the person to look before a key is sealed to them. */
  async rotationPlan(vaultId: string, removing: string[]): Promise<{ userId: string; username: string; known: boolean; changed: boolean }[]> {
    const s = this.need();
    const trust = await this.trustEntries();
    return (await this.api.members(vaultId))
      .filter((m) => !removing.includes(m.user_id) && m.user_id !== s.userId)
      .map((m) => {
        const k = trust[m.user_id];
        return { userId: m.user_id, username: m.username, known: !!k, changed: !!k && (k.ed25519 !== m.ed25519_pub || k.x25519 !== m.x25519_pub) };
      });
  }

  /** Remove people: cut off now, then a new vault key, new item keys, every item and retained
   *  version re-encrypted here and swapped in one batch on the server. Returns the logins they
   *  could read, whose passwords should now change. If the re-encrypting fails they're still
   *  out, and the vault says it needs a new key. With nobody to remove, it just changes the key. */
  async removeMembers(vaultId: string, userIds: string[], confirmed: string[] = []): Promise<Item[]> {
    const s = this.need();
    const plan = await this.rotationPlan(vaultId, userIds);
    const changed = plan.find((p) => p.changed);
    if (changed) throw new KeyChangedError(changed.userId, changed.username);
    const unknown = plan.filter((p) => !p.known && !confirmed.includes(p.userId));
    if (unknown.length) throw new Error(`Check who gets the new key first: ${unknown.map((u) => u.username).join(", ")}`);
    for (const id of userIds) {
      try {
        await this.api.removeMember(vaultId, id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.rotateOnce(vaultId, confirmed);
      } catch (e) {
        // Someone wrote something meanwhile. Pick it up and go again.
        if (e instanceof ApiError && (e.status === 409 || e.status === 400) && attempt < 3) continue;
        throw e;
      }
    }
    void s;
  }

  private async rotateOnce(vaultId: string, confirmed: string[]): Promise<Item[]> {
    const s = this.need();
    await this.sync();
    const v = await this.cachedVault(vaultId);
    const oldKey = await this.vaultKey(v);
    const raw = randomBytes(32);
    const newKey = await aesKey(raw);
    const members = await this.api.members(vaultId);
    const generation = v.generation + 1;
    const trust = await this.trustEntries();

    const grants = [];
    for (const m of members) {
      let x25519: Uint8Array;
      if (m.user_id === s.userId) {
        // Our own key's the one we hold, not whatever a list says it is.
        x25519 = publicKeysOf(s.keyset).x25519;
      } else {
        const known = trust[m.user_id];
        if (known && (known.x25519 !== m.x25519_pub || known.ed25519 !== m.ed25519_pub)) throw new KeyChangedError(m.user_id, m.username);
        if (!known && !confirmed.includes(m.user_id)) throw new Error(`Check who gets the new key first: ${m.username}`);
        if (!m.x25519_pub || !m.ed25519_pub) throw new Error(`${m.username} has no keys on this server`);
        if (!known) {
          this.book.people[m.user_id] = { x25519: m.x25519_pub, ed25519: m.ed25519_pub, firstSeen: new Date().toISOString(), username: m.username };
        }
        x25519 = fromB64u(m.x25519_pub);
      }
      const g = await grantVaultKey({ userId: s.userId, keyset: s.keyset }, vaultId, { userId: m.user_id, x25519 }, generation, raw);
      grants.push({ user_id: m.user_id, grant: { wrapped_key: b64u(g.wrapped), signature: b64u(g.signature) } });
    }

    const toChange: Item[] = [];
    const items = [];
    const junk = [];
    for (const c of await this.store.getItems(vaultId)) {
      if (!c.blob || c.purged) continue;
      let body: ItemBody;
      try {
        body = await decryptItem<ItemBody>(oldKey, vaultId, c.id, fromB64u(c.blob));
      } catch {
        // Nobody can read it, so it can't be moved to the new key. It goes, or a member could
        // stop themselves being rotated out by writing rubbish.
        junk.push({ id: c.id, base_revision: c.revision, purge: true, deleted: true });
        continue;
      }
      if (body.password && !c.deleted) toChange.push({ id: c.id, vaultId, revision: c.revision, deleted: c.deleted, updatedAt: c.updatedAt, body });
      const versions = [];
      for (const row of await this.api.versions(vaultId, c.id)) {
        try {
          const old = await decryptItem<ItemBody>(oldKey, vaultId, c.id, fromB64u(row.blob));
          versions.push({ revision: row.revision, blob: b64u(await encryptItem(newKey, vaultId, c.id, old)) });
        } catch {
          /* unreadable versions are dropped by the server */
        }
      }
      items.push({ id: c.id, blob: b64u(await encryptItem(newKey, vaultId, c.id, body)), versions });
    }
    if (junk.length) {
      await this.api.writeItems(vaultId, junk, v.generation);
      for (const j of junk) await this.store.deleteItem(j.id);
      await this.sync();
    }
    const fresh = await this.cachedVault(vaultId);
    const name = await openField<string>(oldKey, vaultId, "name", v.name);
    await this.api.rotate(vaultId, {
      from_generation: v.generation,
      from_revision: fresh.revision,
      name: await sealField(newKey, vaultId, "name", name),
      remove_user_ids: [],
      members: grants,
      items,
    });
    raw.fill(0);
    s.vaultKeys.delete(vaultId);
    this.book.generations[vaultId] = generation;
    await this.saveTrustBook();
    await this.sync();
    return toChange;
  }

  /** Fill-only members can't see secrets on screen. It's a convenience: their device still
   *  gets the password in order to fill it, and the Shared screen says so. */
  canReveal(vaultId: string): boolean {
    return this.roles.get(vaultId) !== "fill";
  }

  // ---- Travel mode ----------------------------------------------------------

  /** Take these vaults off this device: their items go from the local copy and memory,
   *  and they aren't synced here until travel mode's turned off. It keeps a border guard
   *  from finding them on the device, as long as you don't unlock them while they watch.
   *  They're still on your server, and your master password brings them back. */
  async setTravelHidden(vaultIds: string[]): Promise<void> {
    await this.sync();
    for (const v of await this.store.getVaults()) {
      const hide = vaultIds.includes(v.id);
      if (hide && (await this.store.getItems(v.id)).some((c) => c.dirty)) throw new Error("Something in that vault hasn't synced yet. Get back online first.");
      await this.store.putVault({ ...v, hidden: hide || undefined });
      if (hide) {
        for (const c of await this.store.getItems(v.id)) {
          this.unindex(c.id);
          await this.store.deleteItem(c.id);
        }
        // Start over when it comes back.
        await this.store.putVault({ ...v, hidden: true, revision: 0, highWater: 0 });
      }
    }
    await this.loadLocal();
  }

  /** Back from the trip. Needs the master password, as a second look before it all returns. */
  async endTravel(password: string): Promise<void> {
    if (!(await this.checkPassword(password))) throw new WrongPasswordError();
    for (const v of await this.store.getVaults()) await this.store.putVault({ ...v, hidden: undefined });
    await this.sync();
    await this.loadLocal();
  }

  // ---- Emergency access -----------------------------------------------------

  emergencyList(): Promise<EmergencyOut[]> {
    return this.api.request<EmergencyOut[]>("GET", "/emergency");
  }

  /** The only way someone becomes a contact: this person, on one of their own devices. */
  async emergencyInvite(granteeId: string, waitDays: number): Promise<void> {
    await this.pin(granteeId);
    if (!this.book.contacts.includes(granteeId)) this.book.contacts.push(granteeId);
    await this.saveTrustBook();
    await this.api.request("POST", "/emergency", { grantee_id: granteeId, wait_days: waitDays });
  }

  emergencyAct(id: string, action: "accept" | "request" | "refuse"): Promise<EmergencyOut> {
    return this.api.request<EmergencyOut>("POST", `/emergency/${id}/${action}`);
  }

  async emergencyOpen(id: string): Promise<void> {
    const out = await this.api.request<EmergencyOut>("POST", `/emergency/${id}/open`);
    // Asking for this and waiting was the person's choice, so these are theirs to open.
    await this.pin(out.grantor_id);
    for (const vaultId of out.opened_vaults) if (!this.book.accepted.includes(vaultId)) this.book.accepted.push(vaultId);
    await this.saveTrustBook();
    await this.sync();
  }

  /** End it. If it was opened, what they could read gets a new key first. */
  async emergencyEnd(row: EmergencyOut): Promise<void> {
    const s = this.need();
    if (row.grantor_id === s.userId && (row.state === "opened" || row.state === "ended")) {
      for (const vaultId of row.opened_vaults) await this.removeMembers(vaultId, [row.grantee_id]);
    }
    await this.api.request("DELETE", `/emergency/${row.id}`);
    this.book.contacts = this.book.contacts.filter((c) => c !== row.grantee_id);
    await this.saveTrustBook();
    await this.sync();
  }

  /** Seal our vault keys to each accepted contact, signed, and again whenever a vault
   *  has been added or re-keyed since. Keys stay on the server until the wait runs out,
   *  and only the contact can unseal them. A contact whose keys changed is left as it
   *  is, because sealing to an unchecked key is how a hostile server would get in. */
  async refreshEmergency(): Promise<void> {
    const s = this.need();
    const rows = await this.emergencyList();
    // Your own vaults only. Other people's logins in a shared vault aren't yours to hand on.
    const mine = (await this.store.getVaults()).filter((v) => this.isOwnVault(v) || (!v.grantedBy || v.grantedBy === s.userId) && v.memberCount <= 1);
    for (const row of rows) {
      if (row.grantor_id !== s.userId || row.state === "invited" || row.state === "opened" || row.state === "ended") continue;
      // A row in this list is only the server's word. Keys go to someone this person named,
      // on the keys they saw then, and to nobody else, ever.
      if (!this.book.contacts.includes(row.grantee_id)) continue;
      const current = row.wrapped;
      const stale = mine.length !== Object.keys(current).length || mine.some((v) => current[v.id] !== v.generation);
      if (!stale) continue;
      const keys = await this.api.userKeys(row.grantee_id);
      const known = (await this.trustEntries())[row.grantee_id];
      if (!known || known.ed25519 !== keys.ed25519_pub || known.x25519 !== keys.x25519_pub) continue;
      const grants = [];
      for (const v of mine) {
        const raw = await this.rawVaultKey(v);
        const g = await grantVaultKey({ userId: s.userId, keyset: s.keyset }, v.id, { userId: row.grantee_id, x25519: fromB64u(keys.x25519_pub) }, v.generation, raw);
        raw.fill(0);
        grants.push({ vault_id: v.id, generation: v.generation, wrapped_key: b64u(g.wrapped), signature: b64u(g.signature) });
      }
      await this.api.request("PUT", `/emergency/${row.id}/wrap`, { grants });
    }
  }

  // ---- New devices (CRYPTO_SPEC.md section 8) -------------------------------

  /** On the unlocked device: answer a request. Returns the words to compare. */
  async beginApproval(requestId: string, devicePub: string): Promise<{ words: string[]; approverSk: Uint8Array; approverPub: string }> {
    const approverSk = randomBytes(32);
    const approverPub = x25519Public(approverSk);
    await this.api.deviceRequestApprover(requestId, b64u(approverPub));
    return { words: await deviceSafetyWords(fromB64u(devicePub), approverPub), approverSk, approverPub: b64u(approverPub) };
  }

  async finishApproval(requestId: string, devicePub: string): Promise<void> {
    const secretKey = await this.loadSecretKey();
    const s = this.need();
    if (!secretKey) throw new Error("This device doesn't hold the Secret Key");
    const payload = JSON.stringify({ secret_key: b64u(secretKey), account_id: s.accountId });
    const sealed = await sealTo(fromB64u(devicePub), utf8(payload), aad(requestId, "", "device_payload"));
    await this.api.deviceRequestApprove(requestId, b64u(sealed));
  }

  /** On the new device. Poll with ``poll``, compare the words, then ``collect``. */
  async requestDevice(name: string): Promise<DeviceJoin> {
    const sk = randomBytes(32);
    const pub = x25519Public(sk);
    const created = await this.api.deviceRequestCreate(name, this.platform, b64u(pub));
    return new DeviceJoin(this, created.id, created.code, created.poll_secret, sk, pub);
  }

  // ---- Export helper --------------------------------------------------------

  /** Everything a person's own export covers, decrypted, in memory. */
  exportable(): Item[] {
    // A fill-only member isn't meant to see those secrets, so they don't go in a file.
    return this.allItems({ includeSystem: false, includeDeleted: false }).filter((i) => this.canReveal(i.vaultId));
  }

  /** Small secrets for this device only, under the same device key as the Secret Key. */
  async putDeviceSealed(name: string, value: unknown): Promise<void> {
    const key = await this.store.getMeta<CryptoKey>(DEVICE_KEY_META);
    if (!key) throw new Error("This device isn't set up");
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, key, utf8(JSON.stringify(value)) as Uint8Array<ArrayBuffer>);
    await this.store.setMeta(name, { iv: b64u(iv), ct: b64u(new Uint8Array(ct)) });
  }

  async getDeviceSealed<T>(name: string): Promise<T | null> {
    const stored = await this.store.getMeta<{ iv: string; ct: string }>(name);
    const key = await this.store.getMeta<CryptoKey>(DEVICE_KEY_META);
    if (!stored || !key) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(stored.iv) as Uint8Array<ArrayBuffer> }, key, fromB64u(stored.ct) as Uint8Array<ArrayBuffer>);
    return JSON.parse(fromUtf8(new Uint8Array(plain))) as T;
  }

  fingerprint(): string {
    const s = this.need();
    return hex(publicKeysOf(s.keyset).ed25519).slice(0, 16);
  }

  encodedKeyset(): Uint8Array {
    return encodeKeyset(this.need().keyset);
  }

  newItemBody = newBody;
}

export type EmergencyOut = {
  id: string;
  grantor_id: string;
  grantor: string;
  grantee_id: string;
  grantee: string;
  wait_days: number;
  state: "invited" | "accepted" | "ready" | "requested" | "refused" | "opened" | "ended";
  requested_at: string | null;
  opens_at: string | null;
  wrapped: Record<string, number>;
  opened_vaults: string[];
};

export class KeyChangedError extends Error {
  constructor(
    public userId: string,
    public username: string,
  ) {
    super(`${username}'s keys have changed since you last shared with them`);
  }
}

export class DeviceJoin {
  words: string[] | null = null;

  constructor(
    private client: VaultClient,
    public id: string,
    public code: string,
    private pollSecret: string,
    private sk: Uint8Array,
    private pub: Uint8Array,
  ) {}

  /** For the QR on the new device's screen: the same exchange, with the key to expect. */
  get qrText(): string {
    return `pwdev:${this.id}:${b64u(this.pub)}`;
  }

  /** Returns "pending" until approved. Words appear as soon as the approver has
   *  posted its key, so the person can compare before approving. */
  async poll(): Promise<{ status: string; words: string[] | null; secretKey?: Uint8Array }> {
    const state = await this.client.api.deviceRequestPoll(this.id, this.pollSecret);
    if (state.approver_pub) this.words = await deviceSafetyWords(this.pub, fromB64u(state.approver_pub));
    if (state.status !== "approved" || !state.payload) return { status: state.status, words: this.words };
    const plain = await openSealed(this.sk, fromB64u(state.payload), aad(this.id, "", "device_payload"));
    const { secret_key } = JSON.parse(fromUtf8(plain)) as { secret_key: string };
    const secretKey = fromB64u(secret_key);
    await this.client.saveSecretKey(secretKey);
    return { status: "approved", words: this.words, secretKey };
  }
}
