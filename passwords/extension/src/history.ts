// Synced history, off until turned on in each browser (passwords/SYNC.md).
//
// Only what's visited after it's turned on. Read from the browser's own history, which never holds private windows in either engine,
// then grouped by day: one row per address per day, at its latest visit, encrypted per day.
// Excluded sites never leave this browser, and adding one takes it out of what's synced.
// Clearing the browser's history clears what this browser synced.
import { bucketVisits, cleanHistory, type HistoryVisit, isExcluded, mergeVisits, oldestDay, searchHistory } from "../../../frontend/src/passwords/core/browsersync";
import { hasPermission, ownDeviceId, settings, type SyncSettings, syncClient, syncHost } from "./browsersync";
import { ext } from "./rpc";

type Client = NonNullable<Awaited<ReturnType<typeof syncClient>>>;

const CURSOR = "history_cursor";
/** When it was turned on: nothing visited before that is ever synced. */
export const SINCE = "history_since";
const EXCLUDES_DONE = "history_excludes_done";
/** Visits can be recorded a little after they happen. */
const OVERLAP_MS = 5 * 60_000;
const SHOWN_DAYS = 7;

let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let prefs: { at: number; days: number } | null = null;

export function historyChanged(): void {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    void (async () => {
      const c = await syncClient();
      const s = await settings();
      if (c && s.history) await historyPass(c, s).catch(() => undefined);
    })();
  }, 30_000);
}

const onVisited = () => historyChanged();
const onRemoved = (r: { allHistory: boolean; urls?: string[] }) => void removedInBrowser(r);
let listening = false;

export function listenToHistory(on: boolean): void {
  const h = ext.history;
  if (!h || on === listening) return;
  listening = on;
  if (on) {
    h.onVisited.addListener(onVisited);
    h.onVisitRemoved.addListener(onRemoved);
  } else {
    h.onVisited.removeListener(onVisited);
    h.onVisitRemoved.removeListener(onRemoved);
  }
}

async function keptDays(c: Client): Promise<number> {
  if (prefs && Date.now() - prefs.at < 10 * 60_000) return prefs.days;
  const r = await c.sync.prefs();
  prefs = { at: Date.now(), days: r.history_days };
  return r.history_days;
}

/** This browser's own buckets, by day. */
async function ownBuckets(c: Client, me: string): Promise<Map<string, HistoryVisit[]>> {
  const { items } = await c.sync.list("history", cleanHistory);
  return new Map(items.filter((i) => i.device === me).map((i) => [i.slot, i.value.visits]));
}

const same = (a: HistoryVisit[] | undefined, b: HistoryVisit[]) => !!a && a.length === b.length && a.every((v, i) => v.url === b[i].url && v.at === b[i].at && v.title === b[i].title);

export async function historyPass(c: Client, s: SyncSettings): Promise<void> {
  if (!ext.history || !(await hasPermission("history"))) throw new Error("The browser isn't allowing access to history. Turn this off and on again.");
  const me = await ownDeviceId();
  if (!me) throw new Error("This browser isn't connected.");
  const store = syncHost().store;
  const now = Date.now();
  const cursor = (await store.getMeta<number>(CURSOR)) ?? 0;
  const excludesKey = JSON.stringify([...s.excludes].sort());
  const excludesChanged = (await store.getMeta<string>(EXCLUDES_DONE)) !== excludesKey;
  if (!dirty && !excludesChanged && now - cursor < 15 * 60_000) return;
  const days = await keptDays(c);
  const floor = new Date(`${oldestDay(now, days)}T00:00:00`).getTime();
  const since = (await store.getMeta<number>(SINCE)) ?? now;
  const items = await ext.history.search({ text: "", startTime: Math.max(floor, since, cursor - OVERLAP_MS), maxResults: 10_000 });
  const visits = items.filter((i) => i.url && i.lastVisitTime && i.lastVisitTime >= since).map((i) => ({ url: i.url!, title: i.title ?? "", at: i.lastVisitTime! }));
  const buckets = bucketVisits(visits, { excludes: s.excludes, days, now });
  const own = await ownBuckets(c, me);
  // A newly excluded site comes out of what this browser already synced.
  if (excludesChanged) for (const day of own.keys()) if (!buckets.has(day)) buckets.set(day, []);
  for (const [day, fresh] of buckets) {
    const had = own.get(day);
    const merged = mergeVisits((had ?? []).filter((v) => !isExcluded(v.url, s.excludes)), fresh);
    if (same(had, merged) || (!had && !merged.length)) continue;
    await c.sync.putHistory(me, day, merged);
  }
  await store.setMeta(CURSOR, now);
  await store.setMeta(EXCLUDES_DONE, excludesKey);
  dirty = false;
}

/** Cleared in the browser: gone from what this browser synced too. */
async function removedInBrowser(r: { allHistory: boolean; urls?: string[] }): Promise<void> {
  const c = await syncClient();
  if (!c || !(await settings()).history) return;
  if (r.allHistory) return forgetOwnHistory(c);
  const me = await ownDeviceId();
  if (!me || !r.urls?.length) return;
  const gone = new Set(r.urls);
  for (const [day, visits] of await ownBuckets(c, me)) {
    const kept = visits.filter((v) => !gone.has(v.url));
    if (kept.length !== visits.length) await c.sync.putHistory(me, day, kept);
  }
}

/** This browser's synced history goes; only what's visited from now on is synced, if it's on. */
export async function forgetOwnHistory(c: Client): Promise<void> {
  await c.sync.deleteHistory(true);
  await syncHost().store.setMeta(CURSOR, Date.now());
  await syncHost().store.setMeta(SINCE, Date.now());
}

export async function searchSyncedHistory(c: Client, query: string, all: boolean, names: Map<string, string>) {
  const { rows, failed } = await c.sync.history(all ? undefined : oldestDay(Date.now(), SHOWN_DAYS));
  return { rows: searchHistory(rows, query, 200).map((r) => ({ ...r, deviceName: names.get(r.device) ?? "A removed device" })), failed };
}
