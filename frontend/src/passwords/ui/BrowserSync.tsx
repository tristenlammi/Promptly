// Tabs from your other devices, your reading list and synced history, encrypted so the server
// can't read them. Only a browser with the extension can share its own (passwords/SYNC.md); the
// web page and the Windows app are for finding and opening what's there.
import { BookOpen, Check, ExternalLink, History, Laptop, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BrowserSyncClient, type DeviceTabs, freshness, type HistoryRow, oldestDay, type ReadingEntry, searchHistory, searchTabs } from "../core/browsersync";
import { Button, Callout, errorText, inputClass, safeHref, Spinner, useVault } from "./kit";

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function LinkRow({ url, title, meta, onOpen }: { url: string; title: string; meta?: string; onOpen?: () => void }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onOpen} className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-1)]">
      <span className="min-w-0 flex-1 truncate">{title || href}</span>
      <span className="hidden max-w-[40%] truncate text-xs text-[var(--text-muted)] sm:block">{meta ?? hostOf(href)}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-0 group-hover:opacity-100" />
    </a>
  );
}

const SHOWN_DAYS = 7;

export function BrowserSyncScreen() {
  const { vault, platform, toast, go } = useVault();
  const sync = useMemo(() => new BrowserSyncClient(vault.api, () => vault.browserSyncKey()), [vault]);
  const [query, setQuery] = useState("");
  const [devices, setDevices] = useState<DeviceTabs[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [me, setMe] = useState<string | null>(null);
  const [reading, setReading] = useState<ReadingEntry[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [allDays, setAllDays] = useState(false);
  const [days, setDays] = useState(90);
  const [daysInput, setDaysInput] = useState("90");
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, r, p, list] = await Promise.all([sync.devicesTabs(), sync.readingList(), sync.prefs(), vault.api.devices().catch(() => [])]);
      setNames(Object.fromEntries(list.filter((d) => !d.revoked_at).map((d) => [d.id, d.name])));
      setMe(((await vault.store.getMeta<string>("device_id")) as string | undefined) ?? null);
      setDevices(t.devices);
      setReading(r.entries);
      setDays(p.history_days);
      setDaysInput(String(p.history_days));
      const h = await sync.history(allDays ? undefined : oldestDay(Date.now(), SHOWN_DAYS));
      setHistory(h.rows);
      setFailed(t.failed + r.failed + h.failed);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [sync, vault, allDays]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const now = Date.now();
  const others = (devices ?? []).filter((d) => d.device !== me).sort((a, b) => b.at - a.at);
  const tabHits = query ? searchTabs(others, query) : [];
  const readingShown = query ? reading.filter((e) => `${e.title} ${e.url}`.toLowerCase().includes(query.toLowerCase())) : reading;
  const historyShown = searchHistory(history, query, 300);
  const nameOf = (d: string) => names[d] ?? "A removed device";

  const setRead = async (e: ReadingEntry, read: boolean) => {
    await sync.markRead(e.id, read).catch((err) => toast(errorText(err), "err"));
    await load();
  };
  const remove = async (e: ReadingEntry) => {
    await sync.deleteReading(e.id).catch((err) => toast(errorText(err), "err"));
    await load();
  };
  const saveDays = async () => {
    const n = Math.round(Number(daysInput));
    if (!Number.isFinite(n) || n < 1 || n > 365) return toast("Choose between 1 and 365 days.", "err");
    try {
      await sync.setPrefs(n);
      sync.clear();
      toast(n < days ? `Synced history older than ${n} days was deleted.` : "Saved");
      await load();
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  const deleteAll = async () => {
    try {
      await sync.deleteHistory();
      setConfirmDelete(false);
      toast("Synced history deleted. Each browser's own history is still there.");
      await load();
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 overflow-y-auto p-4" data-testid="browser-sync-screen">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Tabs and history</h1>
        <p className="text-sm text-[var(--text-muted)]">Open tabs on your other browsers, your reading list, and history from browsers that sync it. Encrypted, so your server can't read them.</p>
      </div>
      {platform.browserSyncControls ? (
        <p className="text-sm text-[var(--text-muted)]">
          What this browser shares is under <button type="button" className="underline" onClick={() => go("settings")}>Settings</button>.
        </p>
      ) : (
        <Callout kind="info">
          <span data-testid="browser-sync-get-extension">Each browser shares its own tabs, history and reading list through the Promptly Passwords extension. Turn them on under Settings there. This page shows what's synced.</span>
        </Callout>
      )}
      {error && <Callout kind="danger">{error}</Callout>}
      {failed > 0 && <Callout kind="warn">{failed} synced {failed === 1 ? "record" : "records"} couldn't be opened, and {failed === 1 ? "isn't" : "aren't"} shown.</Callout>}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input aria-label="Search tabs, reading list and history" placeholder="Search tabs, reading list and history" className={`${inputClass} pl-8`} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <section data-testid="other-tabs" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><Laptop className="h-4 w-4" /> Open on your other devices</h2>
        {devices === null ? (
          <Spinner label="Loading" />
        ) : query ? (
          <div className="flex flex-col">
            {tabHits.map((h, i) => <LinkRow key={i} url={h.tab.url} title={h.tab.title} meta={nameOf(h.device.device)} />)}
            {tabHits.length === 0 && <p className="text-sm text-[var(--text-muted)]">No open tabs match that.</p>}
          </div>
        ) : others.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No other browser is sharing its tabs yet.</p>
        ) : (
          others.map((d) => {
            const f = freshness(d.at, now);
            const count = d.windows.reduce((n, w) => n + w.tabs.length, 0);
            return (
              <details key={d.device} open={others.length <= 3} data-testid="device-tabs" className="rounded-lg border border-[var(--border)] px-2 py-1">
                <summary className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--text)]">{nameOf(d.device)}</span>
                  <span className={`text-xs ${f.stale ? "text-[var(--danger)]" : "text-[var(--text-muted)]"}`} title={new Date(d.at).toLocaleString()}>
                    {count} {count === 1 ? "tab" : "tabs"}, updated {f.text}
                    {f.stale ? " (may be out of date)" : ""}
                  </span>
                </summary>
                {d.windows.map((w, wi) => (
                  <div key={wi} className="border-t border-[var(--border)] py-1 first:border-0">
                    {d.windows.length > 1 && <p className="px-2 text-xs text-[var(--text-muted)]">Window {wi + 1}</p>}
                    {w.tabs.map((t, ti) => <LinkRow key={ti} url={t.url} title={t.title} />)}
                  </div>
                ))}
                {d.left ? <p className="px-2 pb-1 text-xs text-[var(--text-muted)]">And {d.left} more, not shared to keep the list small.</p> : null}
              </details>
            );
          })
        )}
      </section>

      <section data-testid="reading-list" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><BookOpen className="h-4 w-4" /> Reading list</h2>
        {readingShown.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{query ? "Nothing on your reading list matches that." : "Nothing saved for later. Use Save for later in the extension's panel, or right-click a page or link."}</p>
        ) : (
          <ul className="flex flex-col">
            {[...readingShown].sort((a, b) => Number(a.read) - Number(b.read) || b.added - a.added).map((e) => (
              <li key={e.id} data-testid="reading-entry" className={`flex items-center gap-1 ${e.read ? "opacity-60" : ""}`}>
                <LinkRow url={e.url} title={e.title} onOpen={() => void (e.read ? undefined : setRead(e, true))} />
                <Button small kind="ghost" aria-label={e.read ? "Mark unread" : "Mark read"} title={e.read ? "Mark unread" : "Mark read"} onClick={() => void setRead(e, !e.read)}>
                  <Check className="h-3.5 w-3.5" />
                  {e.read ? "Unread" : "Read"}
                </Button>
                <Button small kind="ghost" aria-label="Remove from reading list" title="Remove" onClick={() => void remove(e)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="synced-history" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><History className="h-4 w-4" /> Synced history</h2>
        <p className="text-xs text-[var(--text-muted)]">Off unless you turn it on in a browser. Private windows are never included, and sites you exclude stay out. Kept for {days} days.</p>
        {historyShown.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{query ? "No synced history matches that." : "No synced history."}</p>
        ) : (
          <ul className="flex flex-col">
            {historyShown.map((h, i) => (
              <li key={i} className="flex items-center">
                <LinkRow url={h.url} title={h.title} meta={`${new Date(h.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · ${nameOf(h.device)}`} />
              </li>
            ))}
          </ul>
        )}
        {!allDays && <Button small onClick={() => setAllDays(true)}>Show all {days} days</Button>}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Keep synced history for this many days
            <input aria-label="Days of synced history to keep" className={`${inputClass} w-28`} type="number" min={1} max={365} value={daysInput} onChange={(e) => setDaysInput(e.target.value)} />
          </label>
          <Button small onClick={() => void saveDays()}>Save</Button>
        </div>
        {confirmDelete ? (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3 text-sm">
            <p>Delete all synced history, from every browser? Each browser's own history stays as it is. This can't be undone.</p>
            <div className="flex gap-2">
              <Button kind="danger" small data-testid="confirm-delete-history" onClick={() => void deleteAll()}>Delete synced history</Button>
              <Button small onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button kind="danger" small data-testid="delete-history" onClick={() => setConfirmDelete(true)}>Delete all synced history</Button>
        )}
      </section>
    </div>
  );
}
