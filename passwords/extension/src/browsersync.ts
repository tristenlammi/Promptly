// The background's side of browser sync: open tabs, sending a tab, history and the reading
// list (passwords/SYNC.md). The logic and the encryption are in
// frontend/src/passwords/core/browsersync.ts; this is the browser's half, kept out of
// background.ts, which only calls initBrowserSync, browserSyncTick and handleBrowserSync.
import { BrowserSyncClient, type DeviceTabs, isWebUrl } from "../../../frontend/src/passwords/core/browsersync";
import type { DeviceOut } from "../../../frontend/src/passwords/core/api";
import type { IdbStore } from "../../../frontend/src/passwords/core/store";
import type { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { forgetOwnHistory, historyChanged, historyPass, listenToHistory, searchSyncedHistory, SINCE as HISTORY_SINCE } from "./history";
import { listenToReadingList, mirrorReadingList } from "./readinglist";
import { ext } from "./rpc";
import { addSyncMenus, deviceLabel, inboxPass, listenToNotifications, listenToTabs, publishTabs, refreshSendMenu, runQueued, sendTab, stopSharingTabs, tabsChanged } from "./tabsync";

declare const __ENGINE__: string;

export type SyncSettings = {
  /** Share this browser's open tabs with your other devices. Needs `tabs`. */
  tabs: boolean;
  /** A tab sent here shows a notification instead of opening at once. Needs `notifications`. */
  notify: boolean;
  /** Sync this browser's history. Off until turned on. Needs `history`. */
  history: boolean;
  /** Sites whose history never leaves this browser. */
  excludes: string[];
  /** Chromium: keep the browser's own reading list the same as ours. Needs `readingList`. */
  mirrorReading: boolean;
};

export const DEFAULT_SETTINGS: SyncSettings = { tabs: false, notify: false, history: false, excludes: [], mirrorReading: false };

export type SyncHost = { boot: () => Promise<void>; client: () => VaultClient | null; store: IdbStore };

let host: SyncHost | null = null;
const clients = new WeakMap<VaultClient, BrowserSyncClient>();

export function initBrowserSync(h: SyncHost): void {
  host = h;
  listenToNotifications();
  void settings().then(applyListeners).catch(() => undefined);
}

/** Only while a part is on, so a browser that doesn't use it isn't woken for every tab change
 *  or visit. Anything missed while asleep is caught by the next minute's tick. */
function applyListeners(s: SyncSettings): void {
  listenToTabs(s.tabs);
  listenToHistory(s.history);
  listenToReadingList(s.mirrorReading);
}

export function syncHost(): SyncHost {
  if (!host) throw new Error("Browser sync isn't set up");
  return host;
}

/** The unlocked vault's sync client, or null while locked: no keys, nothing to do. */
export async function syncClient(): Promise<{ vault: VaultClient; sync: BrowserSyncClient } | null> {
  const h = syncHost();
  await h.boot();
  const vault = h.client();
  if (!vault?.unlocked) return null;
  let sync = clients.get(vault);
  if (!sync) {
    sync = new BrowserSyncClient(vault.api, () => vault.browserSyncKey());
    clients.set(vault, sync);
  }
  return { vault, sync };
}

export async function settings(): Promise<SyncSettings> {
  const s = (await syncHost().store.getMeta<Partial<SyncSettings>>("browser_sync")) ?? {};
  return { ...DEFAULT_SETTINGS, ...s, excludes: Array.isArray(s.excludes) ? s.excludes.filter((x) => typeof x === "string") : [] };
}

/** This browser's own PwDevice id: the server binds its tabs and history to the token, and the
 *  encryption binds them to this id. */
export async function ownDeviceId(): Promise<string | null> {
  return (await syncHost().store.getMeta<string>("device_id")) ?? null;
}

export async function hasPermission(permission: string): Promise<boolean> {
  try {
    return await ext.permissions.contains({ permissions: [permission as chrome.runtime.ManifestPermission] });
  } catch {
    return false;
  }
}

type Status = { at?: number; error?: string };
const status: Record<string, Status> = {};
export function noteStatus(part: string, error?: string): void {
  status[part] = { at: Date.now(), error };
}

let devicesCache: { at: number; list: DeviceOut[] } | null = null;

/** Your devices that can be sent a tab: browsers with the extension, and phones. */
export async function devices(vault: VaultClient, fresh = false): Promise<DeviceOut[]> {
  if (!fresh && devicesCache && Date.now() - devicesCache.at < 5 * 60_000) return devicesCache.list;
  const list = (await vault.api.devices()).filter((d) => !d.revoked_at && d.scopes.includes("vault"));
  devicesCache = { at: Date.now(), list };
  return list;
}

export function sendTargets(list: DeviceOut[], me: string | null): DeviceOut[] {
  return list.filter((d) => d.id !== me && (d.platform === "chromium" || d.platform === "firefox" || d.platform === "android"));
}

let ticking: Promise<void> | null = null;

/** Every minute with the vault's sync, while unlocked. Each part fails on its own. */
export function browserSyncTick(): Promise<void> {
  ticking ??= (async () => {
    try {
      const c = await syncClient();
      if (!c) return;
      const s = await settings();
      const step = async (part: string, f: () => Promise<unknown>) => {
        try {
          await f();
          noteStatus(part);
        } catch (e) {
          noteStatus(part, e instanceof Error ? e.message : String(e));
        }
      };
      await step("queued", () => runQueued(c));
      await step("inbox", () => inboxPass(c, s));
      if (s.tabs) await step("tabs", () => publishTabs(c, false));
      if (s.history) await step("history", () => historyPass(c, s));
      await step("reading", () => mirrorReadingList(c, s));
      await step("menu", () => refreshSendMenu(c));
    } finally {
      ticking = null;
    }
  })();
  return ticking;
}

export { addSyncMenus, historyChanged, tabsChanged };

// ---- What the panel and the vault page may ask ----------------------------------------

export type SyncRequest =
  | { t: "bs:state" }
  | { t: "bs:set"; settings: Partial<SyncSettings> }
  | { t: "bs:syncNow" }
  | { t: "bs:tabs" }
  | { t: "bs:targets" }
  | { t: "bs:send"; target: string; url: string; title: string }
  | { t: "bs:open"; url: string }
  | { t: "bs:reading" }
  | { t: "bs:save"; url: string; title: string }
  | { t: "bs:readingSet"; id: string; read: boolean }
  | { t: "bs:readingDelete"; id: string }
  | { t: "bs:history"; query: string; all?: boolean }
  | { t: "bs:deleteHistory"; thisDevice: boolean }
  | { t: "bs:prefs" }
  | { t: "bs:setPrefs"; historyDays: number };

export type SyncStateOut = {
  settings: SyncSettings;
  granted: { tabs: boolean; history: boolean; notifications: boolean; readingList: boolean };
  hasReadingListApi: boolean;
  engine: string;
  status: Record<string, Status>;
  unlocked: boolean;
};

export async function handleBrowserSync(m: SyncRequest): Promise<unknown> {
  if (m.t === "bs:state") {
    const c = await syncClient();
    return {
      settings: await settings(),
      granted: { tabs: await hasPermission("tabs"), history: await hasPermission("history"), notifications: await hasPermission("notifications"), readingList: await hasPermission("readingList") },
      hasReadingListApi: __ENGINE__ !== "firefox",
      engine: __ENGINE__,
      status,
      unlocked: !!c,
    } satisfies SyncStateOut;
  }
  if (m.t === "bs:set") {
    const before = await settings();
    const next: SyncSettings = { ...before, ...m.settings };
    next.excludes = (m.settings.excludes ?? before.excludes).filter((x) => typeof x === "string").slice(0, 500);
    await syncHost().store.setMeta("browser_sync", next);
    const c = await syncClient();
    // Turning sharing off takes this browser's tabs off every other device too.
    if (before.tabs && !next.tabs && c) await stopSharingTabs(c).catch(() => undefined);
    if (!before.tabs && next.tabs) tabsChanged();
    if (before.history && !next.history) await syncHost().store.deleteMeta("history_cursor");
    if (!before.history && next.history) {
      // From now on only: turning it on doesn't upload what was visited before.
      await syncHost().store.setMeta(HISTORY_SINCE, Date.now());
      historyChanged();
    }
    // Off and on again is a fresh start that only adds, as for bookmarks.
    if (before.mirrorReading && !next.mirrorReading) await syncHost().store.deleteMeta("reading_base");
    applyListeners(next);
    void browserSyncTick();
    return next;
  }
  if (m.t === "bs:syncNow") {
    await browserSyncTick();
    return status;
  }
  const c = await syncClient();
  if (!c) throw new Error("Unlock to see this.");
  const me = await ownDeviceId();
  switch (m.t) {
    case "bs:tabs": {
      const [{ devices: list, failed }, known] = await Promise.all([c.sync.devicesTabs(), devices(c.vault).catch(() => [] as DeviceOut[])]);
      const names = new Map(known.map((d) => [d.id, d.name]));
      const others: (DeviceTabs & { label: string })[] = list.filter((d) => d.device !== me).map((d) => ({ ...d, label: deviceLabel(names.get(d.device), d) }));
      return { devices: others.sort((a, b) => b.at - a.at), failed };
    }
    case "bs:targets":
      return sendTargets(await devices(c.vault, true), me).map((d) => ({ id: d.id, name: d.name, platform: d.platform }));
    case "bs:send":
      return sendTab(c, m.target, m.url, m.title);
    case "bs:open":
      if (!isWebUrl(m.url)) return { ok: false };
      await ext.tabs.create({ url: m.url });
      return { ok: true };
    case "bs:reading":
      return c.sync.readingList();
    case "bs:save": {
      const e = await c.sync.saveForLater(m.url, m.title);
      void mirrorReadingList(c, await settings()).catch(() => undefined);
      return e;
    }
    case "bs:readingSet":
      await c.sync.markRead(m.id, m.read);
      void mirrorReadingList(c, await settings()).catch(() => undefined);
      return { ok: true };
    case "bs:readingDelete":
      await c.sync.deleteReading(m.id);
      void mirrorReadingList(c, await settings()).catch(() => undefined);
      return { ok: true };
    case "bs:history": {
      const known = await devices(c.vault).catch(() => [] as DeviceOut[]);
      return searchSyncedHistory(c, m.query, !!m.all, new Map(known.map((d) => [d.id, d.name])));
    }
    case "bs:deleteHistory":
      if (m.thisDevice) await forgetOwnHistory(c);
      else await c.sync.deleteHistory(false);
      return { ok: true };
    case "bs:prefs":
      return c.sync.prefs();
    case "bs:setPrefs": {
      const r = await c.sync.setPrefs(m.historyDays);
      c.sync.clear();
      return r;
    }
  }
}
