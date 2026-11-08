// Browser sync: open tabs on other devices, sending a tab, history and the reading list.
// See passwords/SYNC.md and CRYPTO_SPEC.md section 13. No browser APIs in here: the
// extension's side is passwords/extension/src/tabsync.ts and friends.
//
// Every record is sealed with a key derived from the personal vault's key, and bound to
// its kind, device and slot, so the server can neither read one nor move it elsewhere.
import { ApiError, type VaultApi } from "./api";
import { b64u, fromB64u, fromUtf8, utf8 } from "./bytes";
import { aad, open, pad, seal, unpad } from "./format";
import { aesKey, hkdf } from "./primitives";

export type SyncKind = "tabs" | "history" | "reading" | "sent";
export type SyncKey = { key: CryptoKey; scope: string };

export const SYNC_INFO = "promptly-pw/v1/browser-sync";
const SYNC_FIELD = "browser-sync";

/** Padded payloads must fit the server's limits: the bucket is the next power of two. */
export const MAX_TABS_PAYLOAD = 512 * 1024 - 4;
export const MAX_HISTORY_PAYLOAD = 512 * 1024 - 4;
export const MAX_READING_PAYLOAD = 16 * 1024 - 4;
export const MAX_SENT_PAYLOAD = 16 * 1024 - 4;
export const MAX_TITLE = 512;
export const MAX_URL = 4096;
export const MAX_TABS = 500;
export const HISTORY_DAYS_DEFAULT = 90;
/** A device whose list is older than this is shown as out of date. */
export const STALE_MS = 24 * 60 * 60 * 1000;

/** The key: HKDF of the personal vault's raw key, salted with that vault's id. */
export async function deriveSyncKey(personalVaultKey: Uint8Array, personalVaultId: string): Promise<SyncKey> {
  const raw = await hkdf(personalVaultKey, utf8(personalVaultId), SYNC_INFO);
  try {
    return { key: await aesKey(raw), scope: personalVaultId };
  } finally {
    raw.fill(0);
  }
}

export function recordAad(scope: string, kind: SyncKind, device: string | null, slot: string): Uint8Array {
  return aad(scope, `${kind}:${device ?? ""}:${slot}`, SYNC_FIELD);
}

export async function sealRecord(k: SyncKey, kind: SyncKind, device: string | null, slot: string, value: unknown): Promise<string> {
  return b64u(await seal(k.key, pad(utf8(JSON.stringify(value))), recordAad(k.scope, kind, device, slot)));
}

export async function openRecord<T>(k: SyncKey, kind: SyncKind, device: string | null, slot: string, blob: string): Promise<T> {
  return JSON.parse(fromUtf8(unpad(await open(k.key, fromB64u(blob), recordAad(k.scope, kind, device, slot))))) as T;
}

// ---- Shapes -----------------------------------------------------------------------------

export type SyncedTab = { title: string; url: string; lastUsed: number; pinned?: boolean; active?: boolean };
export type SyncedWindow = { focused?: boolean; tabs: SyncedTab[] };
export type TabsPayload = { v: 1; name: string; browser: string; at: number; windows: SyncedWindow[]; left?: number };
export type SentPayload = { v: 1; url: string; title: string; from: string; at: number };
/** One row per address per day, at its latest visit. Re-reading the same visits changes nothing. */
export type HistoryVisit = { url: string; title: string; at: number };
export type HistoryPayload = { v: 1; day: string; visits: HistoryVisit[] };
export type ReadingEntry = { v: 1; id: string; url: string; title: string; added: number; read: boolean; updated: number };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Only http and https, of a sane length. Never `javascript:`, `file:`, `data:` or a browser's own pages. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > MAX_URL) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** It's this person's own data, but a blob's shape is still checked before it's used. */
export function cleanTabs(p: unknown): TabsPayload | null {
  const o = p as Partial<TabsPayload> | null;
  if (!o || o.v !== 1 || !Array.isArray(o.windows)) return null;
  const windows = o.windows
    .map((w) => ({
      focused: !!w?.focused,
      tabs: (Array.isArray(w?.tabs) ? w.tabs : []).filter((t) => isWebUrl(t?.url)).map((t) => ({ title: str(t.title, MAX_TITLE), url: t.url, lastUsed: num(t.lastUsed), pinned: !!t.pinned, active: !!t.active })),
    }))
    .filter((w) => w.tabs.length);
  return { v: 1, name: str(o.name, 120), browser: str(o.browser, 40), at: num(o.at), windows, left: num(o.left) || undefined };
}

export function cleanSent(p: unknown): SentPayload | null {
  const o = p as Partial<SentPayload> | null;
  if (!o || o.v !== 1 || !isWebUrl(o.url)) return null;
  return { v: 1, url: o.url, title: str(o.title, MAX_TITLE), from: str(o.from, 120), at: num(o.at) };
}

export function cleanHistory(p: unknown): HistoryPayload | null {
  const o = p as Partial<HistoryPayload> | null;
  if (!o || o.v !== 1 || !Array.isArray(o.visits)) return null;
  return { v: 1, day: str(o.day, 10), visits: o.visits.filter((x) => isWebUrl(x?.url)).map((x) => ({ url: x.url, title: str(x.title, MAX_TITLE), at: num(x.at) })) };
}

export function cleanReading(p: unknown, id: string): ReadingEntry | null {
  const o = p as Partial<ReadingEntry> | null;
  // An entry is bound to its id by the AAD as well, so a mismatch is damage, not a move.
  if (!o || o.v !== 1 || o.id !== id || !isWebUrl(o.url)) return null;
  return { v: 1, id, url: o.url, title: str(o.title, MAX_TITLE), added: num(o.added), read: !!o.read, updated: num(o.updated) };
}

// ---- Open tabs --------------------------------------------------------------------------

/** What a browser hands over: `chrome.windows.getAll({ populate: true })`, near enough. */
export type BrowserWindowLike = {
  incognito?: boolean;
  focused?: boolean;
  type?: string;
  tabs?: { url?: string; title?: string; lastAccessed?: number; pinned?: boolean; active?: boolean; incognito?: boolean }[];
};

/** Private windows, popups and app windows, and anything that isn't a web page, stay out.
 *  Most recently used first, and no more than fits. */
export function collectTabs(windows: BrowserWindowLike[], o: { name: string; browser: string; now: number; maxTabs?: number; maxBytes?: number }): TabsPayload {
  const max = o.maxTabs ?? MAX_TABS;
  let out: SyncedWindow[] = [];
  for (const w of windows) {
    if (w.incognito || (w.type && w.type !== "normal")) continue;
    const tabs = (w.tabs ?? [])
      .filter((t) => !t.incognito && isWebUrl(t.url))
      .map((t) => ({ title: (t.title ?? "").slice(0, MAX_TITLE), url: t.url!, lastUsed: Math.round(t.lastAccessed ?? 0), pinned: !!t.pinned || undefined, active: !!t.active || undefined }));
    if (tabs.length) out.push({ focused: !!w.focused || undefined, tabs });
  }
  const all = out.flatMap((w) => w.tabs).sort((a, b) => b.lastUsed - a.lastUsed);
  const total = all.length;
  let keep = new Set(all.slice(0, max));
  const build = (): TabsPayload => {
    const windows = out.map((w) => ({ ...w, tabs: w.tabs.filter((t) => keep.has(t)) })).filter((w) => w.tabs.length);
    const n = windows.reduce((s, w) => s + w.tabs.length, 0);
    return { v: 1, name: o.name, browser: o.browser, at: o.now, windows, ...(n < total ? { left: total - n } : {}) };
  };
  let p = build();
  // Very long titles and addresses can still push past the limit: drop the least recently used.
  const limit = o.maxBytes ?? MAX_TABS_PAYLOAD;
  while (utf8(JSON.stringify(p)).length > limit && keep.size) {
    keep = new Set([...keep].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, Math.max(0, Math.floor(keep.size * 0.8))));
    p = build();
  }
  out = [];
  return p;
}

/** What changed enough to publish again. Switching tabs moves `lastUsed`, which alone isn't
 *  worth a write: it goes with the next real change, or the next refresh. */
export function tabsFingerprint(p: TabsPayload): string {
  return JSON.stringify(p.windows.map((w) => w.tabs.map((t) => [t.url, t.title, !!t.pinned])));
}

export const REFRESH_MS = 10 * 60 * 1000;

export function shouldPublish(p: TabsPayload, last: { fingerprint: string; at: number } | null, now: number): boolean {
  if (!last) return true;
  return last.fingerprint !== tabsFingerprint(p) || now - last.at >= REFRESH_MS;
}

export type DeviceTabs = { device: string; name: string; browser: string; at: number; windows: SyncedWindow[]; left?: number };

export function freshness(at: number, now: number): { text: string; stale: boolean } {
  const ms = Math.max(0, now - at);
  const min = Math.floor(ms / 60000);
  const text = min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 60 * 48 ? `${Math.floor(min / 60)} h ago` : `${Math.floor(min / 1440)} days ago`;
  return { text, stale: ms > STALE_MS };
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (ws: string[], ...fields: string[]) => {
  const hay = fields.join(" ").toLowerCase();
  return ws.every((w) => hay.includes(w));
};

/** Search every device's tabs, keeping which device each came from. */
export function searchTabs(devices: DeviceTabs[], q: string, limit = 200): { device: DeviceTabs; tab: SyncedTab }[] {
  const ws = words(q);
  const out: { device: DeviceTabs; tab: SyncedTab }[] = [];
  for (const d of devices) for (const w of d.windows) for (const t of w.tabs) if (matches(ws, t.title, t.url)) out.push({ device: d, tab: t });
  return out.sort((a, b) => b.tab.lastUsed - a.tab.lastUsed).slice(0, limit);
}

// ---- History ----------------------------------------------------------------------------

/** The local calendar day, which is what a person means by "yesterday". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The oldest day kept, matching the server's rule: today and the `days - 1` before it. */
export function oldestDay(now: number, days: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - (days - 1));
  return dayKey(d.getTime());
}

/** "example.com", "https://www.example.com/path" and "*.example.com" all mean the site and its subdomains. */
export function normaliseExclude(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0].split("@").pop()!.replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(s) && s.includes(".") ? s : /^[a-z0-9-]+$/.test(s) && s === "localhost" ? s : null;
}

export function isExcluded(url: string, excludes: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  return excludes.some((e) => host === e || host.endsWith(`.${e}`));
}

/** Merge visits into a day's bucket: the latest visit per address, newest first, trimmed to fit. */
export function mergeVisits(existing: HistoryVisit[], incoming: HistoryVisit[], maxBytes = MAX_HISTORY_PAYLOAD): HistoryVisit[] {
  const by = new Map<string, HistoryVisit>();
  for (const v of [...existing, ...incoming]) {
    if (!isWebUrl(v.url)) continue;
    const had = by.get(v.url);
    if (!had || v.at > had.at || (v.at === had.at && v.title && !had.title)) by.set(v.url, { url: v.url, title: (v.title || had?.title || "").slice(0, MAX_TITLE), at: v.at });
  }
  let list = [...by.values()].sort((a, b) => b.at - a.at);
  // A huge day keeps its latest visits.
  while (list.length && utf8(JSON.stringify({ v: 1, day: "0000-00-00", visits: list })).length > maxBytes) list = list.slice(0, Math.floor(list.length * 0.9));
  return list;
}

/** Group new visits into days, leaving out excluded sites, non-web addresses and days past what's kept. */
export function bucketVisits(visits: HistoryVisit[], o: { excludes: string[]; days: number; now: number }): Map<string, HistoryVisit[]> {
  const floor = oldestDay(o.now, o.days);
  const out = new Map<string, HistoryVisit[]>();
  for (const v of visits) {
    if (!isWebUrl(v.url) || isExcluded(v.url, o.excludes) || v.at > o.now + 60_000) continue;
    const day = dayKey(v.at);
    if (day < floor) continue;
    const l = out.get(day) ?? [];
    l.push({ url: v.url, title: (v.title ?? "").slice(0, MAX_TITLE), at: v.at });
    out.set(day, l);
  }
  return out;
}

export type HistoryRow = HistoryVisit & { device: string };

export function searchHistory(rows: HistoryRow[], q: string, limit = 200): HistoryRow[] {
  const ws = words(q);
  return rows.filter((r) => matches(ws, r.title, r.url)).sort((a, b) => b.at - a.at).slice(0, limit);
}

// ---- Reading list -----------------------------------------------------------------------

/** One entry from a browser's own reading list (Chromium's `chrome.readingList`). */
export type BrowserReadingEntry = { url: string; title: string; hasBeenRead: boolean; lastUpdateTime?: number; creationTime?: number };

export type MirrorPlan = {
  /** Into the browser's list. */
  browserAdd: { url: string; title: string; hasBeenRead: boolean }[];
  browserUpdate: { url: string; hasBeenRead: boolean }[];
  browserRemove: string[];
  /** Into ours. */
  oursAdd: { url: string; title: string; read: boolean; added: number }[];
  oursUpdate: { id: string; read: boolean }[];
  oursRemove: string[];
  /** Addresses in both after this run: the next run's "before". */
  base: string[];
};

/** Keeps a browser's own reading list and ours the same, comparing both with what they had in
 *  common last time (`base`), so a removal on either side is told apart from an addition. A
 *  read mark goes whichever way changed last. Nothing's removed on a first run. */
export function planMirror(ours: ReadingEntry[], browser: BrowserReadingEntry[], base: string[]): MirrorPlan {
  const plan: MirrorPlan = { browserAdd: [], browserUpdate: [], browserRemove: [], oursAdd: [], oursUpdate: [], oursRemove: [], base: [] };
  const was = new Set(base);
  const inBrowser = new Map(browser.filter((b) => isWebUrl(b.url)).map((b) => [b.url, b]));
  const inOurs = new Map<string, ReadingEntry>();
  for (const e of ours) if (!inOurs.has(e.url)) inOurs.set(e.url, e);
  for (const [url, e] of inOurs) {
    const b = inBrowser.get(url);
    if (!b) {
      if (was.has(url)) plan.oursRemove.push(e.id);
      else plan.browserAdd.push({ url, title: e.title, hasBeenRead: e.read });
      continue;
    }
    if (b.hasBeenRead !== e.read) {
      if ((b.lastUpdateTime ?? 0) > e.updated) plan.oursUpdate.push({ id: e.id, read: b.hasBeenRead });
      else plan.browserUpdate.push({ url, hasBeenRead: e.read });
    }
  }
  for (const [url, b] of inBrowser) {
    if (inOurs.has(url)) continue;
    if (was.has(url)) plan.browserRemove.push(url);
    else plan.oursAdd.push({ url, title: b.title.slice(0, MAX_TITLE), read: b.hasBeenRead, added: b.creationTime ?? Date.now() });
  }
  const removedHere = new Set(plan.oursRemove);
  const removedThere = new Set(plan.browserRemove);
  for (const e of inOurs.values()) if (!removedHere.has(e.id)) plan.base.push(e.url);
  for (const a of plan.oursAdd) plan.base.push(a.url);
  plan.base = [...new Set(plan.base)].filter((u) => !removedThere.has(u));
  return plan;
}

// ---- Talking to the server --------------------------------------------------------------

type RecordOut = { id: string; device_id: string | null; slot: string; blob: string; size: number; updated_at: string };
type ListOut = { rev: number; ids: string[]; records: RecordOut[] };

export type Synced<T> = { id: string; device: string | null; slot: string; updatedAt: string; value: T };

/** Decrypted records of one kind, kept up to date with `since`. Memory only. */
class Cache<T> {
  rev = 0;
  items = new Map<string, Synced<T>>();
  failed = new Set<string>();
}

export class BrowserSyncClient {
  private caches = new Map<string, Cache<unknown>>();

  constructor(
    public api: VaultApi,
    private keyOf: () => Promise<SyncKey>,
  ) {}

  /** Everything of a kind. Records that don't open (another key, or tampered with) are left out
   *  and counted. History can be asked for from a day on, which the cache keys separately. */
  async list<T>(kind: SyncKind, clean: (v: unknown, id: string) => T | null, o: { fromDay?: string } = {}): Promise<{ items: Synced<T>[]; failed: number }> {
    const key = `${kind}:${o.fromDay ?? ""}`;
    const cache = (this.caches.get(key) ?? new Cache<T>()) as Cache<T>;
    this.caches.set(key, cache as Cache<unknown>);
    const q = new URLSearchParams({ since: String(cache.rev) });
    if (o.fromDay) q.set("from_day", o.fromDay);
    const r = await this.api.request<ListOut>("GET", `/browser-sync/${kind}?${q}`);
    const k = await this.keyOf();
    for (const rec of r.records) {
      try {
        const value = clean(await openRecord<unknown>(k, kind, rec.device_id, rec.slot, rec.blob), rec.slot);
        if (value === null) throw new Error("bad shape");
        cache.items.set(rec.id, { id: rec.id, device: rec.device_id, slot: rec.slot, updatedAt: rec.updated_at, value });
        cache.failed.delete(rec.id);
      } catch {
        cache.items.delete(rec.id);
        cache.failed.add(rec.id);
      }
    }
    const now = new Set(r.ids);
    for (const id of [...cache.items.keys()]) if (!now.has(id)) cache.items.delete(id);
    for (const id of [...cache.failed]) if (!now.has(id)) cache.failed.delete(id);
    cache.rev = r.rev;
    return { items: [...cache.items.values()], failed: cache.failed.size };
  }

  /** Forget what's been decrypted, as at a lock. */
  clear(): void {
    this.caches.clear();
  }

  async devicesTabs(): Promise<{ devices: DeviceTabs[]; failed: number }> {
    const r = await this.list("tabs", cleanTabs);
    return {
      devices: r.items.filter((i) => i.device).map((i) => ({ device: i.device!, name: i.value.name, browser: i.value.browser, at: i.value.at, windows: i.value.windows, left: i.value.left })),
      failed: r.failed,
    };
  }

  async publishTabs(device: string, p: TabsPayload): Promise<void> {
    await this.api.request("PUT", "/browser-sync/tabs", { blob: await sealRecord(await this.keyOf(), "tabs", device, "", p) });
  }

  stopTabs = () => this.api.request<void>("DELETE", "/browser-sync/tabs");

  async send(target: string, p: Omit<SentPayload, "v">, id = crypto.randomUUID()): Promise<string> {
    if (!isWebUrl(p.url)) throw new Error("Only web pages can be sent.");
    const body: SentPayload = { v: 1, url: p.url, title: p.title.slice(0, MAX_TITLE), from: p.from.slice(0, 120), at: p.at };
    await this.api.request("POST", "/browser-sync/sent", { id, target, blob: await sealRecord(await this.keyOf(), "sent", target, id, body) });
    return id;
  }

  inbox = () => this.list("sent", cleanSent);
  ackSent = (id: string) => this.api.request<void>("DELETE", `/browser-sync/sent/${id}`).catch((e) => (e instanceof ApiError && e.status === 404 ? undefined : Promise.reject(e)));

  async putHistory(device: string, day: string, visits: HistoryVisit[]): Promise<void> {
    const p: HistoryPayload = { v: 1, day, visits };
    await this.api.request("PUT", `/browser-sync/history/${day}`, { blob: await sealRecord(await this.keyOf(), "history", device, day, p) });
  }

  async history(fromDay?: string): Promise<{ rows: HistoryRow[]; failed: number }> {
    const r = await this.list("history", cleanHistory, { fromDay });
    return { rows: r.items.flatMap((i) => i.value.visits.map((v) => ({ ...v, device: i.device ?? "" }))), failed: r.failed };
  }

  /** Synced history only: what each browser keeps itself isn't touched. */
  async deleteHistory(thisDevice = false): Promise<void> {
    await this.api.request("DELETE", `/browser-sync/history${thisDevice ? "?this_device=true" : ""}`);
    for (const k of [...this.caches.keys()]) if (k.startsWith("history:")) this.caches.delete(k);
  }

  prefs = () => this.api.request<{ history_days: number }>("GET", "/browser-sync-prefs");
  setPrefs = (historyDays: number) => this.api.request<{ history_days: number }>("PUT", "/browser-sync-prefs", { history_days: historyDays });

  async readingList(): Promise<{ entries: ReadingEntry[]; failed: number }> {
    const r = await this.list("reading", cleanReading);
    return { entries: r.items.map((i) => i.value).sort((a, b) => b.added - a.added), failed: r.failed };
  }

  async putReading(e: Omit<ReadingEntry, "v">): Promise<ReadingEntry> {
    if (!isWebUrl(e.url)) throw new Error("Only web pages can be saved for later.");
    const entry: ReadingEntry = { v: 1, id: e.id, url: e.url, title: e.title.slice(0, MAX_TITLE), added: e.added, read: e.read, updated: e.updated };
    await this.api.request("PUT", `/browser-sync/reading/${e.id}`, { blob: await sealRecord(await this.keyOf(), "reading", null, e.id, entry) });
    return entry;
  }

  /** Save for later. The same address twice is one entry, marked unread again. */
  async saveForLater(url: string, title: string, now = Date.now()): Promise<ReadingEntry> {
    const { entries } = await this.readingList();
    const had = entries.find((e) => e.url === url);
    if (had) return this.putReading({ ...had, title: title || had.title, read: false, updated: now });
    return this.putReading({ id: crypto.randomUUID(), url, title, added: now, read: false, updated: now });
  }

  async markRead(id: string, read: boolean, now = Date.now()): Promise<void> {
    const { entries } = await this.readingList();
    const had = entries.find((e) => e.id === id);
    if (had) await this.putReading({ ...had, read, updated: now });
  }

  deleteReading = (id: string) => this.api.request<void>("DELETE", `/browser-sync/reading/${id}`).catch((e) => (e instanceof ApiError && e.status === 404 ? undefined : Promise.reject(e)));
}
