// The extension's keeper of keys. Chrome kills this service worker whenever it likes,
// Firefox runs it as an event page, so nothing here depends on staying alive: the
// unlock secret sits in storage.session (memory only, trusted contexts only, the
// default in both engines), and top-level listeners re-register on every start.
import jsQR from "jsqr";

import { agoText, commitPending, linkIsSafe, type MailCode, rankMailCodes, savedDomainsOf, withPending } from "../../../frontend/src/passwords/core/connections";
import { parseOtpauth } from "../../../frontend/src/passwords/core/totp";
import { ApiError, OfflineError, VaultApi } from "../../../frontend/src/passwords/core/api";
import { fromB64u, b64u, randomBytes } from "../../../frontend/src/passwords/core/bytes";
import { decideOffer, type SaveOffer } from "../../../frontend/src/passwords/core/autofill/capture";
import { afterFill, codeStep, flowFor, mayFillOnLoad, type TabFlow } from "../../../frontend/src/passwords/core/autofill/flow";
import { openSignedPack, ruleForHost } from "../../../frontend/src/passwords/core/autofill/rules";
import { generateForSite, generatePassphrase, generatePin, generateUsername, plusAddress } from "../../../frontend/src/passwords/core/generator";
import { aliasApi, aliasWord } from "../../../frontend/src/passwords/core/aliases";
import { baseDomain, hostOf, isPrimary, lookalikeOf, matchItems, matchUrl, siteName } from "../../../frontend/src/passwords/core/match";
import { type Item, type ItemBody, newBody, type SiteRule } from "../../../frontend/src/passwords/core/model";
import { IdbStore } from "../../../frontend/src/passwords/core/store";
import { totpCode } from "../../../frontend/src/passwords/core/totp";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { PIN_KEEP_AFTER_LOCK_MS, type PinRecord, UnlockPin } from "../../../frontend/src/passwords/core/unlockpin";
import { canCheckClipboard, CLIP_ALARM, clearClipboardIfOurs, clipboardTest, watchClipboard, writeClipboard } from "./clipboard";
import { BrowserBookmarks, VaultBookmarks } from "./bookmarks";
import { addSyncMenus, browserSyncTick, handleBrowserSync, initBrowserSync, type SyncRequest } from "./browsersync";
import { type Base, bookmarkHash, bookmarksHtml, reconcile, syncableUrl, validItem } from "../../../frontend/src/passwords/core/bookmarks";
import { handlePasskey, offerRows, useOffer } from "./passkeys";
import { packPublicKey } from "./rules-key";
import { type Candidate, type ContentRequest, ext, type FillOutcome, type LockChoice, type LockWhen, type MenuRequest, type PageReport, type PageRequest, type SaveRequest, type StateOut, type ToContent } from "./rpc";

declare const __ENGINE__: string;

const store = new IdbStore("promptly-vault");
const KEEPALIVE = "keepalive";
const LOCK_ALARM = "autolock";
const SYNC_ALARM = "sync";
const LOCK_CHOICE = "lock_choice";
/** Only ever there with "Never" chosen, sealed under the same device key as the Secret Key. */
const KEPT_UNLOCK = "kept_unlock";
/** Alarms run every 30 to 60 s. A gap this long means the machine was asleep. */
const SLEEP_GAP_MS = 3 * 60 * 1000;
const UNCONFIRMED_TAG = "unconfirmed sign-up";
const TYPED_USER_MS = 5 * 60 * 1000;

let serverUrl: string | null = null;
let token: string | null = null;
let userId: string | null = null;
let client: VaultClient | null = null;
let booted: Promise<void> | null = null;
const frameReports = new Map<string, PageReport>(); // `${tabId}:${frameId}`
/** Re-reading the shared copy empties the index first. Nothing should answer from it until
 *  that's done: a popup asking then gets an empty list, and doesn't ask again. */
let reloading: Promise<unknown> = Promise.resolve();
let recents: Record<string, number> = {};

function makeClient(): VaultClient {
  const api = new VaultApi(serverUrl ?? "", () => token);
  return new VaultClient(api, store, __ENGINE__ === "firefox" ? "firefox" : "chromium");
}

/** storage.session survives a restart of this worker, and not a browser restart. */
const session = ext.storage.session;

/** Goes up at every lock, so work begun before one can't put a secret back after it. */
let locks = 0;

async function saveSecret(secret: Uint8Array, sessionToken: string | null, locksBefore: number): Promise<void> {
  await session.set({ unlock: b64u(secret), vaultSession: sessionToken });
  // If it can't be kept, this browser asks for the password after a restart. That's all.
  await keepSecretIfChosen((await lockChoice()).when).catch(() => undefined);
  if (locks !== locksBefore) {
    await session.remove(["unlock", "vaultSession"]);
    await store.deleteMeta(KEPT_UNLOCK);
  }
}

/** With "Never" the secret outlasts the browser, and with anything else it's not on the disk. */
async function keepSecretIfChosen(when: LockWhen): Promise<void> {
  if (when !== "never") return store.deleteMeta(KEPT_UNLOCK);
  const locksBefore = locks;
  const { unlock } = await session.get("unlock");
  if (!unlock) return;
  await client!.putDeviceSealed(KEPT_UNLOCK, { unlock });
  if (locks !== locksBefore) await store.deleteMeta(KEPT_UNLOCK);
}

async function boot(): Promise<void> {
  booted ??= (async () => {
    serverUrl = (await store.getMeta<string>("server_url")) ?? null;
    token = (await store.getMeta<string>("device_token")) ?? null;
    userId = (await store.getMeta<string>("user_id")) ?? null;
    recents = (await store.getMeta<Record<string, number>>("recents")) ?? {};
    client = makeClient();
    let s = await session.get(["unlock", "vaultSession"]);
    let afterRestart = false;
    if (!s.unlock && (await lockChoice()).when === "never") {
      const kept = await client.getDeviceSealed<{ unlock: string }>(KEPT_UNLOCK).catch(() => null);
      if (kept?.unlock) {
        s = { unlock: kept.unlock, vaultSession: null };
        afterRestart = true;
      }
    }
    if (s.unlock) {
      try {
        await client.restoreSession(fromB64u(s.unlock as string), (s.vaultSession as string) ?? null);
        if (afterRestart) {
          await session.set({ unlock: s.unlock, vaultSession: null });
          void proveAfterRestart(client);
        }
        startKeepAlive();
        // Never unlocked with no timer running, whatever happened to the last one.
        if (!(await ext.alarms.get(LOCK_ALARM))) await touchLockTimer();
      } catch {
        await session.remove(["unlock", "vaultSession"]);
        await store.deleteMeta(KEPT_UNLOCK).catch(() => undefined);
        // This is a lock too, and an open vault page holds keys of its own.
        ext.runtime.sendMessage({ t: "locked" }).catch(() => undefined);
      }
    }
  })();
  return booted;
}

/** The session didn't outlast the browser, so ask for a new one. Offline, it can wait. */
async function proveAfterRestart(c: VaultClient): Promise<void> {
  await proveAgain(c);
}

/** Ask for a new session, which is the server's answer on whether this device still counts. With
 *  the key kept on this computer, a device that's been removed, a password that's been changed, a
 *  vault that's been reset (404), or Passwords being turned off has to stop it working here. */
async function proveAgain(c: VaultClient): Promise<boolean> {
  try {
    await c.reprove();
    await session.set({ vaultSession: c.api.session });
    return true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) await lockIfNever();
    return false;
  }
}

async function lockIfNever(): Promise<void> {
  if ((await lockChoice()).when === "never") await lock();
}

function startKeepAlive() {
  // An alarm every 30 s keeps Chrome from dropping the decrypted index between uses
  // while unlocked. If it's dropped anyway, boot() brings it back.
  ext.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  ext.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
}

type ExtSettings = { onClickOnly: boolean; neverHosts: string[]; mailCodes: boolean };

/** What only this extension has. */
async function extSettings(): Promise<ExtSettings> {
  return { onClickOnly: false, neverHosts: [], mailCodes: false, ...((await store.getMeta<Partial<ExtSettings>>("ext_settings")) ?? {}) };
}

/** The vault page's Settings screen writes these to the copy we share (kit.tsx). */
async function vaultSettings(): Promise<{ autoLockMinutes: number; lockOnSleep: boolean; clipboardSeconds: number }> {
  const s = (await store.getMeta<{ autoLockMinutes?: unknown; lockOnSleep?: unknown; clipboardSeconds?: unknown }>("settings")) ?? {};
  const number = (v: unknown, fallback: number, min: number) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback);
  return { autoLockMinutes: number(s.autoLockMinutes, 15, 1), lockOnSleep: s.lockOnSleep !== false, clipboardSeconds: number(s.clipboardSeconds, 30, 1) };
}

/** This browser's own, and only ever set from its own pages: it isn't in anything that syncs, so
 *  no other device and no server can turn "Never" on. Until it's first set, the Settings screen's
 *  old values stand. */
async function lockChoice(): Promise<LockChoice> {
  const chosen = await store.getMeta<Partial<LockChoice>>(LOCK_CHOICE);
  const before = await vaultSettings();
  return { when: validLockWhen(chosen?.when) ? chosen!.when! : Math.min(before.autoLockMinutes, 720), onSleep: typeof chosen?.onSleep === "boolean" ? chosen.onSleep : before.lockOnSleep };
}

function validLockWhen(w: unknown): w is LockWhen {
  return w === "browser" || w === "never" || (typeof w === "number" && Number.isFinite(w) && w >= 1 && w <= 24 * 60 * 7);
}

async function locksOnSleep(): Promise<boolean> {
  const c = await lockChoice();
  return c.when !== "never" && c.onSleep;
}

async function touchLockTimer() {
  const { when } = await lockChoice();
  if (typeof when === "number") ext.alarms.create(LOCK_ALARM, { delayInMinutes: when });
  else await ext.alarms.clear(LOCK_ALARM);
}

async function lock() {
  // First, so nothing later can leave the way back in behind.
  locks++;
  await store.deleteMeta(KEPT_UNLOCK).catch(() => undefined);
  // The keys go at once. Only telling the server waits, and it may not answer.
  const ending = client?.lock().catch(() => undefined);
  // A PIN works for a while after a lock, then goes (unlockpin.ts).
  await unlockPin.locked().catch(() => undefined);
  ext.alarms.create(PIN_ALARM, { delayInMinutes: PIN_KEEP_AFTER_LOCK_MS / 60000 + 1 });
  await session.remove(["unlock", "vaultSession", "flows", "pendingSave", "typedUsers", "deviceRequests", "beat", "onLoadDone"]);
  await ext.alarms.clear(KEEPALIVE);
  await ext.alarms.clear(LOCK_ALARM);
  await ext.alarms.clear(SYNC_ALARM);
  booted = null;
  client = makeClient();
  // Nothing we copied should outlast the lock.
  await clearClipboardIfOurs().catch(() => undefined);
  updateBadgeAll();
  // A vault page has its own keys in memory, and goes back to its locked screen. That's so even
  // if this worker has just restarted and holds none itself.
  ext.runtime.sendMessage({ t: "locked" }).catch(() => undefined);
  await Promise.race([ending, new Promise((r) => setTimeout(r, 3000))]);
}

/** Firefox doesn't report "locked" from the idle API, and sleep isn't always reported
 *  on Chromium either. A timer that fires far later than asked means the machine slept. */
async function noticeSleep() {
  const now = Date.now();
  const { beat } = await session.get("beat");
  await session.set({ beat: now });
  if (typeof beat === "number" && now - beat > SLEEP_GAP_MS && client?.unlocked && (await locksOnSleep())) await lock();
}

async function onIdleState(state: string) {
  // Locked screen or sleep: lock the vault too, unless the person said not to.
  if (state !== "locked") return;
  await boot();
  if (await locksOnSleep()) await lock();
}

ext.alarms.onAlarm.addListener(async (a) => {
  await boot();
  if (a.name === LOCK_ALARM && typeof (await lockChoice()).when === "number") await lock();
  if (a.name === KEEPALIVE) await noticeSleep();
  if (a.name === CLIP_ALARM) await clearClipboardIfOurs();
  if (a.name === PIN_ALARM) await unlockPin.expireIfStale();
  if (a.name === SYNC_ALARM && client?.unlocked) {
    await safeSync();
    await runBookmarks();
    await browserSyncTick();
    await refreshDeviceRequests();
  }
});

ext.idle.onStateChanged.addListener((state) => void onIdleState(state));

async function safeSync() {
  if (!client?.unlocked) return;
  try {
    await client.sync();
  } catch (e) {
    // A 403 can be about one shared vault, so it's asking for a session that says if it's us.
    if (e instanceof ApiError && (e.status === 401 || e.status === 403) && (await proveAgain(client)) && e.status === 401) {
      try {
        await client.sync();
      } catch (again) {
        /* the token's revoked or the server's gone: keep working from the local copy */
        if (again instanceof ApiError && again.status === 401) await lockIfNever();
      }
    }
  }
  // Open vault pages re-read the copy we share. Nobody listening is fine.
  ext.runtime.sendMessage({ t: "vaultChanged" }).catch(() => undefined);
}

// ---- Bookmarks (BOOKMARKS.md) -------------------------------------------------------------

type BookmarkState = { on: boolean; at?: string; total?: number; unsynced?: number; failed?: number; held?: { fromBrowser: number; fromVault: number }; error?: string };

const bookmarkState = async () => ((await store.getMeta<BookmarkState>("bookmark_sync")) ?? { on: false }) as BookmarkState;

/** What the screens need to say what's going on, including how many this browser has. */
async function bookmarkStateForScreen() {
  const state = await bookmarkState();
  let inBrowser: number | undefined;
  if (ext.bookmarks) {
    try {
      inBrowser = (await new BrowserBookmarks().read()).filter((n) => n.url !== undefined).length;
    } catch {
      /* the count's a nicety */
    }
  }
  return { ...state, granted: !!ext.bookmarks, inBrowser };
}

let bookmarksRunning: Promise<void> | null = null;
let bookmarksAllowed: number | undefined;
/** A day: long enough that a server can't take them away a few at a time. */
const DELETION_WINDOW_MS = 24 * 60 * 60 * 1000;
let bookmarkFailure: string | null = null;
let bookmarksAgain = false;

/** One at a time. Changes while it runs are picked up by one more run. */
async function runBookmarks(allowUpTo?: number): Promise<void> {
  // A yes given while a run's going is for the next one.
  if (allowUpTo !== undefined) bookmarksAllowed = allowUpTo;
  if (bookmarksRunning) {
    bookmarksAgain = true;
    return bookmarksRunning;
  }
  bookmarksRunning = (async () => {
    do {
      bookmarksAgain = false;
      const allowed = bookmarksAllowed;
      bookmarksAllowed = undefined;
      await bookmarkPass(allowed);
    } while (bookmarksAgain);
  })().finally(() => {
    bookmarksRunning = null;
  });
  return bookmarksRunning;
}

async function bookmarkPass(allowUpTo: number | undefined) {
  const state = await bookmarkState();
  const allowMassDelete = allowUpTo !== undefined;
  // A held run waits for its answer. Locked, it catches up on the next run after unlocking.
  if (!state.on || !client?.unlocked || (state.held && !allowMassDelete)) return;
  if (!ext.bookmarks) {
    // Taken away in the browser's own settings. Saying nothing would look like an empty list.
    await store.setMeta("bookmark_sync", { ...state, error: "The browser isn't allowing access to bookmarks. Turn this off and on again." });
    return;
  }
  try {
    if (__TEST_BUILD__ && bookmarkFailure) throw new Error(bookmarkFailure);
    const vaultId = await client.personalVaultId();
    // In travel mode this vault's items are off the device on purpose. That isn't a deletion.
    if ((await store.getVaults()).find((v) => v.id === vaultId)?.hidden) return;
    let salt = await store.getMeta<string>("bookmark_salt");
    if (!salt) {
      salt = b64u(randomBytes(16));
      await store.setMeta("bookmark_salt", salt);
    }
    const browser = new BrowserBookmarks();
    const base = (await store.getMeta<Base>("bookmark_base")) ?? {};
    const now = Date.now();
    const recent = ((await store.getMeta<{ at: number; n: number }[]>("bookmark_deletes")) ?? []).filter((d) => now - d.at < DELETION_WINDOW_MS);
    const r = await reconcile(browser, new VaultBookmarks(client, vaultId), base, { hash: bookmarkHash(salt), newId: () => crypto.randomUUID(), deletedLately: recent.reduce((sum, d) => sum + d.n, 0), allowUpTo });
    // Turned off while that ran: what it was doing has finished, and off stays off.
    if (!(await bookmarkState()).on) return;
    if (r.status === "held") {
      await store.setMeta("bookmark_sync", { ...state, held: { fromBrowser: r.fromBrowser, fromVault: r.fromVault } });
      updateBadgeAll();
      return;
    }
    await store.setMeta("bookmark_base", r.base);
    // A person's yes starts the count again.
    await store.setMeta("bookmark_deletes", allowMassDelete ? [] : r.deleted ? [...recent, { at: now, n: r.deleted }] : recent);
    await store.setMeta("bookmark_sync", { on: true, at: new Date().toISOString(), total: r.total, unsynced: browser.unsynced, failed: r.counts.failed });
    if (r.wroteVault) await safeSync();
  } catch (e) {
    if (!(await bookmarkState()).on) return;
    await store.setMeta("bookmark_sync", { ...state, error: e instanceof Error ? e.message : "Couldn't sync bookmarks" });
  }
}

let bookmarkTimer: ReturnType<typeof setTimeout> | undefined;
/** A folder move or an import is many events. The worker may die first, and then the next
 *  alarm does the same job, because a run compares states and doesn't need the events. */
function bookmarksChanged() {
  clearTimeout(bookmarkTimer);
  bookmarkTimer = setTimeout(() => {
    void boot().then(() => runBookmarks());
  }, 3000);
}

function listenToBookmarks() {
  const b = ext.bookmarks;
  if (!b) return; // Not granted, or this browser hasn't got it.
  for (const event of [b.onCreated, b.onRemoved, b.onChanged, b.onMoved, b.onChildrenReordered, b.onImportEnded]) {
    if (event && !event.hasListener(bookmarksChanged)) event.addListener(bookmarksChanged);
  }
}
listenToBookmarks();
// Open tabs, sent tabs, history and the reading list (browsersync.ts, SYNC.md).
initBrowserSync({ boot, client: () => client, store });

// ---- A new device asking to join (plan 3.4) ----------------------------------------------

async function refreshDeviceRequests() {
  if (!client?.unlocked) return;
  let count: number;
  try {
    count = (await client.api.deviceRequests()).length;
  } catch {
    return; // Offline, or the session needs proving again: the next sync sorts that out.
  }
  const before = (await session.get("deviceRequests")).deviceRequests ?? 0;
  if (count === before) return;
  await session.set({ deviceRequests: count });
  updateBadgeAll();
}

// ---- Site access: everywhere after an explanation, or only on click -----------------

const ALL_SITES = ["https://*/*", "http://*/*"];
const FIELDS_SCRIPT = "promptly-fields";
const PASSKEY_SCRIPT = "promptly-passkey";

async function hasAllSites(): Promise<boolean> {
  return ext.permissions.contains({ origins: ALL_SITES });
}

async function setSiteAccess(onClickOnly: boolean) {
  const s = await extSettings();
  await store.setMeta("ext_settings", { ...s, onClickOnly });
  await applySiteAccess();
}

/** On click is the setting, or the browser hasn't given us every site. */
async function fillsOnClickOnly(): Promise<boolean> {
  return (await extSettings()).onClickOnly || !(await hasAllSites());
}

let accessQueue: Promise<unknown> = Promise.resolve();

/** Several events can ask at once, and registering a script twice throws. */
function applySiteAccess(): Promise<void> {
  const run = accessQueue.then(applySiteAccessNow, applySiteAccessNow);
  accessQueue = run.catch(() => undefined);
  return run;
}

async function applySiteAccessNow() {
  const registered = new Set((await ext.scripting.getRegisteredContentScripts().catch(() => [])).map((x) => x.id));
  if (await fillsOnClickOnly()) {
    // The passkey wrapper is useless without the fields script, which is its bridge, so
    // neither stays. WebAuthn then belongs to the browser alone (DECISIONS).
    const drop = [FIELDS_SCRIPT, PASSKEY_SCRIPT].filter((id) => registered.has(id));
    if (drop.length) await ext.scripting.unregisterContentScripts({ ids: drop });
    return;
  }
  if (!registered.has(FIELDS_SCRIPT)) {
    await ext.scripting.registerContentScripts([{ id: FIELDS_SCRIPT, js: ["content.js"], matches: ALL_SITES, allFrames: true, runAt: "document_start", persistAcrossSessions: true }]);
  }
  if (!registered.has(PASSKEY_SCRIPT)) {
    await ext.scripting.registerContentScripts([{ id: PASSKEY_SCRIPT, js: ["passkey-main.js"], matches: ["https://*/*", "http://localhost/*", "http://*.localhost/*"], allFrames: true, runAt: "document_start", world: "MAIN", persistAcrossSessions: true } as chrome.scripting.RegisteredContentScript]);
  }
}

declare const __TEST_BUILD__: boolean;

ext.runtime.onInstalled.addListener(() => {
  applySiteAccess().catch(() => undefined);
  // WebDriver can't navigate Firefox to an extension page, so a test build opens one.
  if (__TEST_BUILD__ && __ENGINE__ === "firefox") ext.tabs.create({ url: ext.runtime.getURL("vault.html") });
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({ id: "fill", title: "Fill from Promptly Passwords", contexts: ["editable"] });
    ext.contextMenus.create({ id: "generate", title: "Generate a password here", contexts: ["editable"] });
    addSyncMenus();
  });
});
ext.permissions.onAdded?.addListener(() => applySiteAccess().catch(() => undefined));
ext.permissions.onRemoved?.addListener(() => applySiteAccess().catch(() => undefined));
ext.runtime.onStartup?.addListener(() => {
  applySiteAccess().catch(() => undefined);
  // With "Never" there's a vault to bring back, for the badge and for syncing, before anyone asks.
  boot().then(updateBadgeAll).catch(() => undefined);
});

// ---- Fill -----------------------------------------------------------------------------

function loginItems(): Item[] {
  return client?.unlocked ? client.allItems() : [];
}

function canReveal(item: Item): boolean {
  return client?.canReveal(item.vaultId) ?? false;
}

/** Logins for this page, best first. Ones Auto judges to be for another service on the same
 *  domain come last, marked `other`: they're listed apart, under "Other logins for ...". */
function candidatesFor(url: string): Candidate[] {
  return matchItems(loginItems(), url, recents).map(({ item, downgrade, kind }) => ({
    id: item.id,
    title: item.body.title,
    username: item.body.username ?? "",
    // A fill-only member can fill a code, and can't be shown one.
    hasTotp: !!item.body.totp?.secret && canReveal(item),
    kind: item.body.kind,
    downgrade,
    reprompt: !!item.body.reprompt,
    other: !isPrimary(kind),
  }));
}

/** What a panel or menu shows for a page: its logins, the domain the other ones are on, and
 *  the saved site it only looks like when nothing's offered (D93: never filled, but said). */
function pageRows(list: Candidate[], url: string): { candidates: Candidate[]; site: string; lookalike: string | null } {
  const host = hostOf(url);
  return { candidates: list, site: siteName(url), lookalike: host && !list.length ? lookalikeOf(host, savedDomains()) : null };
}

/** Mid-flow, the item already chosen goes first (plan 6.3). */
async function orderedCandidates(tabId: number, url: string): Promise<Candidate[]> {
  const list = candidatesFor(url);
  const flow = flowFor((await getFlows())[String(tabId)], hostOf(url) ?? "", sameSite);
  if (flow) list.sort((a, b) => (a.id === flow.itemId ? -1 : b.id === flow.itemId ? 1 : 0));
  return list;
}

function savedDomains(): string[] {
  const out: string[] = [];
  for (const i of loginItems()) for (const u of i.body.urls ?? []) {
    const h = hostOf(u.url);
    if (h) out.push(h);
  }
  return out;
}

type FrameRow = { frameId: number; url: string; parentFrameId: number; documentId?: string };

async function frames(tabId: number): Promise<FrameRow[]> {
  try {
    const list = await ext.webNavigation.getAllFrames({ tabId });
    return (list ?? []).map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId, documentId: (f as unknown as { documentId?: string }).documentId }));
  } catch {
    return [{ frameId: 0, url: (await ext.tabs.get(tabId)).url ?? "", parentFrameId: -1 }];
  }
}

/** To one frame. With a documentId (Chromium), to the document that was checked and no
 *  other: navigate the frame and this fails instead of reaching whatever's there now. */
async function send<T>(tabId: number, frameId: number, msg: ToContent, documentId?: string): Promise<T | undefined> {
  const pinned = documentId && __ENGINE__ !== "firefox" && !(__TEST_BUILD__ && testFlags.noDocumentId);
  try {
    return (await ext.tabs.sendMessage(tabId, msg, pinned ? ({ documentId } as chrome.tabs.MessageSendOptions) : { frameId })) as T;
  } catch {
    return undefined;
  }
}

/** A frame that won't answer soon gets left out. A page mustn't be able to hold a check
 *  open by keeping one of its frames busy, with the window that gives it to swap another. */
function inTime<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

const REPORT_MS = 800;

/** The last report from a frame, or a fresh one: a restarted worker has none. */
async function reportOf(tabId: number, frameId: number): Promise<PageReport | undefined> {
  return frameReports.get(`${tabId}:${frameId}`) ?? send<PageReport>(tabId, frameId, { t: "report" });
}

/** Puts the content script in place if site access is "on click". */
async function ensureContent(tabId: number) {
  const pong = await send<PageReport>(tabId, 0, { t: "report" });
  if (pong) return;
  try {
    await ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch {
    /* a page the browser won't let anyone script */
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string): boolean {
  return baseDomain(a) !== null && baseDomain(a) === baseDomain(b);
}

/** Which roles from this form kind get which values from the item. */
async function valuesFor(body: ItemBody): Promise<Record<string, string>> {
  const v: Record<string, string> = {};
  const put = (k: string, x?: string | null) => {
    if (x) v[k] = x;
  };
  put("username", body.username);
  put("email", body.username?.includes("@") ? body.username : body.email);
  put("password", body.password);
  put("current-password", body.password);
  // Changing it on the site: the new one was saved first, so this can't lose it.
  put("new-password", body.pendingPassword);
  put("confirm-password", body.pendingPassword);
  if (body.totp?.secret) v.otp = await totpCode(body.totp);
  put("card-number", body.cardNumber);
  put("card-name", body.cardholder);
  put("card-cvv", body.cardCvv);
  put("card-exp-month", body.cardExpMonth);
  put("card-exp-year", body.cardExpYear);
  if (body.cardExpMonth && body.cardExpYear) put("card-exp", `${body.cardExpMonth.padStart(2, "0")}/${body.cardExpYear.slice(-2)}`);
  put("first-name", body.firstName);
  put("last-name", body.lastName);
  if (body.firstName || body.lastName) put("full-name", [body.firstName, body.lastName].filter(Boolean).join(" "));
  put("address1", body.address1);
  put("address2", body.address2);
  put("city", body.city);
  put("state", body.state);
  put("postcode", body.postcode);
  put("country", body.country);
  put("phone", body.phone);
  put("company", body.company);
  if (body.kind === "identity") put("email", body.email);
  return v;
}

/** Only what a frame has boxes for. A frame holding the security code box never gets the
 *  card number, whatever else was approved. */
function valuesForRoles(values: Record<string, string>, roles: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of roles) {
    if (values[role]) out[role] = values[role];
    if (role === "otp-digit" && values.otp) out.otp = values.otp;
    // Each stands in for the other when filling.
    if (role === "email" && values.username) out.username = values.username;
    if (role === "username" && values.email) out.email = values.email;
  }
  return out;
}

const hasValueFor = (values: Record<string, string>, roles: string[]) => Object.keys(valuesForRoles(values, roles)).length > 0;

type FillOptions = {
  confirmOrigin?: string;
  confirmDowngrade?: boolean;
  confirmLookalike?: boolean;
  confirmCard?: boolean;
  confirmFrames?: string[];
  reprompted?: boolean;
  /** The menu's frame, or the top page on load: those fill there and nowhere else. */
  onlyFrame?: number;
  /** A page caused this, not a person, so it doesn't count as using the vault. */
  notUse?: boolean;
};

type FrameFill = { frameId: number; url: string; origin: string; documentId?: string; roles: string[] };

const ROLE_NAMES: Record<string, string> = {
  username: "username",
  email: "email",
  password: "password",
  "current-password": "password",
  "new-password": "new password",
  "confirm-password": "new password",
  otp: "2FA code",
  "otp-digit": "2FA code",
  "card-number": "card number",
  "card-name": "name on card",
  "card-exp": "card expiry",
  "card-exp-month": "card expiry",
  "card-exp-year": "card expiry",
  "card-cvv": "security code",
  "first-name": "name",
  "last-name": "name",
  "full-name": "name",
  address1: "address",
  address2: "address",
  city: "city",
  state: "state",
  postcode: "postcode",
  country: "country",
  phone: "phone",
  company: "company",
};

/** What a confirmation should say will go in, in words, once each. */
function namesOf(values: Record<string, string>, roles: string[]): string[] {
  return [...new Set(roles.filter((r) => hasValueFor(values, [r])).map((r) => ROLE_NAMES[r] ?? r))];
}

async function fill(tabId: number, itemId: string, opts: FillOptions): Promise<FillOutcome> {
  if (!client?.unlocked) return { ok: false, reason: "locked" };
  const item = client.get(itemId);
  if (!item) return { ok: false, reason: "no-fields" };
  if (item.body.reprompt && !opts.reprompted) return { ok: false, reason: "reprompt" };
  await ensureContent(tabId);

  const list = await frames(tabId);
  const asked = await Promise.all(list.map(async (f) => ({ f, report: await inTime(send<PageReport>(tabId, f.frameId, { t: "report", fresh: true }, f.documentId), REPORT_MS) })));
  const reports = asked
    .filter(({ f, report }) => report && report.fieldCount > 0 && (opts.onlyFrame === undefined || f.frameId === opts.onlyFrame))
    .map(({ f, report }) => ({ frameId: f.frameId, documentId: f.documentId, url: report!.url || f.url, report: report! }))
    // An opaque origin is nobody's, whatever the address says.
    .filter((r) => r.report.origin !== "null" && r.report.origin === originOf(r.url));
  const topUrl = list.find((f) => f.frameId === 0)?.url ?? "";
  if (!reports.length) return { ok: false, reason: "no-fields" };

  const values = await valuesFor(item.body);
  // Cards and identities aren't tied to a site: they need a confirmation (the popup),
  // never one inline click. Hosted card fields often sit in a frame each, so every frame
  // with a box for this item takes part, and each frame on another origin is named first.
  const siteless = item.body.kind === "card" || item.body.kind === "identity";
  let targets: FrameFill[];
  let host: string;

  if (siteless) {
    const usable = reports.filter((r) => hasValueFor(values, r.report.roles));
    if (!usable.length) return { ok: false, reason: "no-fields" };
    const others = [...new Set(usable.map((r) => originOf(r.url)).filter((o) => o !== originOf(topUrl)))];
    if (!opts.confirmCard || others.some((o) => !opts.confirmFrames?.includes(o))) return { ok: false, reason: "confirm-card", frames: others, fills: namesOf(values, usable.flatMap((r) => r.report.roles)) };
    targets = usable.map((r) => ({ frameId: r.frameId, documentId: r.documentId, origin: r.report.origin, url: r.url, roles: r.report.roles }));
    host = hostOf(topUrl) ?? "";
  } else {
    // Which frame? Prefer one whose origin matches the item. A frame on a different
    // origin from the item needs a confirmation that shows the real origin.
    const urls = item.body.urls ?? [];
    const exactHost = (url: string) => {
      const h = hostOf(url) ?? "";
      return urls.some((u) => hostOf(u.url) === h);
    };
    // No prompt in an iframe only for an exact-host match to the item, on the page's site.
    const frameIsPlain = (r: { frameId: number; url: string }) => r.frameId === 0 || (exactHost(r.url) && sameSite(hostOf(r.url) ?? "", hostOf(topUrl) ?? ""));
    const matching = reports.filter((r) => urls.some((u) => matchUrl(u, r.url, { itemMatch: item.body.match })));
    let chosen = matching.find((r) => r.frameId === 0) ?? matching[0];
    if (!chosen) {
      // No saved URL matches anywhere here: the person chose it by hand from the popup.
      chosen = reports.find((r) => r.frameId === 0) ?? reports[0];
      if (opts.confirmOrigin !== originOf(chosen.url)) return { ok: false, reason: "confirm-origin", origin: originOf(chosen.url), fills: namesOf(values, chosen.report.roles) };
    } else if (!frameIsPlain(chosen) && opts.confirmOrigin !== originOf(chosen.url)) {
      return { ok: false, reason: "confirm-origin", origin: originOf(chosen.url), fills: namesOf(values, chosen.report.roles) };
    }

    host = hostOf(chosen.url) ?? "";
    // Saved over https, page on http.
    const scheme = originOf(chosen.url).split(":")[0];
    if (scheme === "http" && urls.some((u) => u.url.startsWith("https://") || !u.url.includes("://")) && !opts.confirmDowngrade) {
      return { ok: false, reason: "confirm-downgrade", origin: originOf(chosen.url), fills: namesOf(values, chosen.report.roles) };
    }
    if (!matching.length && !opts.confirmLookalike) {
      const looks = lookalikeOf(host, savedDomains());
      if (looks) return { ok: false, reason: "confirm-lookalike", origin: originOf(chosen.url), lookalike: looks, fills: namesOf(values, chosen.report.roles) };
    }

    // A login split across frames: the rest of it, only from frames that pass with no
    // prompt, and only the boxes the first frame doesn't have.
    const chosenFrame = chosen;
    targets = [{ frameId: chosen.frameId, documentId: chosen.documentId, origin: chosen.report.origin, url: chosen.url, roles: chosen.report.roles }];
    for (const r of matching) {
      if (r.frameId === chosenFrame.frameId || !frameIsPlain(r)) continue;
      const missing = r.report.roles.filter((role) => !chosenFrame.report.roles.includes(role));
      if (hasValueFor(values, missing)) targets.push({ frameId: r.frameId, documentId: r.documentId, origin: r.report.origin, url: r.url, roles: missing });
    }
  }

  if (__TEST_BUILD__ && testFlags.fillDelayMs) await new Promise((r) => setTimeout(r, testFlags.fillDelayMs));
  // One frame at a time: filling moves focus, and frames at once fight over it.
  const answers: ({ filled: string[]; left?: string[] } | undefined)[] = [];
  for (const t of targets) {
    const answer = await inTime(send<{ filled: string[]; left?: string[] }>(tabId, t.frameId, { t: "doFill", values: valuesForRoles(values, t.roles), origin: t.origin }, t.documentId), 5000);
    answers.push(answer);
    if (__TEST_BUILD__) testLog.doFills.push({ tabId, url: t.url, keys: Object.keys(valuesForRoles(values, t.roles)), filled: answer?.filled });
  }
  if (answers.every((a) => !a)) return { ok: false, reason: "no-frame" };
  const filled = [...new Set(answers.flatMap((a) => a?.filled ?? []))];
  if (!filled.length) return { ok: false, reason: "no-fields" };
  const left = namesOf(values, answers.flatMap((a) => a?.left ?? []));

  recents[itemId] = Date.now();
  await store.setMeta("recents", recents);
  const flows = await getFlows();
  flows[String(tabId)] = afterFill(flows[String(tabId)], itemId, host, filled, sameSite);
  await session.set({ flows });
  if (!opts.notUse) await touchLockTimer();
  return { ok: true, filled, left };
}

async function getFlows(): Promise<Record<string, TabFlow>> {
  return ((await session.get("flows")).flows as Record<string, TabFlow>) ?? {};
}

// ---- 2FA after sign-in (plan 6.3) --------------------------------------------------------

const codeTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** The page changed, and a sign-in may have moved on. Waits a moment, since pages draw
 *  their code box late, and doesn't restart for a page that won't stop changing. */
function scheduleCodeStep(tabId: number) {
  if (codeTimers.has(tabId)) return;
  codeTimers.set(
    tabId,
    setTimeout(() => {
      codeTimers.delete(tabId);
      runCodeStep(tabId).catch(() => undefined);
    }, 1200),
  );
}

async function runCodeStep(tabId: number) {
  if (!client?.unlocked) return;
  const flows = await getFlows();
  const tab = await ext.tabs.get(tabId).catch(() => null);
  const flow = flowFor(flows[String(tabId)], hostOf(tab?.url ?? "") ?? "", sameSite);
  if (!flow || flow.otpDone) return;
  const item = client.get(flow.itemId);
  // Fill-only members aren't shown codes, and the clipboard is showing.
  const hasTotp = !!item?.body.totp?.secret && canReveal(item);
  if (!hasTotp) return;
  const list = await frames(tabId);
  const reports = await Promise.all(list.map((f) => inTime(send<PageReport>(tabId, f.frameId, { t: "report", fresh: true }, f.documentId), REPORT_MS)));
  if (!reports[list.findIndex((f) => f.frameId === 0)]) return; // A page we can't read tells us nothing.
  const roles = reports.flatMap((r) => r?.roles ?? []);
  const step = codeStep(flow, hasTotp, {
    hasCodeField: roles.includes("otp") || roles.includes("otp-digit"),
    hasPasswordField: roles.includes("password") || roles.includes("current-password"),
  });
  if (step !== "copy") return;
  flows[String(tabId)] = { ...flow, otpDone: true };
  await session.set({ flows });
  const code = await totpCode(item!.body.totp!);
  if (!(await writeClipboard(code))) return;
  const { clipboardSeconds } = await vaultSettings();
  await watchClipboard(code, clipboardSeconds);
  const text = `2FA code copied. Clears in ${clipboardSeconds} seconds.`;
  if (__TEST_BUILD__) testLog.notices.push(text);
  await send(tabId, 0, { t: "notice", text });
}

// ---- Badge ---------------------------------------------------------------------------

async function updateBadge(tabId: number, url: string | undefined) {
  if (!url) return;
  const asking = client?.unlocked ? ((await session.get("deviceRequests")).deviceRequests ?? 0) : 0;
  if (asking) {
    await ext.action.setBadgeText({ tabId, text: "!" }).catch(() => undefined);
    await ext.action.setBadgeBackgroundColor({ tabId, color: "#B3261E" }).catch(() => undefined);
    await ext.action.setTitle({ tabId, title: "Promptly Passwords: a new device is asking to join" }).catch(() => undefined);
    return;
  }
  if ((await offerRows(tabId, client)).length) {
    await ext.action.setBadgeText({ tabId, text: "PK" }).catch(() => undefined);
    await ext.action.setBadgeBackgroundColor({ tabId, color: "#D97757" }).catch(() => undefined);
    await ext.action.setTitle({ tabId, title: "Promptly Passwords: a passkey is ready for this site" }).catch(() => undefined);
    return;
  }
  // Only this site's own logins: another service's on the same domain isn't one to count.
  const n = client?.unlocked ? candidatesFor(url).filter((c) => !c.other).length : 0;
  await ext.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => undefined);
  await ext.action.setBadgeBackgroundColor({ tabId, color: "#D97757" }).catch(() => undefined);
  await ext.action.setTitle({ tabId, title: "Promptly Passwords" }).catch(() => undefined);
}

function updateBadgeAll() {
  ext.tabs.query({}, (tabs) => {
    for (const t of tabs) if (t.id !== undefined) updateBadge(t.id, t.url);
  });
}

ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || info.url) {
    boot().then(() => updateBadge(tabId, tab.url));
  }
});
ext.tabs.onRemoved.addListener(async (tabId) => {
  for (const k of frameReports.keys()) if (k.startsWith(`${tabId}:`)) frameReports.delete(k);
  // Each only written if this tab's in it: any tab closing shouldn't rewrite what other
  // tabs are in the middle of changing.
  const flows = await getFlows();
  if (flows[String(tabId)]) {
    delete flows[String(tabId)];
    await session.set({ flows });
  }
  const typed = await typedUsers();
  if (typed[String(tabId)]) {
    delete typed[String(tabId)];
    await session.set({ typedUsers: typed });
  }
  // A password offered for saving doesn't outlast the page it was for.
  const waiting = ((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? [];
  if (waiting.some((x) => x.tabId === tabId)) await session.set({ pendingSave: waiting.filter((x) => x.tabId !== tabId) });
});

// Single-page apps change route with no load. Tell that frame to look again, within its
// own budget. onHistoryStateUpdated is the only way to see pushState from outside the page.
ext.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  void send(tabId, frameId, { t: "routeChanged" });
});

// ---- Saving what someone typed --------------------------------------------------------

type PendingSave = { tabId: number; frameId: number; offer: SaveOffer; submittedKind: string; at: number };
type TypedUser = { username: string; host: string; at: number };

/** The newest live offer for a tab. Offers are kept per frame, so one frame can't replace
 *  or clear another's. */
async function pendingSave(tabId: number): Promise<PendingSave | null> {
  const list = ((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? [];
  const live = list.filter((x) => x.tabId === tabId && Date.now() - x.at < 5 * 60 * 1000);
  return live.sort((a, b) => b.at - a.at)[0] ?? null;
}

async function setPending(tabId: number, frameId: number | null, offer: SaveOffer | null, submittedKind = "signin") {
  const list = (((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? []).filter((x) => x.tabId !== tabId || (frameId !== null && x.frameId !== frameId));
  if (offer && frameId !== null) list.push({ tabId, frameId, offer, submittedKind, at: Date.now() });
  await session.set({ pendingSave: list });
}

/** Whose offers count: the top page, and frames on the top page's own origin. A frame from
 *  anywhere else has no business putting a question on someone else's page. */
async function mayOffer(sender: chrome.runtime.MessageSender): Promise<boolean> {
  const tabId = sender.tab?.id;
  const origin = senderOrigin(sender);
  if (tabId === undefined || !origin || origin === "null") return false;
  if ((sender.frameId ?? 0) === 0) return true;
  const top = (await frames(tabId)).find((f) => f.frameId === 0);
  return !!top && originOf(top.url) === origin;
}

function senderOrigin(sender: chrome.runtime.MessageSender): string {
  return (sender as { origin?: string }).origin ?? originOf(sender.url ?? "");
}

async function typedUsers(): Promise<Record<string, TypedUser>> {
  return ((await session.get("typedUsers")).typedUsers as Record<string, TypedUser>) ?? {};
}

/** The username step of a sign-in spread over two pages. Kept per tab, session only. */
async function rememberTyped(tabId: number, username: string, url: string | undefined) {
  if (!client?.unlocked) return;
  const typed = await typedUsers();
  typed[String(tabId)] = { username, host: hostOf(url ?? "") ?? "", at: Date.now() };
  await session.set({ typedUsers: typed });
}

/** The vault's own pages on our server, where the master password, Secret Key and PINs are
 *  typed. Those are never offered as a login to save. Promptly's ordinary sign-in still is. */
function isOwnVaultPage(url: string | undefined): boolean {
  if (!url || !serverUrl) return false;
  try {
    const u = new URL(url);
    return u.origin === new URL(serverUrl).origin && /^\/passwords(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

async function onCaptured(tabId: number, sender: chrome.runtime.MessageSender, c: Extract<ContentRequest, { t: "captured" }>["capture"]) {
  if (!client?.unlocked || !(await mayOffer(sender))) return;
  if (isOwnVaultPage(sender.url ?? c.url)) return;
  const s = await extSettings();
  // Where it came from is the browser's word, not the message's.
  const url = sender.url ?? c.url;
  c.url = url;
  c.host = hostOf(url) ?? c.host;
  if (!c.username) {
    const typed = (await typedUsers())[String(tabId)];
    const host = hostOf(url) ?? "";
    if (typed && Date.now() - typed.at < TYPED_USER_MS && (typed.host === host || sameSite(typed.host, host))) c.username = typed.username;
  }
  const known = matchItems(loginItems(), url).map(({ item, kind }) => ({
    kind,
    id: item.id,
    username: item.body.username,
    password: item.body.password,
    pendingPassword: item.body.pendingPassword,
    unconfirmed: item.body.tags?.includes(UNCONFIRMED_TAG),
  }));
  const exact = known.filter((k) => k.kind === "host" || k.kind === "exact");
  const looser = known.filter((k) => k.kind !== "host" && k.kind !== "exact");
  const offer = decideOffer(c as Parameters<typeof decideOffer>[0], exact, s.neverHosts, looser);
  await setPending(tabId, sender.frameId ?? 0, offer, c.kind);
  if (!offer) return;
  // If the page has moved on already, its "hello" came too soon to know about this.
  const tab = await ext.tabs.get(tabId).catch(() => null);
  if (tab?.url && tab.url !== url) await send(tabId, 0, { t: "showSave", kind: c.kind });
}

async function answerSave(tabId: number, answer: "save" | "update" | "never" | "dismiss") {
  const p = await pendingSave(tabId);
  await setPending(tabId, null, null);
  await send(tabId, 0, { t: "hideSave" });
  if (!p || !client?.unlocked) return;
  if (answer === "dismiss") return;
  if (answer === "never") {
    const s = await extSettings();
    await store.setMeta("ext_settings", { ...s, neverHosts: [...new Set([...s.neverHosts, p.offer.host])] });
    return;
  }
  const it = p.offer.itemId ? client.get(p.offer.itemId) : undefined;
  if (it && p.offer.generated === "signup") {
    // The site took the password we saved for it: now it's a login like any other.
    await client.update(it.id, { ...it.body, username: p.offer.username ?? it.body.username, tags: (it.body.tags ?? []).filter((x) => x !== UNCONFIRMED_TAG) });
  } else if (it && p.offer.generated === "change") {
    await client.update(it.id, commitPending(it.body));
  } else if (p.offer.kind === "update" && it) {
    await client.update(it.id, { ...it.body, password: p.offer.password, username: p.offer.username ?? it.body.username });
  } else {
    await client.saveNew(await client.personalVaultId(), newBody("login", p.offer.host.replace(/^www\./, ""), { username: p.offer.username, password: p.offer.password, urls: [{ url: originOf(p.offer.url) }] }));
  }
  const typed = await typedUsers();
  delete typed[String(tabId)];
  await session.set({ typedUsers: typed });
  await safeSync();
  const tab = await ext.tabs.get(tabId).catch(() => null);
  updateBadge(tabId, tab?.url);
}

// ---- Generating a password into a page ----------------------------------------------------

/** Saved before it goes on the page, so a failed submit can't lose it. On a change form
 *  it's waiting on an existing login. Otherwise it's a new login, tagged until the site
 *  takes it, and trying again reuses that one rather than leaving a trail of them. */
async function generateInto(tabId: number, frameId: number, url: string, chosen?: string): Promise<boolean> {
  const c = client!;
  const host = hostOf(url);
  const password = generateForSite(host);
  const report = await reportOf(tabId, frameId);
  let target: Item | undefined;
  if (report?.kinds.includes("change-password")) {
    // A new password belongs to this site's own login, never another service's on the domain.
    const list = (await orderedCandidates(tabId, url)).filter((x) => !x.other);
    const id = chosen && list.some((x) => x.id === chosen) ? chosen : list[0]?.id;
    target = id ? c.get(id) : undefined;
    // An item that asks for the master password isn't changed without it.
    if (target?.body.reprompt) return false;
  }
  // Someone who can't edit a shared login can't change it. They get a login of their own.
  const role = target ? (await c.vaults()).find((v) => v.id === target.vaultId)?.role : undefined;
  if (target && (role === "manage" || role === "edit")) {
    await c.update(target.id, withPending(target.body, password));
  } else {
    const origin = originOf(url);
    const waiting = loginItems().find((i) => i.body.tags?.includes(UNCONFIRMED_TAG) && !i.body.username && (i.body.urls ?? []).some((u) => originOf(u.url) === origin));
    if (waiting) await c.update(waiting.id, { ...waiting.body, password });
    else await c.saveNew(await c.personalVaultId(), newBody("login", host?.replace(/^www\./, "") ?? "New login", { password, urls: url ? [{ url: origin }] : [], tags: [UNCONFIRMED_TAG] }));
  }
  await safeSync();
  await send(tabId, frameId, { t: "fillGenerated", password, origin: originOf(url) });
  return true;
}

// ---- Messages --------------------------------------------------------------------------

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== ext.runtime.id) return false;
  const base = ext.runtime.getURL("");
  return !!sender.url && sender.url.startsWith(base);
}

/** By path: a web accessible page's address has a different id under use_dynamic_url. */
function isOurPage(sender: chrome.runtime.MessageSender, path: string): boolean {
  if (!isExtensionPage(sender)) return false;
  try {
    return new URL(sender.url!).pathname === path;
  } catch {
    return false;
  }
}

/** Popup, full page and side panel: no tab, or a tab showing our own page. Our web
 *  accessible frames live in other pages' tabs, and only get MenuRequest. */
function isTrustedPage(sender: chrome.runtime.MessageSender): boolean {
  return isExtensionPage(sender) && !isOurPage(sender, "/menu.html") && !isOurPage(sender, "/save.html");
}

/** Asks the server once a session, so opening the popup doesn't wait on the network. */
async function previewFlag(): Promise<boolean> {
  const known = (await session.get("preview")).preview;
  if (typeof known === "boolean") return known;
  try {
    if (token && serverUrl) {
      const { preview } = await client!.api.prelogin();
      await session.set({ preview });
      return preview;
    }
  } catch {
    /* offline: stay cautious */
  }
  return true;
}

async function state(): Promise<StateOut> {
  const unlocked = !!client?.unlocked;
  if (unlocked) void refreshDeviceRequests();
  return {
    connected: !!token && !!serverUrl,
    serverUrl,
    hasKit: client ? await client.hasDeviceKit() : false,
    unlocked,
    preview: await previewFlag(),
    onClickOnly: await fillsOnClickOnly(),
    deviceRequests: unlocked ? Number((await session.get("deviceRequests")).deviceRequests ?? 0) : 0,
  };
}

async function handlePage(m: PageRequest): Promise<unknown> {
  await boot();
  await reloading;
  const c = client!;
  switch (m.t) {
    case "state":
      return state();
    case "unlock": {
      const locksBefore = locks;
      const r = await c.unlock(m.password, undefined, { keepSecret: true });
      await saveSecret(r.secret!, c.api.session, locksBefore);
      startKeepAlive();
      await touchLockTimer();
      updateBadgeAll();
      return { offline: r.offline };
    }
    case "lock":
      await lock();
      return { ok: true };
    case "session": {
      const s = await session.get(["unlock", "vaultSession"]);
      return { unlock: s.unlock ?? null, session: s.vaultSession ?? null };
    }
    case "list": {
      if (!c.unlocked) return [];
      await touchLockTimer();
      const common = new Set(["login", "card", "identity", "note"]);
      return c
        .search(m.query ?? "")
        .filter((i) => (m.favorite ? i.body.favorite : true) && (m.totp ? !!i.body.totp?.secret && c.canReveal(i.vaultId) : true))
        .filter((i) => (m.kind === undefined ? true : m.kind === "other" ? !common.has(i.body.kind) : i.body.kind === m.kind))
        .filter((i) => !i.body.archived)
        .slice(0, 200)
        .map((i) => ({ id: i.id, title: i.body.title, username: i.body.username ?? "", kind: i.body.kind, hasTotp: !!i.body.totp?.secret && c.canReveal(i.vaultId), reprompt: !!i.body.reprompt, favorite: !!i.body.favorite }));
    }
    case "counts": {
      const n = { login: 0, card: 0, identity: 0, note: 0, other: 0, codes: 0, favorites: 0, bookmarks: 0 };
      if (!c.unlocked) return n;
      for (const i of c.allItems()) {
        if (i.body.archived) continue;
        if (i.body.kind === "login" || i.body.kind === "card" || i.body.kind === "identity" || i.body.kind === "note") n[i.body.kind]++;
        else n.other++;
        if (i.body.totp?.secret && c.canReveal(i.vaultId)) n.codes++;
        if (i.body.favorite) n.favorites++;
      }
      return n;
    }
    case "secretField": {
      const it = c.unlocked ? c.get(m.id) : undefined;
      if (!it) return {};
      if (m.field === "username") return { value: it.body.username };
      // The same gates as showing the item: nothing for a fill-only member, and nothing until
      // the master password's been asked for again on an item that wants it.
      if (!c.canReveal(it.vaultId)) return { reason: "fill-only" };
      if (it.body.reprompt && !m.reprompted) return { reason: "reprompt" };
      await touchLockTimer();
      return { value: it.body.password };
    }
    case "bookmarkTree": {
      if (!c.unlocked) return [];
      return (await new VaultBookmarks(c, await c.personalVaultId()).read()).filter(validItem);
    }
    case "openBookmark": {
      const it = c.unlocked ? c.get(m.id) : undefined;
      const url = it?.body.kind === "bookmark" && it.vaultId === (await c.personalVaultId()) ? it.body.bookmark?.url : undefined;
      // A folder has no address, and the sync's rule on what's an address applies here too.
      if (!url || !syncableUrl(url)) return { ok: false };
      await ext.tabs.create({ url });
      return { ok: true };
    }
    case "matches": {
      const tab = await ext.tabs.get(m.tabId);
      const url = m.url ?? tab.url ?? "";
      if (!c.unlocked) return { url, candidates: [], site: siteName(url), lookalike: null };
      await touchLockTimer();
      return { url, ...pageRows(await orderedCandidates(m.tabId, url), url) };
    }
    case "item":
      return c.unlocked ? (c.get(m.id)?.body ?? null) : null;
    case "totp": {
      const it = c.unlocked ? c.get(m.id) : undefined;
      if (!it?.body.totp) return null;
      // The same gates as showing the item: no code for a fill-only member, and none
      // until the master password's been asked for again on an item that wants it.
      if (!c.canReveal(it.vaultId)) return null;
      if (it.body.reprompt && !m.reprompted) return null;
      return { code: await totpCode(it.body.totp), period: it.body.totp.steam ? 30 : it.body.totp.period ?? 30 };
    }
    case "fill":
      return fill(m.tabId, m.itemId, m);
    case "mailForTab":
      return c.unlocked ? mailRowsForTab(m.tabId) : { mail: [], otherMail: [] };
    case "mailCodeFill":
      return c.unlocked ? mailCodeFromPopup(m.tabId, m.id) : { ok: false };
    case "mailLinkOpen":
      return c.unlocked ? mailLinkFromPopup(m.tabId, m.id, m.confirmed === true) : { ok: false };
    case "addLogin": {
      const it = await c.saveNew(await c.personalVaultId(), newBody("login", m.title, { username: m.username, password: m.password, urls: m.url ? [{ url: m.url }] : [] }));
      await safeSync();
      return { id: it.id };
    }
    case "check":
      return c.checkPassword(m.password);
    case "sync":
      // A page changed the offline copy we share: re-read it, then talk to the server.
      if (c.unlocked) {
        reloading = reloading.then(() => c.reload()).catch(() => undefined);
        await reloading;
      }
      await safeSync();
      return { ok: true };
    case "setAccess":
      await setSiteAccess(m.onClickOnly);
      return { ok: true, onClickOnly: await fillsOnClickOnly() };
    case "unlockWithSecret": {
      const secret = fromB64u(m.secret);
      const locksBefore = locks;
      const r = await c.unlockWithSecret(secret);
      await saveSecret(secret, c.api.session, locksBefore);
      startKeepAlive();
      await touchLockTimer();
      updateBadgeAll();
      return { offline: r.offline };
    }
    case "extSettings": {
      const s = await extSettings();
      const pin = await unlockPin.status();
      return { onClickOnly: await fillsOnClickOnly(), mailCodes: s.mailCodes, pin: pin.has, pinShort: pin.short, clipCheck: await canCheckClipboard() };
    }
    case "lockChoice":
      return lockChoice();
    case "setLockChoice": {
      if (!validLockWhen(m.when) || typeof m.onSleep !== "boolean") throw new Error("That isn't a setting.");
      // Keep the secret first: if that can't be done, nothing has changed.
      await keepSecretIfChosen(m.when);
      await store.setMeta(LOCK_CHOICE, { when: m.when, onSleep: m.onSleep });
      if (c.unlocked) await touchLockTimer();
      return lockChoice();
    }
    case "bookmarkState":
      return bookmarkStateForScreen();
    case "bookmarkSyncNow":
      if (c.unlocked) {
        await safeSync();
        await runBookmarks();
      }
      return bookmarkStateForScreen();
    case "setBookmarks": {
      if (!m.on) {
        // What's in the vault stays. Turning it on again is a fresh merge, which only adds.
        await store.setMeta("bookmark_sync", { on: false });
        await store.setMeta("bookmark_base", {});
        return { ok: true };
      }
      // A permission just given can take a moment to reach a service worker.
      for (let i = 0; i < 20 && !ext.bookmarks; i++) await new Promise((r) => setTimeout(r, 100));
      if (!ext.bookmarks) return { ok: false, error: "The browser hasn't made bookmarks available yet. Try again in a moment." };
      listenToBookmarks();
      await store.setMeta("bookmark_sync", { on: true });
      await store.setMeta("bookmark_base", {});
      if (c.unlocked) {
        await safeSync();
        await runBookmarks();
      }
      return { ok: true };
    }
    case "bookmarkAnswer": {
      const state = await bookmarkState();
      if (!state.held) return { ok: false };
      if (m.go) {
        // For the number they were shown. If it's grown since, it asks again.
        await store.setMeta("bookmark_sync", { ...state, held: undefined });
        await runBookmarks(state.held.fromBrowser + state.held.fromVault);
        return { ok: true };
      }
      // No: nothing goes. Starting the comparison again brings each side's back to the other.
      await store.setMeta("bookmark_base", {});
      await store.setMeta("bookmark_sync", { on: true });
      await runBookmarks();
      return { ok: true };
    }
    case "bookmarkExport": {
      if (!ext.bookmarks) return null;
      return bookmarksHtml(await new BrowserBookmarks().read());
    }
    case "setMailCodes":
      await store.setMeta("ext_settings", { ...(await store.getMeta<object>("ext_settings")), mailCodes: m.on });
      return { ok: true };
    case "setPin": {
      if (m.pin === null) {
        await unlockPin.clear();
        return { ok: true };
      }
      const { unlock } = await session.get("unlock");
      if (!unlock) throw new Error("Unlock first");
      await unlockPin.set(m.pin, fromB64u(unlock as string));
      return { ok: true };
    }
    case "pinUnlock": {
      // One try at a time, each counted before it's checked (unlockpin.ts).
      const secret = await unlockPin.open(String(m.pin ?? ""));
      const locksBefore = locks;
      await c.unlockWithSecret(secret);
      await saveSecret(secret, c.api.session, locksBefore);
      startKeepAlive();
      await touchLockTimer();
      updateBadgeAll();
      return { ok: true };
    }
    case "scanTabQr": {
      // Only of what's showing, only when asked, and it goes nowhere.
      const shot = await ext.tabs.captureVisibleTab(m.windowId ?? (undefined as unknown as number), { format: "png" });
      const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(bitmap, 0, 0);
      const img = g.getImageData(0, 0, bitmap.width, bitmap.height);
      return { uri: jsQR(img.data, img.width, img.height)?.data ?? null };
    }
    case "addTotp": {
      const totp = parseOtpauth(m.uri);
      if (!totp) throw new Error("That QR code isn't a 2FA setup code.");
      if (m.itemId) {
        const item = c.get(m.itemId);
        if (!item) throw new Error("Unknown item");
        const before = item.body.totp;
        // A QR on a page shouldn't quietly take the place of the code someone relies on.
        if (before?.secret && before.secret !== totp.secret && !m.replace) return { ok: false, replaces: item.body.title };
        const kept = before?.secret && before.secret !== totp.secret ? [{ name: `Earlier 2FA secret (replaced ${new Date().toISOString().slice(0, 10)})`, value: before.secret, type: "hidden" as const }] : [];
        await c.update(m.itemId, { ...item.body, totp, fields: [...(item.body.fields ?? []), ...kept] });
      } else {
        await c.saveNew(await c.personalVaultId(), newBody("totp", m.title, { totp, urls: m.url ? [{ url: m.url }] : [] }));
      }
      await safeSync();
      return { ok: true };
    }
    case "teach":
      await ensureContent(m.tabId);
      await send(m.tabId, 0, { t: "teachStart" });
      return { ok: true };
    case "reportForm":
      await ensureContent(m.tabId);
      return send<string>(m.tabId, 0, { t: "describeForm" });
    case "connected":
      await store.setMeta("server_url", m.serverUrl);
      await store.setMeta("device_token", m.token);
      await store.setMeta("device_id", m.deviceId);
      await store.setMeta("user_id", m.userId);
      booted = null;
      await boot();
      await applySiteAccess().catch(() => undefined);
      return { ok: true };
    case "activity":
      // Someone's using an open vault page: same as using the popup.
      if (c.unlocked) await touchLockTimer();
      return { ok: true };
    case "generate":
      if (m.mode === "passphrase") return { password: generatePassphrase() };
      if (m.mode === "pin") return { password: generatePin() };
      if (m.mode === "username") return { password: generateUsername() };
      return { password: generateForSite(m.host) };
    case "plusBase":
      return { email: mostUsedEmail() };
    case "aliasDomains":
      return c.unlocked ? aliasApi(c.api).domains().catch(() => []) : [];
    case "aliasNew":
      return c.unlocked ? aliasInto(m.tabId, m.domainId, m.custom) : { ok: false, reason: "locked" };
    case "plusAddress": {
      const base = m.host ? baseDomain(m.host) : null;
      try {
        return { address: plusAddress(m.email, base?.split(".")[0] ?? "") };
      } catch {
        return { address: null };
      }
    }
    case "clipWatch":
      await watchClipboard(m.text, (await vaultSettings()).clipboardSeconds);
      return { ok: true };
    case "clipClear":
      await clearClipboardIfOurs();
      return { ok: true };
    case "saveOfferFor": {
      const p = await pendingSave(m.tabId);
      return p ? { kind: p.offer.kind, username: p.offer.username ?? "", host: p.offer.host } : null;
    }
    case "saveAnswerFor":
      await answerSave(m.tabId, m.answer);
      return { ok: true };
    case "handoffFor":
      return handoffFor(m.tabId);
  }
}

/** A new alias on your own domain for the sign-up on this tab: saved as the username of
 *  the login being made here (the same tagged login a generated password goes into),
 *  and filled into the page's email or username box. Only the top page's own frames
 *  get it: an address isn't a secret, but a third party's frame has no use for it. */
async function aliasInto(tabId: number, domainId?: string, custom?: string): Promise<{ ok: boolean; address?: string; filled?: boolean; reason?: string }> {
  const c = client!;
  const api = aliasApi(c.api);
  const domains = await api.domains();
  const d = domains.find((x) => x.id === domainId) ?? domains.find((x) => x.status === "ok") ?? domains[0];
  if (!d) return { ok: false, reason: "no-domain" };
  const tab = await ext.tabs.get(tabId);
  const url = tab.url ?? "";
  const origin = originOf(url);
  const host = hostOf(url);
  const waiting = loginItems().find((i) => i.body.tags?.includes(UNCONFIRMED_TAG) && (i.body.urls ?? []).some((u) => originOf(u.url) === origin));
  const alias = await api.make(d.id, aliasWord(d.word_style, { url, custom }), waiting?.id ?? null);
  if (waiting) {
    await c.update(waiting.id, { ...waiting.body, username: alias.address });
  } else {
    const made = await c.saveNew(await c.personalVaultId(), newBody("login", host?.replace(/^www\./, "") ?? "New login", { username: alias.address, urls: url ? [{ url: origin }] : [], tags: [UNCONFIRMED_TAG] }));
    await api.edit(alias.id, { item_id: made.id }).catch(() => undefined);
  }
  await safeSync();
  for (const { f, report } of await reportedFrames(tabId)) {
    if (report.origin !== origin || !report.roles.some((r) => r === "email" || r === "username")) continue;
    const out = await inTime(send<{ filled: string[] }>(tabId, f.frameId, { t: "doFill", values: { username: alias.address }, origin: report.origin }, f.documentId), 5000);
    if (out?.filled.length) return { ok: true, address: alias.address, filled: true };
  }
  return { ok: true, address: alias.address, filled: false };
}

/** Where a plus-address starts from: the address this person signs up with most. */
function mostUsedEmail(): string | null {
  const counts = new Map<string, number>();
  for (const i of loginItems()) {
    const u = i.body.username;
    if (u?.includes("@")) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [email, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = email;
  return best;
}

async function handleContent(m: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await boot();
  await reloading;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  switch (m.t) {
    case "pageReport":
      frameReports.set(`${tabId}:${sender.frameId ?? 0}`, m.report);
      if (__TEST_BUILD__) testLog.reportCount[tabId] = (testLog.reportCount[tabId] ?? 0) + 1;
      if (senderOrigin(sender) !== "null") await maybeAutofillOnLoad(tabId, sender.frameId ?? 0, m.report.kinds ?? [], sender.url);
      if ((await getFlows())[String(tabId)]) scheduleCodeStep(tabId);
      return null;
    case "hello": {
      const host = hostOf(m.url) ?? "";
      const rule = await findRule(host);
      const pending = await pendingSave(tabId);
      return { rule, pendingSave: !!pending && (sender.frameId ?? 0) === 0, submittedKind: pending?.submittedKind, unlocked: !!client?.unlocked, inlineMenu: !(await fillsOnClickOnly()) };
    }
    case "captured":
      await onCaptured(tabId, sender, m.capture);
      return null;
    case "capturedUser":
      if ((await mayOffer(sender)) && !isOwnVaultPage(sender.url)) await rememberTyped(tabId, m.username, sender.url);
      return null;
    case "submitFailed":
      await setPending(tabId, sender.frameId ?? 0, null);
      return null;
    case "teachResult":
      if (client?.unlocked) {
        await client.saveNew(await client.personalVaultId(), newBody("site_rule", `Rule for ${m.rule.host}`, { rule: m.rule as SiteRule }));
        await safeSync();
      }
      return null;
  }
}

// ---- The signed rules pack (plan 6.5) -----------------------------------------------------

let packRules: SiteRule[] | null = null;

/** Verifies a pack against the pinned key. Nothing here runs: rules are CSS selectors for
 *  a page's boxes, and those boxes still pass the same fill guard. */
async function loadPack(packBytes: Uint8Array, signature: string): Promise<SiteRule[]> {
  const key = packPublicKey();
  if (!key) throw new Error("No key");
  const seen = (await store.getMeta<number>("rules_pack_version")) ?? 0;
  const pack = openSignedPack({ pack: b64u(packBytes), signature }, fromB64u(key), seen);
  await store.setMeta("rules_pack_version", pack.version);
  return pack.rules;
}

/** Comes with the extension and with nothing else. Any failure, including a release build
 *  with no key yet, means no pack, and there's nothing to tell anyone. */
async function shippedPack(): Promise<SiteRule[]> {
  if (packRules) return packRules;
  try {
    const [bytes, signature] = await Promise.all([
      fetch(ext.runtime.getURL("rules/pack.json")).then((r) => r.arrayBuffer()),
      fetch(ext.runtime.getURL("rules/pack.sig")).then((r) => r.text()),
    ]);
    packRules = await loadPack(new Uint8Array(bytes), signature.trim());
  } catch {
    packRules = [];
  }
  return packRules;
}

/** The person's own taught rule wins over anything in the pack. */
async function findRule(host: string): Promise<SiteRule | null> {
  if (client?.unlocked) {
    // Only from your own vault: anyone who can write to a shared vault could plant one, to stop a
    // site filling or to aim a fill at another box.
    const c = client;
    const rules = c.allItems({ includeSystem: true }).filter((i) => i.body.kind === "site_rule" && i.body.rule && c.isOwn(i.vaultId)).map((i) => i.body.rule!);
    const taught = ruleForHost(rules, host);
    if (taught) return taught;
  }
  return ruleForHost(await shippedPack(), host);
}

const PIN_ALARM = "pin-expire";

/** The unlock PIN's record lives in session storage, under "pin". */
const unlockPin = new UnlockPin({
  get: async () => (await session.get("pin")).pin as PinRecord | undefined,
  set: (r) => session.set({ pin: r }),
  remove: () => session.remove("pin"),
});

/** Is this the person? For a passkey prompt that has to say so to a site. Five wrong PINs
 *  wipe it, as they do at the unlock screen, and a master password has no such limit. */
async function isThePerson(c: VaultClient, typed: string): Promise<boolean> {
  if (await c.checkPassword(typed)) return true;
  return unlockPin.check(typed);
}

async function fetchMailCodes(): Promise<MailCode[]> {
  try {
    return await client!.api.request<MailCode[]>("GET", "/mail/codes");
  } catch {
    return [];
  }
}

/** Does this mail belong to this page? A code from anyone else, on any page, stays out of
 *  the menu altogether: one click would hand another site's code to whoever asked. */
function mailBelongsHere(found: MailCode, url: string): boolean {
  const [ranked] = rankMailCodes([found], url, savedDomainsOf(client!.allItems()));
  return ranked.matches;
}

const linkHostOf = (link: string | null) => hostOf(link ?? "");

/** The frames of a tab that have fields, with what each reports. */
async function reportedFrames(tabId: number) {
  await ensureContent(tabId);
  const list = await frames(tabId);
  const asked = await Promise.all(list.map(async (f) => ({ f, report: await inTime(send<PageReport>(tabId, f.frameId, { t: "report", fresh: true }, f.documentId), REPORT_MS) })));
  return asked
    .filter(({ f, report }) => report && report.fieldCount > 0 && report.origin !== "null" && report.origin === originOf(report.url || f.url))
    .map(({ f, report }) => ({ f, report: report!, url: report!.url || f.url }));
}

/** The toolbar's rows. A page can't cover the toolbar, so this is the way in on Firefox, whose
 *  menu on the page doesn't fill, and in on-click mode. Each frame is judged by its own address. */
async function mailRowsForTab(tabId: number): Promise<{ mail: unknown[]; otherMail: string[] }> {
  const rows = new Map<string, { id: string; code: string | null }>();
  const others = new Set<string>();
  for (const { report, url } of await reportedFrames(tabId)) {
    const { mail, otherMail } = await mailRows(report.kinds ?? [], url);
    for (const row of mail as { id: string; code: string | null }[]) {
      const had = rows.get(row.id);
      if (!had || (!had.code && row.code)) rows.set(row.id, row);
    }
    for (const d of otherMail) others.add(d);
  }
  return { mail: [...rows.values()], otherMail: [...others] };
}

/** The code goes only to a frame the sender belongs to, and that has a box for it. */
async function mailCodeFromPopup(tabId: number, id: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await extSettings()).mailCodes) return { ok: false };
  const found = (await fetchMailCodes()).find((x) => x.id === id);
  if (!found?.code) return { ok: false, reason: "gone" };
  for (const { f, report, url } of await reportedFrames(tabId)) {
    if (!report.roles.includes("otp") || !mailBelongsHere(found, url)) continue;
    const out = await inTime(send<{ filled: string[] }>(tabId, f.frameId, { t: "doFill", values: { otp: found.code }, origin: report.origin }, f.documentId), 5000);
    return { ok: !!out?.filled.length };
  }
  return { ok: false, reason: "no-box" };
}

/** A link goes somewhere at once, so it needs the person's yes and a sender that fits the top page. */
async function mailLinkFromPopup(tabId: number, id: string, confirmed: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (!confirmed || !(await extSettings()).mailCodes) return { ok: false, reason: "not-confirmed" };
  const found = (await fetchMailCodes()).find((x) => x.id === id);
  if (!found) return { ok: false, reason: "gone" };
  const tab = await ext.tabs.get(tabId);
  if (!mailBelongsHere(found, tab.url ?? "") || !linkIsSafe(found)) return { ok: false, reason: "other-sender" };
  await ext.tabs.update(tabId, { url: found.link! });
  return { ok: true };
}

/** Opt-in. The server's told nothing about this page: the matching happens here. Only the
 *  domain is shown, because the sender's name is whatever the email says. The domain is
 *  only what the From line says as well, with no DKIM or SPF behind it (SECURITY). */
async function mailRows(kinds: string[], url: string | undefined): Promise<{ mail: unknown[]; otherMail: string[] }> {
  if (!client?.unlocked || !url || !(await extSettings()).mailCodes) return { mail: [], otherMail: [] };
  if (!kinds.some((k) => k === "otp" || k === "email-first" || k === "signin")) return { mail: [], otherMail: [] };
  const ranked = rankMailCodes(await fetchMailCodes(), url, savedDomainsOf(client.allItems()));
  const here = ranked.filter((r) => r.matches);
  const otherMail = kinds.includes("otp") ? [...new Set(ranked.filter((r) => !r.matches && r.code).map((r) => r.from_domain))] : [];
  return {
    otherMail,
    mail: here.map((r) => ({
      id: r.id,
      domain: r.from_domain,
      ago: agoText(r.agoSeconds),
      code: kinds.includes("otp") ? r.code : null,
      linkHost: linkIsSafe(r) ? linkHostOf(r.link) : null,
    })),
  };
}

/** Off unless an item asks for it, and then only in the clearest case (plan 6.6). */
async function maybeAutofillOnLoad(tabId: number, frameId: number, kinds: string[], url: string | undefined) {
  // Every page reports, so the cheap checks go before matching against the whole vault.
  if (!url || frameId !== 0 || !kinds.includes("signin") || !client?.unlocked) return;
  // Another service's login on the same domain is no part of "the one clear match".
  const matches = matchItems(loginItems(), url, recents).filter((m) => isPrimary(m.kind));
  const local = (u: URL) => u.hostname === "localhost" || u.hostname.endsWith(".localhost");
  const allowed = mayFillOnLoad({ url, frameId, kinds }, matches.map((m) => ({ kind: m.kind, optedIn: !!m.item.body.autofillOnLoad, reprompt: !!m.item.body.reprompt, downgrade: m.downgrade })), __TEST_BUILD__ ? local : undefined);
  if (!allowed) return;
  // Once per address per tab, across worker restarts: a page that blanks itself or keeps
  // re-rendering doesn't get filled over and over.
  const done = ((await session.get("onLoadDone")).onLoadDone as Record<string, string>) ?? {};
  if (done[String(tabId)] === url) return;
  done[String(tabId)] = url;
  await session.set({ onLoadDone: done });
  await fill(tabId, matches[0].item.id, { onlyFrame: 0, notUse: true });
}

/** The frame holding this token, and only that one: a page can open a second menu of its
 *  own in another frame, and "the first frame with a menu" would be the wrong one. */
async function tokenOwner(tabId: number, kind: "ownsMenu" | "ownsSave", token: unknown): Promise<(FrameRow & { origin: string }) | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const list = await frames(tabId);
  const answers = await Promise.all(list.map((f) => inTime(send<{ origin: string; url: string } | false>(tabId, f.frameId, { t: kind, token }, f.documentId), REPORT_MS)));
  const owners = list.flatMap((f, i) => {
    const a = answers[i];
    return a ? [{ ...f, url: a.url, origin: a.origin }] : [];
  });
  return owners.length === 1 && owners[0].origin !== "null" ? owners[0] : null;
}

// ---- Firefox: the on-page menu hands off to the toolbar panel (D78) -------------
// Firefox has no reading that tells us the menu is really showing (press.ts), so a click
// there never fills. It opens the toolbar panel with the login it named at the top, and
// the fill is one more click there, where a page can't cover anything. What the menu
// says is only a suggestion to the panel: the fill goes through the panel's own checks.

/** How long a pick waits for the panel. */
const HANDOFF_MS = 60_000;
/** How long after a page's menu or save bar opened the panel that the panel asks for a
 *  deliberate press (D79). Generous: a person takes a second or two at most. */
const PAGE_OPENED_MS = 10_000;

type Handoff = { itemId: string | null; host: string; at: number };
/** Per tab, as a promise, so a panel that opens before the check's done waits for it. */
const handoffs = new Map<number, Promise<Handoff | null>>();
/** When a page last got the panel opened, from any tab. Set before anything's checked, so
 *  a frame a page made up (a wrong token) still makes the panel careful. */
let pageOpenedAt = 0;

function startHandoff(tabId: number, m: { token: string; itemId?: string }): Promise<Handoff | null> {
  pageOpenedAt = Date.now();
  const job = (async (): Promise<Handoff | null> => {
    await boot();
    await reloading;
    if (await fillsOnClickOnly()) return null;
    const owner = await tokenOwner(tabId, "ownsMenu", m.token);
    if (!owner) return null;
    // Only a login the menu could have shown for that frame.
    const known = typeof m.itemId === "string" && !!client?.unlocked && (await orderedCandidates(tabId, owner.url)).some((c) => c.id === m.itemId);
    return { itemId: known ? m.itemId! : null, host: hostOf(owner.url) ?? "", at: Date.now() };
  })();
  handoffs.set(tabId, job);
  return job;
}

async function openPanelFromPage(): Promise<boolean> {
  pageOpenedAt = Date.now();
  try {
    // Firefox 149 and later open it with no gesture (bug 1799344). Earlier ones refuse, and
    // the frame says where to click instead. It always opens in the focused window.
    await (ext.action as unknown as { openPopup?: () => Promise<void> }).openPopup?.();
    return true;
  } catch {
    return false;
  }
}

/** For the panel: the login the page's menu picked, if the tab's still on that site. */
async function handoffFor(tabId: number): Promise<{ item: Candidate | null; pageOpened: boolean }> {
  const pageOpened = Date.now() - pageOpenedAt < PAGE_OPENED_MS;
  const h = await handoffs.get(tabId);
  if (!h?.itemId || Date.now() - h.at > HANDOFF_MS || !client?.unlocked) return { item: null, pageOpened };
  let url = "";
  try {
    url = (await ext.tabs.get(tabId)).url ?? "";
  } catch {
    /* the tab's gone */
  }
  if (hostOf(url) !== h.host) return { item: null, pageOpened };
  const item = (await orderedCandidates(tabId, url)).find((c) => c.id === h.itemId) ?? null;
  return { item, pageOpened };
}

async function handleMenu(m: MenuRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Before anything that waits, so a panel opening right now finds it.
  if (__ENGINE__ === "firefox" && m.t === "menuHandoff" && sender.tab?.id !== undefined) {
    await startHandoff(sender.tab.id, m);
    return { ok: true };
  }
  await boot();
  await reloading;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  if (m.t === "menuSize") {
    // Only its size, to the frame that opened it, so the box fits what it shows.
    const o = await tokenOwner(tabId, "ownsMenu", m.token);
    if (o && Number.isFinite(m.h)) await send(tabId, o.frameId, { t: "menuResize", h: m.h, token: m.token }, o.documentId);
    return null;
  }
  // Firefox has no way to tell this menu is really showing (press.ts), and "on click" means
  // no inline menu at all. The menu says so, and this holds whatever it says. On Firefox
  // the menu may list logins and open the panel, and nothing else (D78).
  if (await fillsOnClickOnly()) return { ok: false, reason: "popup", locked: false, candidates: [] };
  if (__ENGINE__ === "firefox" && m.t !== "menuList" && m.t !== "menuOpenPopup") return { ok: false, reason: "popup", locked: false, candidates: [] };
  const owner = await tokenOwner(tabId, "ownsMenu", m.token);
  if (!owner) return { ok: false, reason: "popup", locked: false, candidates: [] };
  const hostFrame = owner.frameId;
  const url = owner.url;
  const inFrame = <T>(msg: ToContent) => send<T>(tabId, hostFrame, msg, owner.documentId);
  const checked = async (itemId: string) => (await inFrame<{ ok: boolean; reason?: string }>({ t: "menuCheck", itemId, token: m.token })) ?? { ok: false };
  switch (m.t) {
    case "menuList": {
      if (!client?.unlocked) return { locked: true, candidates: [] };
      const list = await orderedCandidates(tabId, url);
      // Titles and usernames only, in a frame the page can't read. Picking one opens the panel.
      if (__ENGINE__ === "firefox") return { locked: false, candidates: list, handoff: true };
      const report = await inFrame<PageReport>({ t: "report" });
      const kinds = report?.kinds ?? [];
      // Firefox's menu doesn't act on a click, so its passkeys are in the toolbar panel.
      const passkeys = __ENGINE__ === "firefox" ? [] : await offerRows(tabId, client, hostFrame);
      return { locked: false, ...pageRows(list, url), kinds, url, passkeys, ...(await mailRows(kinds, url)) };
    }
    case "menuPick": {
      if (!client?.unlocked) return { ok: false, reason: "locked" };
      // The frame that hosts the menu re-checks that the menu's really visible.
      const check = await checked(m.itemId);
      if (!check?.ok) return { ok: false, reason: "popup", detail: check?.reason };
      const item = client.get(m.itemId);
      if (!item || item.body.kind === "card" || item.body.kind === "identity" || item.body.reprompt) return { ok: false, reason: "popup" };
      const r = await fill(tabId, m.itemId, { onlyFrame: hostFrame });
      return r.ok ? r : { ok: false, reason: "popup", detail: r.reason };
    }
    case "menuPasskey": {
      if (!client?.unlocked) return { ok: false };
      // The same check as filling a login, and the prompt's window comes after it.
      const check = await checked("passkey");
      if (!check?.ok) return { ok: false, reason: "popup" };
      if (!(await offerRows(tabId, client, hostFrame)).some((o) => o.key === m.key && o.credentialId === m.credentialId)) return { ok: false };
      return useOffer(tabId, m.key, m.credentialId);
    }
    case "menuMailCode":
    case "menuMailLink": {
      if (!client?.unlocked) return { ok: false };
      // The same check as filling a login: the menu has to be really visible.
      const check = await checked("mail");
      if (!check?.ok) return { ok: false, reason: "popup" };
      const found = (await fetchMailCodes()).find((x) => x.id === m.id);
      if (!found) return { ok: false, reason: "gone" };
      // Decided here as well as in the menu.
      if (!mailBelongsHere(found, url)) return { ok: false, reason: "other-sender" };
      if (m.t === "menuMailCode") {
        if (!found.code) return { ok: false };
        const out = await inFrame<{ filled: string[] }>({ t: "doFill", values: { otp: found.code }, origin: owner.origin });
        return { ok: !!out?.filled.length };
      }
      if (!m.confirmed || !linkIsSafe(found)) return { ok: false, reason: "not-confirmed" };
      await ext.tabs.update(tabId, { url: found.link! });
      return { ok: true };
    }
    case "menuGenerate": {
      if (!client?.unlocked) return { ok: false };
      const check = await checked("generate");
      if (!check?.ok) return { ok: false, reason: "popup", detail: check?.reason };
      return { ok: await generateInto(tabId, hostFrame, url, m.itemId) };
    }
    case "menuClose":
      await inFrame({ t: "report" });
      return null;
    case "menuOpenPopup":
      // Needs a user gesture on some versions; the toolbar icon's still there.
      return openPanelFromPage();
  }
}

async function handleSave(m: SaveRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Firefox: Save opens the toolbar panel, which asks the same question (D78). The
  // panel's marked careful before anything waits or the token's checked, like the menu's,
  // so it's careful whoever asked.
  if (m.t === "saveOpenPopup") return __ENGINE__ === "firefox" && sender.tab?.id !== undefined ? openPanelFromPage() : null;
  await boot();
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  // Only the bar the top page opened, which holds this token. A page that frames our page
  // itself, having learned its address, doesn't have one.
  const owner = await tokenOwner(tabId, "ownsSave", m.token);
  if (!owner || owner.frameId !== 0) return null;
  if (m.t === "saveOffer") {
    const p = await pendingSave(tabId);
    // Only what's needed to ask: never the password back.
    return p ? { kind: p.offer.kind, username: p.offer.username ?? "", host: p.offer.host } : null;
  }
  // Firefox can't judge a press on the bar (press.ts): saving goes through the popup there.
  if (__ENGINE__ === "firefox" && m.answer !== "dismiss") return null;
  await answerSave(tabId, m.answer);
  return null;
}

// ---- Test builds only: esbuild drops all of this from a release ------------------------------

const testFlags = { noDocumentId: false, fillDelayMs: 0 };

const testLog = {
  doFills: [] as { tabId: number; url: string; keys: string[]; filled?: string[] }[],
  notices: [] as string[],
  reportCount: {} as Record<number, number>,
};

async function handleTest(m: { op: string; [k: string]: unknown }): Promise<unknown> {
  await boot();
  switch (m.op) {
    case "bookmarkRun": {
      // Everything on a test machine shares one address, so nginx's limit can get in the way.
      const sync = async () => {
        for (let i = 0; i < 20; i++) {
          try {
            return await client!.sync();
          } catch (e) {
            if (!/too many/i.test(String(e))) throw e;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        throw new Error("Rate limited for too long");
      };
      await sync();
      await runBookmarks();
      await sync();
      return bookmarkState();
    }
    case "bookmarkBreak":
      // So a test can see what a failed sync looks like on screen.
      bookmarkFailure = (m.error as string) ?? null;
      return { ok: true };
    case "seedBody": {
      const it = await client!.saveNew(await client!.personalVaultId(), m.body as ItemBody);
      await client!.sync();
      return { id: it.id };
    }
    case "bookmarkPlant": {
      const vaultId = await client!.createSharedVault(`Planted ${Date.now()}`);
      await client!.saveNew(vaultId, newBody("bookmark", m.title as string, { bookmark: { parent: "root:bar", pos: 1, url: m.url as string } }));
      return { vaultId };
    }
    case "bookmarkItems":
      return client!.allItems({ includeSystem: true }).filter((i) => i.body.kind === "bookmark").map((i) => ({ id: i.id, vaultId: i.vaultId, title: i.body.title, ...i.body.bookmark }));
    case "idle":
      await onIdleState(m.state as string);
      return { unlocked: !!client?.unlocked };
    case "restartLike":
      // What a browser restart does here, for an engine where a test can't restart it.
      await session.remove(["unlock", "vaultSession"]);
      client = null;
      booted = null;
      await boot();
      return { unlocked: !!(client as VaultClient | null)?.unlocked };
    case "staleSecret":
      // What a password changed in a page that didn't say so would leave behind.
      await session.set({ unlock: b64u(crypto.getRandomValues(new Uint8Array(64))) });
      client = null;
      booted = null;
      await boot();
      return { unlocked: !!(client as VaultClient | null)?.unlocked };
    case "kept": {
      const kept = await store.getMeta<{ ct?: string; unlock?: string }>(KEPT_UNLOCK);
      return { kept: !!kept, sealed: !!kept?.ct && !kept.unlock };
    }
    case "sleepGap":
      await session.set({ beat: Date.now() - (m.ms as number) });
      await noticeSleep();
      return { unlocked: !!client?.unlocked };
    case "reports":
      return { report: frameReports.get(`${m.tabId}:${(m.frameId as number) ?? 0}`) ?? null, count: testLog.reportCount[m.tabId as number] ?? 0 };
    case "log":
      return testLog;
    case "noClipRead":
      clipboardTest.pretendNoRead(!!m.on);
      return { ok: true };
    case "clipDue":
      await clearClipboardIfOurs();
      return { ok: true };
    case "clipWrite":
      return { ok: await writeClipboard(m.text as string) };
    case "loadPack":
      packRules = await loadPack(fromB64u(m.pack as string), m.signature as string);
      return { rules: packRules.length };
    case "resetPack":
      await store.setMeta("rules_pack_version", 0);
      packRules = null;
      return { rules: (await shippedPack()).length };
    case "items":
      return client!.allItems().map((i) => ({ id: i.id, title: i.body.title, username: i.body.username, password: i.body.password, pendingPassword: i.body.pendingPassword, tags: i.body.tags ?? [], urls: i.body.urls ?? [], match: i.body.match, history: i.body.passwordHistory?.length ?? 0 }));
    case "patchItem": {
      const it = client!.get(m.id as string);
      if (!it) throw new Error("No such item");
      await client!.update(it.id, { ...it.body, ...(m.patch as Partial<ItemBody>) });
      return { ok: true };
    }
    case "settings":
      return vaultSettings();
    case "flags":
      Object.assign(testFlags, m.flags);
      return testFlags;
    case "pending":
      return ((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? [];
    case "handoff":
      return { ...(await handoffFor(m.tabId as number)), pageOpenedAt };
    case "pageOpened":
      // Start or end the panel's careful time, so tests don't hang on the clock.
      pageOpenedAt = m.on ? Date.now() : 0;
      return { ok: true };
    case "addCard":
      await client!.saveNew(await client!.personalVaultId(), newBody("card", m.title as string, { cardNumber: m.cardNumber as string, cardCvv: m.cardCvv as string }));
      return { ok: true };
    case "saveRule":
      await client!.saveNew(await client!.personalVaultId(), newBody("site_rule", "Taught", { rule: m.rule as SiteRule }));
      return { ok: true };
    case "seedItems": {
      const c = client!;
      const vault = await c.personalVaultId();
      for (let i = 0; i < (m.count as number); i++) {
        await c.saveNew(vault, newBody("login", `Seed ${i}`, { username: `seed${i}@example.com`, password: `Seed-Pass-${i}`, urls: [{ url: `https://seed${i}.example.com` }] }));
      }
      return { ok: true, total: c.allItems().length };
    }
    default:
      throw new Error(`No test op ${m.op}`);
  }
}

ext.runtime.onMessage.addListener((msg: { t: string }, sender, reply) => {
  if (sender.id !== ext.runtime.id) return false;
  const t = msg?.t ?? "";
  // Ours to send, not to answer: for extension pages and the offscreen page.
  if (t === "vaultChanged" || t === "locked" || t === "offscreenClip") return false;
  let p: Promise<unknown>;
  if (t.startsWith("pk")) {
    p = boot().then(() => handlePasskey(msg as never, sender, () => client, isThePerson, (tabId, url) => void updateBadge(tabId, url), { store, lockOut: lock }));
  } else if (t === "menuList" || t === "menuPick" || t === "menuPasskey" || t === "menuMailCode" || t === "menuMailLink" || t === "menuGenerate" || t === "menuClose" || t === "menuOpenPopup" || t === "menuHandoff" || t === "menuSize") {
    if (!isOurPage(sender, "/menu.html")) return false;
    p = handleMenu(msg as MenuRequest, sender);
  } else if (t === "saveOffer" || t === "saveAnswer" || t === "saveOpenPopup") {
    if (!isOurPage(sender, "/save.html")) return false;
    p = handleSave(msg as SaveRequest, sender);
  } else if (t === "pageReport" || t === "hello" || t === "captured" || t === "capturedUser" || t === "submitFailed" || t === "teachResult") {
    p = handleContent(msg as ContentRequest, sender);
  } else if (__TEST_BUILD__ && t === "test") {
    if (!isTrustedPage(sender)) return false;
    p = handleTest(msg as unknown as { op: string });
  } else if (t.startsWith("bs:")) {
    if (!isTrustedPage(sender)) return false;
    p = handleBrowserSync(msg as SyncRequest);
  } else {
    if (!isTrustedPage(sender)) return false; // A content script can't ask for any of this.
    p = handlePage(msg as PageRequest);
  }
  p.then(
    (r) => reply({ ok: true, r }),
    (e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e), status: e instanceof ApiError ? e.status : undefined, offline: e instanceof OfflineError }),
  );
  return true;
});

ext.commands.onCommand.addListener(async (command, tab) => {
  await boot();
  const tabId = tab?.id ?? (await ext.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId === undefined) return;
  if (command === "open-menu") await send(tabId, 0, { t: "openMenu" });
  if (command === "fill-last") {
    const t = await ext.tabs.get(tabId);
    const best = (await orderedCandidates(tabId, t.url ?? ""))[0];
    if (best) await fill(tabId, best.id, {});
  }
  if (command === "generate" && client?.unlocked) {
    const t = await ext.tabs.get(tabId);
    await generateInto(tabId, 0, t.url ?? "");
  }
});

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  await boot();
  if (!tab?.id) return;
  if (info.menuItemId === "fill") {
    const best = (await orderedCandidates(tab.id, tab.url ?? ""))[0];
    if (best) await fill(tab.id, best.id, {});
    else await send(tab.id, info.frameId ?? 0, { t: "openMenu" });
  }
  if (info.menuItemId === "generate" && client?.unlocked) {
    await generateInto(tab.id, info.frameId ?? 0, info.frameUrl ?? tab.url ?? "");
  }
});

export const _types = { userId } as const;
