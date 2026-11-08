// Browser sync's logic and encryption, with a fake server that behaves like the real one where
// it matters: opaque blobs per device and slot, a revision counter, ids of what's there.
import { describe, expect, it } from "vitest";

import { VaultApi } from "./api";
import { fromB64u, randomBytes, utf8 } from "./bytes";
import {
  BrowserSyncClient,
  bucketVisits,
  cleanTabs,
  collectTabs,
  dayKey,
  deriveSyncKey,
  freshness,
  isExcluded,
  isWebUrl,
  MAX_TABS_PAYLOAD,
  mergeVisits,
  normaliseExclude,
  oldestDay,
  openRecord,
  planMirror,
  type ReadingEntry,
  REFRESH_MS,
  sealRecord,
  searchHistory,
  searchTabs,
  shouldPublish,
  tabsFingerprint,
} from "./browsersync";

const VAULT = "8d2f0c4e-6c47-4c1b-9a7c-3a1d2b3c4d5e";

describe("encryption", () => {
  it("round-trips, and two devices with the same vault key derive the same key", async () => {
    const raw = randomBytes(32);
    const a = await deriveSyncKey(raw.slice(), VAULT);
    const b = await deriveSyncKey(raw.slice(), VAULT);
    const blob = await sealRecord(a, "tabs", "dev-1", "", { hello: "world" });
    expect(await openRecord(b, "tabs", "dev-1", "", blob)).toEqual({ hello: "world" });
  });

  it("is bound to the kind, device and slot, so the server can't move a blob", async () => {
    const k = await deriveSyncKey(randomBytes(32), VAULT);
    const blob = await sealRecord(k, "sent", "phone", "id-1", { url: "https://example.com/" });
    await expect(openRecord(k, "sent", "laptop", "id-1", blob)).rejects.toThrow();
    await expect(openRecord(k, "sent", "phone", "id-2", blob)).rejects.toThrow();
    await expect(openRecord(k, "reading", null, "id-1", blob)).rejects.toThrow();
    await expect(openRecord(k, "sent", "phone", "id-1", blob)).resolves.toBeTruthy();
  });

  it("needs this vault's key and this vault's id", async () => {
    const raw = randomBytes(32);
    const k = await deriveSyncKey(raw.slice(), VAULT);
    const blob = await sealRecord(k, "tabs", "d", "", { a: 1 });
    await expect(openRecord(await deriveSyncKey(randomBytes(32), VAULT), "tabs", "d", "", blob)).rejects.toThrow();
    const other = await deriveSyncKey(raw.slice(), "11111111-2222-4333-8444-555555555555");
    await expect(openRecord({ key: other.key, scope: VAULT }, "tabs", "d", "", blob)).rejects.toThrow();
  });

  it("refuses a tampered blob, and pads so a size says little", async () => {
    const k = await deriveSyncKey(randomBytes(32), VAULT);
    const small = fromB64u(await sealRecord(k, "tabs", "d", "", { t: "x" }));
    const bigger = fromB64u(await sealRecord(k, "tabs", "d", "", { t: "x".repeat(200) }));
    expect(small.length).toBe(bigger.length);
    expect(small.length).toBe(256 + 30);
    small[40] ^= 1;
    const { b64u } = await import("./bytes");
    await expect(openRecord(k, "tabs", "d", "", b64u(small))).rejects.toThrow();
  });

  it("opens the fixed vector the Android test opens too (BrowserSyncTest.kt)", async () => {
    const { fromHex } = await import("./bytes");
    const k = await deriveSyncKey(fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), VAULT);
    const blob =
      "AQFNNlAojcEW4GZUQddQx12DbqIHFSzQIiC1IWmUEP5ueTNIk_pt3BGx4jFBpWMWHcYxiXRd6I93b75rfk8rpY8rAgqsNoCesZfpJX_eXh1GC78_QQWakXL0G83EqXyfz_htffXlJgUckV5ARBXldHT-aGla6kQTv2SNGJB_3rX6fcxHxtDGkkQsMcFQOASGda9U0cI-6OcDiXI833IPLuypvcmu-WupeFb0CvDS7OKJJrdUCEl2emRUkczDbO1raHorsaH7aY_1uX7RToN1GyNZTpSXfMQo-p8zeX8DTndXSSqbMSoYrJ_UXn6NWw4lHSGAFOJr_SVUJYiRZM-63hjsRCFXs7ty4yMrXtDnicRHX7TKXLFDh0el0rmmIg";
    expect(await openRecord(k, "sent", "5b0c1f5e-0d1b-4e4f-9a3e-1c2d3e4f5a6b", "0f1e2d3c-4b5a-4968-8776-655443322110", blob)).toEqual({ v: 1, url: "https://example.com/sent?x=1", title: "Sent", from: "Chrome", at: 1 });
  });
});

describe("open tabs", () => {
  const now = 1_800_000_000_000;
  const windows = [
    {
      focused: true,
      type: "normal",
      tabs: [
        { url: "https://news.example.com/a", title: "News", lastAccessed: now - 1000, active: true },
        { url: "chrome://settings", title: "Settings", lastAccessed: now },
        { url: "about:blank", title: "", lastAccessed: now },
        { url: "file:///C:/secret.txt", title: "secret", lastAccessed: now },
        { url: "javascript:alert(1)", title: "js", lastAccessed: now },
        { url: "chrome-extension://abc/vault.html", title: "Vault", lastAccessed: now },
        { url: "moz-extension://abc/vault.html", title: "Vault", lastAccessed: now },
        { url: "http://localhost:3000/", title: "Dev", lastAccessed: now - 5000, pinned: true },
      ],
    },
    { incognito: true, tabs: [{ url: "https://private.example.com/", title: "Private", lastAccessed: now }] },
    { type: "popup", tabs: [{ url: "https://popup.example.com/", title: "Popup", lastAccessed: now }] },
    { tabs: [{ url: "https://mixed.example.com/", title: "Leak", incognito: true, lastAccessed: now }] },
    { tabs: [{ url: "https://docs.example.org/", title: "Docs", lastAccessed: now - 9000 }] },
  ];

  it("leaves out private windows, popups and anything that isn't a web page", () => {
    const p = collectTabs(windows, { name: "Chrome on Windows", browser: "chromium", now });
    const urls = p.windows.flatMap((w) => w.tabs.map((t) => t.url));
    expect(urls).toEqual(["https://news.example.com/a", "http://localhost:3000/", "https://docs.example.org/"]);
    expect(p.windows).toHaveLength(2);
    expect(p.windows[0].focused).toBe(true);
    expect(p.windows[0].tabs[1].pinned).toBe(true);
    expect(JSON.stringify(p)).not.toContain("private");
    expect(p.left).toBeUndefined();
  });

  it("keeps the most recently used when there are too many", () => {
    const many = [{ tabs: Array.from({ length: 30 }, (_, i) => ({ url: `https://e.com/${i}`, title: `T${i}`, lastAccessed: i })) }];
    const p = collectTabs(many, { name: "x", browser: "firefox", now, maxTabs: 10 });
    expect(p.windows[0].tabs.map((t) => t.title)).toEqual(Array.from({ length: 10 }, (_, i) => `T${20 + i}`));
    expect(p.left).toBe(20);
    // And by size, with very long titles.
    const huge = [{ tabs: Array.from({ length: 400 }, (_, i) => ({ url: `https://e.com/${i}?${"q".repeat(3000)}`, title: "t".repeat(512), lastAccessed: i })) }];
    const q = collectTabs(huge, { name: "x", browser: "firefox", now });
    expect(utf8(JSON.stringify(q)).length).toBeLessThanOrEqual(MAX_TABS_PAYLOAD);
    expect(q.left).toBeGreaterThan(0);
    expect(q.windows[0].tabs[q.windows[0].tabs.length - 1].lastUsed).toBe(399);
  });

  it("publishes on a real change, not on every tab switch", () => {
    const a = collectTabs(windows, { name: "x", browser: "chromium", now });
    const switched = collectTabs(windows.map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t, lastAccessed: (t.lastAccessed ?? 0) + 50_000 })) })), { name: "x", browser: "chromium", now: now + 1000 });
    const last = { fingerprint: tabsFingerprint(a), at: now };
    expect(shouldPublish(switched, last, now + 1000)).toBe(false);
    expect(shouldPublish(switched, last, now + REFRESH_MS)).toBe(true);
    const renamed = collectTabs([{ tabs: [{ url: "https://news.example.com/a", title: "News, updated", lastAccessed: now }] }], { name: "x", browser: "chromium", now });
    expect(shouldPublish(renamed, last, now + 1000)).toBe(true);
    expect(shouldPublish(a, null, now)).toBe(true);
  });

  it("checks a blob's shape before using it", () => {
    expect(cleanTabs({ v: 2, windows: [] })).toBeNull();
    const c = cleanTabs({ v: 1, name: "n", browser: "b", at: 5, windows: [{ tabs: [{ url: "javascript:x", title: "x" }, { url: "https://a.com/", title: 5 }] }, { tabs: [] }] });
    expect(c!.windows).toEqual([{ focused: false, tabs: [{ url: "https://a.com/", title: "", lastUsed: 0, pinned: false, active: false }] }]);
  });

  it("says how fresh a list is, and searches across devices", () => {
    expect(freshness(now - 30_000, now)).toEqual({ text: "just now", stale: false });
    expect(freshness(now - 5 * 60_000, now).text).toBe("5 min ago");
    expect(freshness(now - 3 * 3600_000, now).text).toBe("3 h ago");
    expect(freshness(now - 3 * 86400_000, now)).toEqual({ text: "3 days ago", stale: true });
    const devices = [
      { device: "a", name: "Chrome", browser: "chromium", at: now, windows: [{ tabs: [{ url: "https://x.com/rust", title: "Rust book", lastUsed: 2 }] }] },
      { device: "b", name: "Firefox", browser: "firefox", at: now, windows: [{ tabs: [{ url: "https://y.com/", title: "The Rust blog", lastUsed: 5 }, { url: "https://z.com/", title: "Go", lastUsed: 9 }] }] },
    ];
    expect(searchTabs(devices, "rust").map((r) => r.device.device)).toEqual(["b", "a"]);
    expect(searchTabs(devices, "rust book")).toHaveLength(1);
    expect(searchTabs(devices, "")).toHaveLength(3);
  });
});

describe("history", () => {
  const now = new Date(2026, 10, 8, 15, 0, 0).getTime();
  const at = (daysAgo: number, h = 10) => new Date(2026, 10, 8 - daysAgo, h, 0, 0).getTime();

  it("normalises the exclude list, and matches subdomains but not lookalikes", () => {
    expect(normaliseExclude("https://www.Bank.example.com/login?x=1")).toBe("bank.example.com");
    expect(normaliseExclude("*.example.com")).toBe("example.com");
    expect(normaliseExclude("example.com:8443")).toBe("example.com");
    expect(normaliseExclude("localhost")).toBe("localhost");
    expect(normaliseExclude("not a site")).toBeNull();
    expect(normaliseExclude("")).toBeNull();
    expect(isExcluded("https://mail.example.com/x", ["example.com"])).toBe(true);
    expect(isExcluded("https://example.com/", ["example.com"])).toBe(true);
    expect(isExcluded("https://notexample.com/", ["example.com"])).toBe(false);
    expect(isExcluded("https://example.com.evil.net/", ["example.com"])).toBe(false);
  });

  it("buckets by local day, leaving out excluded sites, old days and non-web pages", () => {
    const visits = [
      { url: "https://a.com/1", title: "A", at: at(0) },
      { url: "https://a.com/2", title: "A2", at: at(1) },
      { url: "https://bank.example.com/", title: "Bank", at: at(0) },
      { url: "chrome://history", title: "History", at: at(0) },
      { url: "https://old.com/", title: "Old", at: at(95) },
      { url: "https://edge.com/", title: "Edge", at: at(89) },
      { url: "https://future.com/", title: "Future", at: now + 86400_000 },
    ];
    const b = bucketVisits(visits, { excludes: ["example.com"], days: 90, now });
    expect([...b.keys()].sort()).toEqual([dayKey(at(89)), dayKey(at(1)), dayKey(now)].sort());
    expect(b.get(dayKey(now))!.map((v) => v.url)).toEqual(["https://a.com/1"]);
    expect(oldestDay(now, 90)).toBe(dayKey(at(89)));
    expect(oldestDay(now, 1)).toBe(dayKey(now));
  });

  it("merges a day's visits idempotently, latest first, within the size limit", () => {
    const one = [{ url: "https://a.com/", title: "A", at: 1 }, { url: "https://b.com/", title: "B", at: 2 }];
    const merged = mergeVisits(one, [{ url: "https://a.com/", title: "A again", at: 3 }]);
    expect(merged).toEqual([{ url: "https://a.com/", title: "A again", at: 3 }, { url: "https://b.com/", title: "B", at: 2 }]);
    expect(mergeVisits(merged, merged)).toEqual(merged);
    const many = Array.from({ length: 5000 }, (_, i) => ({ url: `https://e.com/${i}?${"x".repeat(200)}`, title: "t".repeat(100), at: i }));
    const fit = mergeVisits([], many, 100_000);
    expect(utf8(JSON.stringify({ v: 1, day: "2026-11-08", visits: fit })).length).toBeLessThanOrEqual(100_000);
    expect(fit[0].at).toBe(4999);
  });

  it("searches", () => {
    const rows = [
      { url: "https://a.com/recipes", title: "Pasta", at: 1, device: "x" },
      { url: "https://b.com/", title: "Pasta sauce", at: 5, device: "y" },
      { url: "https://c.com/", title: "Other", at: 9, device: "y" },
    ];
    expect(searchHistory(rows, "pasta").map((r) => r.at)).toEqual([5, 1]);
    expect(searchHistory(rows, "recipes")).toHaveLength(1);
  });
});

describe("reading list mirror", () => {
  const e = (id: string, url: string, read = false, updated = 10): ReadingEntry => ({ v: 1, id, url, title: id, added: 1, read, updated });

  it("first run only adds, both ways", () => {
    const p = planMirror([e("1", "https://a.com/")], [{ url: "https://b.com/", title: "B", hasBeenRead: true }], []);
    expect(p.browserAdd.map((x) => x.url)).toEqual(["https://a.com/"]);
    expect(p.oursAdd).toEqual([expect.objectContaining({ url: "https://b.com/", read: true })]);
    expect(p.browserRemove).toEqual([]);
    expect(p.oursRemove).toEqual([]);
    expect(p.base.sort()).toEqual(["https://a.com/", "https://b.com/"]);
  });

  it("a removal on either side reaches the other", () => {
    const base = ["https://a.com/", "https://b.com/"];
    const p = planMirror([e("1", "https://a.com/")], [{ url: "https://b.com/", title: "B", hasBeenRead: false }], base);
    // a.com is gone from the browser; b.com is gone from ours.
    expect(p.oursRemove).toEqual(["1"]);
    expect(p.browserRemove).toEqual(["https://b.com/"]);
    expect(p.browserAdd).toEqual([]);
    expect(p.oursAdd).toEqual([]);
    expect(p.base).toEqual([]);
  });

  it("a read mark goes whichever way changed last, and never a javascript: address", () => {
    const ours = [e("1", "https://a.com/", false, 100), e("2", "https://b.com/", true, 100)];
    const browser = [
      { url: "https://a.com/", title: "A", hasBeenRead: true, lastUpdateTime: 200 },
      { url: "https://b.com/", title: "B", hasBeenRead: false, lastUpdateTime: 50 },
      { url: "javascript:alert(1)", title: "x", hasBeenRead: false },
    ];
    const p = planMirror(ours, browser, ["https://a.com/", "https://b.com/"]);
    expect(p.oursUpdate).toEqual([{ id: "1", read: true }]);
    expect(p.browserUpdate).toEqual([{ url: "https://b.com/", hasBeenRead: true }]);
    expect(p.oursAdd).toEqual([]);
  });
});

// ---- Against a fake server -------------------------------------------------------------

type Rec = { id: string; user: string; kind: string; device_id: string | null; slot: string; blob: string; rev: number };

function fakeServer() {
  const recs = new Map<string, Rec>();
  let rev = 0;
  const fetcher = (devices: Record<string, string>) =>
    (async (url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).Authorization?.slice(7) ?? "";
      const device = devices[token] ?? null;
      const u = new URL(url);
      const path = u.pathname.replace("/api/passwords", "");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
      const put = (kind: string, dev: string | null, slot: string, blob: string, id: string = crypto.randomUUID()) => {
        rev++;
        const had = [...recs.values()].find((r) => r.kind === kind && r.device_id === dev && r.slot === slot);
        recs.set(had?.id ?? id, { id: had?.id ?? id, user: "u", kind, device_id: dev, slot, blob, rev });
        return new Response(null, { status: 204 });
      };
      let m: RegExpExecArray | null;
      if (method === "GET" && (m = /^\/browser-sync\/(\w+)$/.exec(path))) {
        const since = Number(u.searchParams.get("since") ?? 0);
        const all = [...recs.values()].filter((r) => r.kind === m![1] && (m![1] !== "sent" || r.device_id === device));
        return json({ rev, ids: all.map((r) => r.id), records: all.filter((r) => r.rev > since).map((r) => ({ ...r, size: 0, updated_at: "now" })) });
      }
      if (method === "PUT" && path === "/browser-sync/tabs") return put("tabs", device, "", body.blob);
      if (method === "POST" && path === "/browser-sync/sent") return put("sent", body.target, body.id, body.blob, body.id);
      if (method === "PUT" && (m = /^\/browser-sync\/history\/(.+)$/.exec(path))) return put("history", device, m[1], body.blob);
      if (method === "PUT" && (m = /^\/browser-sync\/reading\/(.+)$/.exec(path))) return put("reading", null, m[1], body.blob, m[1]);
      if (method === "DELETE" && (m = /^\/browser-sync\/(sent|reading)\/(.+)$/.exec(path))) {
        if (!recs.delete(m[2])) return json({ detail: "Not found" }, 404);
        rev++;
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && path === "/browser-sync/history") {
        for (const [id, r] of recs) if (r.kind === "history") recs.delete(id);
        rev++;
        return new Response(null, { status: 204 });
      }
      return json({ detail: "Not found" }, 404);
    }) as unknown as typeof fetch;
  return { recs, fetcher };
}

describe("client against a fake server", () => {
  const devices = { tokA: "dev-a", tokB: "dev-b", tokPhone: "dev-phone" };

  async function setup() {
    const server = fakeServer();
    const raw = randomBytes(32);
    const key = await deriveSyncKey(raw, VAULT);
    const make = (token: string) => new BrowserSyncClient(new VaultApi("http://srv", () => token, server.fetcher(devices)), async () => key);
    return { server, a: make("tokA"), b: make("tokB"), phone: make("tokPhone") };
  }

  it("two browsers share tabs, and the server holds only blobs", async () => {
    const { server, a, b } = await setup();
    const now = Date.now();
    await a.publishTabs("dev-a", collectTabs([{ tabs: [{ url: "https://secret-project.example/", title: "Secret project", lastAccessed: now }] }], { name: "Chrome", browser: "chromium", now }));
    await b.publishTabs("dev-b", collectTabs([{ tabs: [{ url: "https://other.example/", title: "Other", lastAccessed: now }] }], { name: "Firefox", browser: "firefox", now }));
    const seen = await b.devicesTabs();
    expect(seen.devices.map((d) => d.name).sort()).toEqual(["Chrome", "Firefox"]);
    expect(seen.devices.find((d) => d.device === "dev-a")!.windows[0].tabs[0].title).toBe("Secret project");
    for (const r of server.recs.values()) expect(new TextDecoder().decode(fromB64u(r.blob))).not.toContain("Secret");

    // A blob the server moved to another device's slot doesn't open, and is counted, not shown.
    const recA = [...server.recs.values()].find((r) => r.device_id === "dev-a")!;
    recA.device_id = "dev-b-2";
    recA.rev = 999;
    const after = await b.devicesTabs();
    expect(after.devices.map((d) => d.device)).toEqual(["dev-b"]);
    expect(after.failed).toBe(1);
    // And once it's gone, it's gone from the cache too.
    server.recs.delete(recA.id);
    expect((await b.devicesTabs()).failed).toBe(0);
  });

  it("a sent tab arrives at the device it was for, once", async () => {
    const { a, b, phone } = await setup();
    const id = await a.send("dev-phone", { url: "https://example.com/article", title: "An article", from: "Chrome", at: 5 });
    expect((await b.inbox()).items).toEqual([]);
    const got = await phone.inbox();
    expect(got.items.map((i) => i.value)).toEqual([{ v: 1, url: "https://example.com/article", title: "An article", from: "Chrome", at: 5 }]);
    await phone.ackSent(id);
    await phone.ackSent(id); // Twice is fine.
    expect((await phone.inbox()).items).toEqual([]);
    await expect(a.send("dev-phone", { url: "javascript:alert(1)", title: "x", from: "x", at: 1 })).rejects.toThrow();
  });

  it("history from two browsers, searched together, and deleted everywhere", async () => {
    const { a, b } = await setup();
    await a.putHistory("dev-a", "2026-11-08", [{ url: "https://a.com/pasta", title: "Pasta", at: 3 }]);
    await b.putHistory("dev-b", "2026-11-08", [{ url: "https://b.com/", title: "More pasta", at: 4 }]);
    const { rows } = await a.history();
    expect(searchHistory(rows, "pasta").map((r) => r.device)).toEqual(["dev-b", "dev-a"]);
    await b.deleteHistory();
    expect((await a.history()).rows).toEqual([]);
  });

  it("reading list: save, the same address once, read and unread, remove", async () => {
    const { a, b } = await setup();
    const first = await a.saveForLater("https://example.com/long-read", "Long read", 100);
    await b.markRead(first.id, true, 200);
    const again = await a.saveForLater("https://example.com/long-read", "", 300);
    expect(again.id).toBe(first.id);
    expect(again.read).toBe(false);
    expect(again.title).toBe("Long read");
    const list = await b.readingList();
    expect(list.entries).toHaveLength(1);
    await b.deleteReading(first.id);
    expect((await a.readingList()).entries).toEqual([]);
    await expect(a.saveForLater("file:///etc/passwd", "x")).rejects.toThrow();
  });
});

it("isWebUrl", () => {
  expect(isWebUrl("https://a.com")).toBe(true);
  expect(isWebUrl("http://localhost:8080/")).toBe(true);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///x", "chrome://x", "about:blank", "", 5, "https://" + "a".repeat(5000) + ".com"]) expect(isWebUrl(bad)).toBe(false);
});
