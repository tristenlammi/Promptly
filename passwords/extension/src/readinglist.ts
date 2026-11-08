// The reading list. Ours is the one that syncs, in every browser. On Chromium, when asked, the
// browser's own reading list (chrome.readingList, Chrome 120+) is kept the same as ours. Firefox
// has no such API, so there ours is the only list. See passwords/SYNC.md.
import { type BrowserReadingEntry, planMirror } from "../../../frontend/src/passwords/core/browsersync";
import { hex, randomBytes, utf8 } from "../../../frontend/src/passwords/core/bytes";
import { sha256 } from "../../../frontend/src/passwords/core/primitives";
import { hasPermission, settings, type SyncSettings, syncClient, syncHost } from "./browsersync";
import { ext } from "./rpc";

declare const __ENGINE__: string;

type Client = NonNullable<Awaited<ReturnType<typeof syncClient>>>;

type ReadingListApi = {
  query: (info: object) => Promise<{ url: string; title: string; hasBeenRead: boolean; lastUpdateTime?: number; creationTime?: number }[]>;
  addEntry: (e: { url: string; title: string; hasBeenRead: boolean }) => Promise<void>;
  updateEntry: (e: { url: string; hasBeenRead?: boolean; title?: string }) => Promise<void>;
  removeEntry: (e: { url: string }) => Promise<void>;
  onEntryAdded?: chrome.events.Event<() => void>;
  onEntryRemoved?: chrome.events.Event<() => void>;
  onEntryUpdated?: chrome.events.Event<() => void>;
};

const api = (): ReadingListApi | undefined => (__ENGINE__ === "firefox" ? undefined : (ext as unknown as { readingList?: ReadingListApi }).readingList);

/** What both lists had last time, as salted hashes, so the record of it holds no addresses. */
const BASE = "reading_base";

async function hashOf(salt: string, url: string): Promise<string> {
  return hex(await sha256(utf8(`${salt}\n${url}`))).slice(0, 32);
}

let running: Promise<void> | null = null;

export function mirrorReadingList(c: Client, s: SyncSettings): Promise<void> {
  running ??= mirror(c, s).finally(() => {
    running = null;
  });
  return running;
}

async function mirror(c: Client, s: SyncSettings): Promise<void> {
  if (!s.mirrorReading) return;
  const rl = api();
  if (!rl || !(await hasPermission("readingList"))) throw new Error("The browser isn't allowing access to its reading list. Turn this off and on again.");
  const store = syncHost().store;
  const saved = (await store.getMeta<{ salt: string; hashes: string[] }>(BASE)) ?? { salt: hex(randomBytes(16)), hashes: [] };
  const ours = (await c.sync.readingList()).entries;
  const theirs = (await rl.query({})) as BrowserReadingEntry[];
  const known = new Set(saved.hashes);
  const base: string[] = [];
  for (const url of new Set([...ours.map((e) => e.url), ...theirs.map((e) => e.url)])) if (known.has(await hashOf(saved.salt, url))) base.push(url);
  const plan = planMirror(ours, theirs, base);
  const now = Date.now();
  for (const a of plan.browserAdd) await rl.addEntry(a).catch(() => undefined);
  for (const u of plan.browserUpdate) await rl.updateEntry(u).catch(() => undefined);
  for (const url of plan.browserRemove) await rl.removeEntry({ url }).catch(() => undefined);
  for (const a of plan.oursAdd) await c.sync.putReading({ id: crypto.randomUUID(), url: a.url, title: a.title, added: a.added, read: a.read, updated: now });
  for (const u of plan.oursUpdate) await c.sync.markRead(u.id, u.read, now);
  for (const id of plan.oursRemove) await c.sync.deleteReading(id);
  await store.setMeta(BASE, { salt: saved.salt, hashes: await Promise.all(plan.base.map((u) => hashOf(saved.salt, u))) });
}

let timer: ReturnType<typeof setTimeout> | undefined;
const changed = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    void (async () => {
      const c = await syncClient();
      if (c) await mirrorReadingList(c, await settings()).catch(() => undefined);
    })();
  }, 3000);
};
let listening = false;

export function listenToReadingList(on: boolean): void {
  const rl = api();
  if (!rl || on === listening) return;
  listening = on;
  for (const e of [rl.onEntryAdded, rl.onEntryRemoved, rl.onEntryUpdated]) {
    if (!e) continue;
    if (on) e.addListener(changed);
    else e.removeListener(changed);
  }
}
