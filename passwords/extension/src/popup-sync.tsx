// The panel's Browse section: bookmarks, tabs open on your other devices, the reading list and
// synced history, plus sending this tab or saving it for later (passwords/SYNC.md). Everything
// decrypted comes from the background; nothing heavy is imported, so the panel stays fast.
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { ext } from "./rpc";

async function call<T>(m: unknown): Promise<T> {
  const r = (await ext.runtime.sendMessage(m).catch(() => new Promise((wait) => setTimeout(wait, 150)).then(() => ext.runtime.sendMessage(m)))) as { ok: boolean; r?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "No answer from the extension");
  return r.r as T;
}

type SyncedTab = { title: string; url: string; lastUsed: number };
type DeviceTabs = { device: string; label: string; at: number; windows: { tabs: SyncedTab[] }[]; left?: number };
type Target = { id: string; name: string; platform: string };
type ReadingEntry = { id: string; url: string; title: string; added: number; read: boolean };
type HistoryRow = { url: string; title: string; at: number; deviceName: string };
type Sub = "bookmarks" | "tabs" | "reading" | "history";

const SUBS: { id: Sub; label: string }[] = [
  { id: "bookmarks", label: "Bookmarks" },
  { id: "tabs", label: "Tabs" },
  { id: "reading", label: "Reading" },
  { id: "history", label: "History" },
];

const isWeb = (url?: string) => /^https?:\/\//i.test(url ?? "");
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const hits = (q: string, ...fields: string[]) => {
  const hay = fields.join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};
function ago(at: number): { text: string; stale: boolean } {
  const min = Math.floor(Math.max(0, Date.now() - at) / 60000);
  const text = min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 2880 ? `${Math.floor(min / 60)} h ago` : `${Math.floor(min / 1440)} days ago`;
  return { text, stale: min > 1440 };
}
const openSettings = () => ext.tabs.create({ url: ext.runtime.getURL("vault.html#/settings") });

function LinkRow({ url, title, sub, onOpen, children }: { url: string; title: string; sub?: string; onOpen: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center">
      <button className="row min-w-0 flex-1" title={url} aria-label={`Open ${title || url}`} onClick={onOpen}>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{title || url}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{sub ?? host(url)}</span>
        </span>
      </button>
      {children}
    </div>
  );
}

const open = (url: string) => call({ t: "bs:open", url }).then(() => window.close());

/** Send the tab in front to another device, or save it for later. */
function ThisTab({ tab }: { tab: chrome.tabs.Tab | null }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [message, setMessage] = useState("");
  if (!tab || !isWeb(tab.url)) return null;
  const url = tab.url!;
  const title = tab.title ?? url;
  const act = async (f: () => Promise<unknown>, done: string) => {
    setMessage("");
    try {
      await f();
      setMessage(done);
      setTargets(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div data-testid="this-tab" className="flex flex-col gap-2 rounded-lg bg-[var(--surface-1)] p-2 text-xs">
      <div className="flex gap-2">
        <button className="btn flex-1" data-testid="send-tab" onClick={() => (targets ? setTargets(null) : call<Target[]>({ t: "bs:targets" }).then(setTargets, (e) => setMessage(String(e.message ?? e))))}>Send this tab</button>
        <button className="btn flex-1" data-testid="save-for-later" onClick={() => void act(() => call({ t: "bs:save", url, title }), "Saved for later.")}>Save for later</button>
      </div>
      {targets && (
        <div className="flex flex-col" data-testid="send-targets">
          {targets.length === 0 && <p className="muted">No other devices yet. Connect another browser, or Promptly for Android.</p>}
          {targets.map((t) => (
            <button key={t.id} className="row" aria-label={`Send to ${t.name}`} onClick={() => void act(() => call({ t: "bs:send", target: t.id, url, title }), `Sent to ${t.name}.`)}>
              <span className="flex-1 truncate text-left">{t.name}</span>
              <span className="text-[var(--text-muted)]">{t.platform === "android" ? "phone" : t.platform === "firefox" ? "Firefox" : "browser"}</span>
            </button>
          ))}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

function OtherTabs({ query }: { query: string }) {
  const [devices, setDevices] = useState<DeviceTabs[] | null>(null);
  const [problem, setProblem] = useState("");
  const [shared, setShared] = useState<boolean | null>(null);
  useEffect(() => {
    call<{ devices: DeviceTabs[] }>({ t: "bs:tabs" }).then((r) => setDevices(r.devices), (e) => setProblem(String(e.message ?? e)));
    call<{ settings: { tabs: boolean } }>({ t: "bs:state" }).then((s) => setShared(s.settings.tabs), () => undefined);
  }, []);
  if (problem) return <p role="alert" className="err">{problem}</p>;
  if (!devices) return <p className="muted">Loading tabs from your other devices…</p>;
  const off = shared === false && (
    <button className="btn" onClick={openSettings}>Share this browser's tabs too</button>
  );
  if (query) {
    const found = devices.flatMap((d) => d.windows.flatMap((w) => w.tabs.filter((t) => hits(query, t.title, t.url)).map((t) => ({ d, t }))));
    return (
      <div className="flex flex-col">
        {found.slice(0, 100).map(({ d, t }, i) => <LinkRow key={i} url={t.url} title={t.title} sub={`${d.label} · ${host(t.url)}`} onOpen={() => void open(t.url)} />)}
        {found.length === 0 && <p className="muted">No open tabs match that.</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="other-devices">
      {devices.length === 0 && <p className="muted">No other device is sharing its tabs yet. Turn on "Share this browser's open tabs" in Settings in each browser.</p>}
      {devices.map((d) => {
        const f = ago(d.at);
        const n = d.windows.reduce((s, w) => s + w.tabs.length, 0);
        return (
          <div key={d.device} data-testid="device-tabs">
            <p className="section flex justify-between gap-2">
              <span className="truncate">{d.label}</span>
              <span className={f.stale ? "err" : "text-[var(--text-muted)]"} title={new Date(d.at).toLocaleString()}>{n} · {f.text}</span>
            </p>
            {d.windows.map((w, wi) => (
              <div key={wi} className={wi ? "mt-1 border-t border-[var(--border)] pt-1" : ""}>
                {w.tabs.map((t, ti) => <LinkRow key={ti} url={t.url} title={t.title} onOpen={() => void open(t.url)} />)}
              </div>
            ))}
            {d.left ? <p className="muted">And {d.left} more.</p> : null}
          </div>
        );
      })}
      {off}
    </div>
  );
}

function Reading({ query }: { query: string }) {
  const [entries, setEntries] = useState<ReadingEntry[] | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => call<{ entries: ReadingEntry[] }>({ t: "bs:reading" }).then((r) => setEntries(r.entries), (e) => setProblem(String(e.message ?? e))), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (problem) return <p role="alert" className="err">{problem}</p>;
  if (!entries) return <p className="muted">Loading your reading list…</p>;
  const shown = entries.filter((e) => !query || hits(query, e.title, e.url)).sort((a, b) => Number(a.read) - Number(b.read) || b.added - a.added);
  return (
    <div className="flex flex-col" data-testid="reading-list">
      {shown.length === 0 && <p className="muted">{query ? "Nothing on your reading list matches that." : "Nothing saved for later. Use Save for later above, or right-click a page or link."}</p>}
      {shown.map((e) => (
        <div key={e.id} className={e.read ? "opacity-60" : ""} data-testid="reading-entry">
          <LinkRow url={e.url} title={e.title} onOpen={() => void (e.read ? Promise.resolve() : call({ t: "bs:readingSet", id: e.id, read: true })).then(() => open(e.url))}>
            <button className="icon-btn text-xs" aria-label={e.read ? "Mark unread" : "Mark read"} title={e.read ? "Mark unread" : "Mark read"} onClick={() => void call({ t: "bs:readingSet", id: e.id, read: !e.read }).then(load)}>{e.read ? "○" : "✓"}</button>
            <button className="icon-btn text-xs" aria-label="Remove from reading list" title="Remove" onClick={() => void call({ t: "bs:readingDelete", id: e.id }).then(load)}>✕</button>
          </LinkRow>
        </div>
      ))}
    </div>
  );
}

function History({ query }: { query: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [all, setAll] = useState(false);
  const [problem, setProblem] = useState("");
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    call<{ settings: { history: boolean } }>({ t: "bs:state" }).then((s) => setOn(s.settings.history), () => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => call<{ rows: HistoryRow[] }>({ t: "bs:history", query, all }).then((r) => setRows(r.rows), (e) => setProblem(String(e.message ?? e))), 150);
    return () => clearTimeout(t);
  }, [query, all]);
  if (problem) return <p role="alert" className="err">{problem}</p>;
  if (!rows) return <p className="muted">Loading synced history…</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="synced-history">
      {on === false && (
        <p className="muted">
          History sync is off in this browser. <button className="underline" onClick={openSettings}>Settings</button> explains it and turns it on.
        </p>
      )}
      {rows.map((r, i) => <LinkRow key={i} url={r.url} title={r.title} sub={`${new Date(r.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · ${r.deviceName}`} onOpen={() => void open(r.url)} />)}
      {rows.length === 0 && <p className="muted">{query ? "No synced history matches that." : "No synced history in the last week."}</p>}
      {!all && <button className="btn" onClick={() => setAll(true)}>Search every day kept</button>}
    </div>
  );
}

export function BrowseTab({ query, tab, bookmarks }: { query: string; tab: chrome.tabs.Tab | null; bookmarks: ReactNode }) {
  const [sub, setSub] = useState<Sub>("bookmarks");
  return (
    <div className="flex flex-col gap-2">
      <ThisTab tab={tab} />
      <div role="tablist" aria-label="Browse" className="grid grid-cols-4 gap-1 rounded-lg bg-[var(--surface-1)] p-0.5 text-xs">
        {SUBS.map((s) => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} data-testid={`browse-${s.id}`} className={`rounded-md py-1 font-medium ${sub === s.id ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "text-[var(--text-muted)]"}`} onClick={() => setSub(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {sub === "bookmarks" && bookmarks}
      {sub === "tabs" && <OtherTabs query={query} />}
      {sub === "reading" && <Reading query={query} />}
      {sub === "history" && <History query={query} />}
    </div>
  );
}
