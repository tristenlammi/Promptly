// Open tabs on other devices, and sending a tab to one (passwords/SYNC.md).
//
// This browser's tabs are published a few seconds after they change, not on every event, and a
// tab switch alone doesn't count as a change. Private windows and anything that isn't a web page
// stay out (core collectTabs). A tab sent here opens in the background, or shows a notification
// that names only the device it came from.
import { type BrowserWindowLike, collectTabs, type DeviceTabs, isWebUrl, REFRESH_MS, tabsFingerprint } from "../../../frontend/src/passwords/core/browsersync";
import { hex, utf8 } from "../../../frontend/src/passwords/core/bytes";
import { sha256 } from "../../../frontend/src/passwords/core/primitives";
import { devices, hasPermission, ownDeviceId, sendTargets, settings, type SyncSettings, syncClient } from "./browsersync";
import { ext } from "./rpc";

declare const __ENGINE__: string;

type Client = NonNullable<Awaited<ReturnType<typeof syncClient>>>;

const session = ext.storage.session;
const PUBLISH_DELAY_MS = 5000;
const PUBLISH_MAX_WAIT_MS = 30_000;

/** What this browser calls itself in its own list. Other devices show the device's name from
 *  the server first, since that's the one on the Devices screen. */
export function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Vivaldi/.test(ua) ? "Vivaldi" : /OPR\//.test(ua) ? "Opera" : "Chrome";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function deviceLabel(serverName: string | undefined, d: Pick<DeviceTabs, "name">): string {
  return serverName ?? (d.name || "Another browser");
}

// ---- Publishing this browser's tabs -----------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let firstChange = 0;

/** A change happened: publish in a few seconds, or at most half a minute after the first one. */
export function tabsChanged(): void {
  const now = Date.now();
  if (!timer) firstChange = now;
  clearTimeout(timer);
  const wait = Math.min(PUBLISH_DELAY_MS, Math.max(0, firstChange + PUBLISH_MAX_WAIT_MS - now));
  timer = setTimeout(() => {
    timer = undefined;
    void (async () => {
      const c = await syncClient();
      if (c && (await settings()).tabs) await publishTabs(c, false).catch(() => undefined);
    })();
  }, wait);
}

const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
  if (info.url !== undefined || info.title !== undefined || info.pinned !== undefined || info.status === "complete") tabsChanged();
};
const onAny = () => tabsChanged();
let listening = false;

export function listenToTabs(on: boolean): void {
  const t = ext.tabs;
  const w = ext.windows;
  if (on === listening || !t) return;
  listening = on;
  const events = [t.onCreated, t.onRemoved, t.onMoved, t.onAttached, t.onDetached, t.onReplaced, w?.onRemoved, w?.onCreated] as chrome.events.Event<() => void>[];
  for (const e of events) {
    if (!e) continue;
    if (on) e.addListener(onAny);
    else e.removeListener(onAny);
  }
  if (on) t.onUpdated.addListener(onUpdated);
  else t.onUpdated.removeListener(onUpdated);
}

/** The last published state, as a hash: the tabs themselves don't need keeping. */
async function fingerprintHash(fp: string): Promise<string> {
  return hex(await sha256(utf8(fp)));
}

export async function publishTabs(c: Client, force: boolean): Promise<void> {
  if (!(await hasPermission("tabs"))) throw new Error("The browser isn't allowing access to tabs. Turn this off and on again.");
  const me = await ownDeviceId();
  if (!me) throw new Error("This browser isn't connected.");
  const wins = (await ext.windows.getAll({ populate: true, windowTypes: ["normal"] })) as unknown as BrowserWindowLike[];
  const now = Date.now();
  const p = collectTabs(wins, { name: browserName(), browser: __ENGINE__, now });
  const last = ((await session.get("bsTabs")).bsTabs as { fingerprint: string; at: number } | undefined) ?? null;
  const fp = await fingerprintHash(tabsFingerprint(p));
  // Same as core shouldPublish, on a hash: a tab switch alone waits for the next refresh.
  if (!force && last && last.fingerprint === fp && now - last.at < REFRESH_MS) return;
  await c.sync.publishTabs(me, p);
  await session.set({ bsTabs: { fingerprint: fp, at: now } });
}

export async function stopSharingTabs(c: Client): Promise<void> {
  await c.sync.stopTabs();
  await session.remove("bsTabs");
}

// ---- Sending, and what arrives here -----------------------------------------------------

async function ownName(c: Client): Promise<string> {
  const me = await ownDeviceId();
  const list = await devices(c.vault).catch(() => []);
  return list.find((d) => d.id === me)?.name ?? browserName();
}

export async function sendTab(c: Client, target: string, url: string, title: string): Promise<{ ok: true }> {
  if (!isWebUrl(url)) throw new Error("Only web pages can be sent.");
  await c.sync.send(target, { url, title, from: await ownName(c), at: Date.now() });
  return { ok: true };
}

type Handled = string[];

/** Each sent tab is shown once: remembered before it's acknowledged, so a failed acknowledgement
 *  can't show it twice. */
export async function inboxPass(c: Client, s: SyncSettings): Promise<void> {
  if (!(await ownDeviceId())) return;
  const { items } = await c.sync.inbox();
  if (!items.length) return;
  const handled = new Set(((await session.get("bsHandled")).bsHandled as Handled | undefined) ?? []);
  for (const i of items.sort((a, b) => a.value.at - b.value.at)) {
    if (!handled.has(i.id)) {
      await deliver(i.id, i.value.url, i.value.from, s);
      handled.add(i.id);
      await session.set({ bsHandled: [...handled].slice(-500) });
    }
    await c.sync.ackSent(i.id);
  }
}

async function deliver(id: string, url: string, from: string, s: SyncSettings): Promise<void> {
  if (!isWebUrl(url)) return;
  if (s.notify && ext.notifications && (await hasPermission("notifications"))) {
    // Only the device's name: a notification can end up on a lock screen or in a log.
    await session.set({ [`bsNote:${id}`]: url });
    await ext.notifications.create(`bs-sent:${id}`, {
      type: "basic",
      iconUrl: ext.runtime.getURL("icons/128.png"),
      title: "A tab was sent to this browser",
      message: `From ${from || "another device"}. Click to open it.`,
    });
    return;
  }
  await ext.tabs.create({ url, active: false });
}

let notificationsHeard = false;

export function listenToNotifications(): void {
  if (notificationsHeard || !ext.notifications?.onClicked) return;
  notificationsHeard = true;
  ext.notifications.onClicked.addListener((nid) => {
    if (!nid.startsWith("bs-sent:")) return;
    const key = `bsNote:${nid.slice("bs-sent:".length)}`;
    void session.get(key).then(async (r) => {
      const url = r[key];
      if (isWebUrl(url)) await ext.tabs.create({ url });
      await session.remove(key);
      ext.notifications.clear(nid);
    });
  });
}

// ---- The page's right-click menu --------------------------------------------------------

// Firefox also has "tab", for a right-click on the tab strip. Chromium has no such context.
const CONTEXTS = (__ENGINE__ === "firefox" ? ["page", "link", "tab"] : ["page", "link"]) as unknown as [chrome.contextMenus.ContextType, ...chrome.contextMenus.ContextType[]];
const quiet = () => void ext.runtime.lastError;

/** Called where the extension makes its menus, after they're all cleared. */
export function addSyncMenus(): void {
  ext.contextMenus.create({ id: "bs-save", title: "Save for later", contexts: CONTEXTS }, quiet);
  ext.contextMenus.create({ id: "bs-send", title: "Send to your device", contexts: CONTEXTS }, quiet);
  ext.contextMenus.create({ id: "bs-send-none", parentId: "bs-send", title: "Unlock Passwords to see your devices", enabled: false, contexts: CONTEXTS }, quiet);
  void session.remove("bsMenu");
}

/** One entry per device that can be sent a tab, rebuilt only when that list changes. */
export async function refreshSendMenu(c: Client): Promise<void> {
  const targets = sendTargets(await devices(c.vault), await ownDeviceId());
  const key = JSON.stringify(targets.map((t) => [t.id, t.name]));
  const had = (await session.get("bsMenu")).bsMenu as { key: string; ids: string[] } | undefined;
  if (had?.key === key) return;
  for (const id of had?.ids ?? ["bs-send-none"]) ext.contextMenus.remove(id, quiet);
  const ids: string[] = [];
  if (!targets.length) {
    ext.contextMenus.create({ id: "bs-send-none", parentId: "bs-send", title: "No other devices yet", enabled: false, contexts: CONTEXTS }, quiet);
    ids.push("bs-send-none");
  }
  for (const t of targets) {
    const id = `bs-send:${t.id}`;
    ext.contextMenus.create({ id, parentId: "bs-send", title: t.platform === "android" ? `${t.name} (phone)` : t.name, contexts: CONTEXTS }, quiet);
    ids.push(id);
  }
  await session.set({ bsMenu: { key, ids } });
}

type Queued = { kind: "save" | "send"; url: string; title: string; target?: string };

/** Asked for while locked: there are no keys to encrypt with, so it waits for the next unlock,
 *  in memory only. */
async function queue(q: Queued): Promise<void> {
  const list = (((await session.get("bsQueue")).bsQueue as Queued[] | undefined) ?? []).slice(-20);
  await session.set({ bsQueue: [...list, q] });
}

export async function runQueued(c: Client): Promise<void> {
  const list = ((await session.get("bsQueue")).bsQueue as Queued[] | undefined) ?? [];
  if (!list.length) return;
  await session.remove("bsQueue");
  for (const q of list) {
    if (q.kind === "save") await c.sync.saveForLater(q.url, q.title);
    else if (q.target) await sendTab(c, q.target, q.url, q.title);
  }
}

ext.contextMenus?.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!id.startsWith("bs-")) return;
  const url = info.linkUrl ?? info.pageUrl ?? tab?.url ?? "";
  const title = info.linkUrl ? ((info as { linkText?: string }).linkText ?? info.selectionText ?? info.linkUrl) : (tab?.title ?? url);
  if (!isWebUrl(url)) return;
  const q: Queued | null = id === "bs-save" ? { kind: "save", url, title } : id.startsWith("bs-send:") ? { kind: "send", url, title, target: id.slice("bs-send:".length) } : null;
  if (!q) return;
  void (async () => {
    const c = await syncClient();
    if (!c) return queue(q);
    if (q.kind === "save") await c.sync.saveForLater(q.url, q.title);
    else await sendTab(c, q.target!, q.url, q.title);
  })().catch(() => undefined);
});
