// "Sync with this browser" in the extension's Settings: open tabs, sent tabs, history and the
// reading list, each on or off here (passwords/SYNC.md). Bookmarks have their own screen.
import { useEffect, useState } from "react";

import { normaliseExclude } from "../../../frontend/src/passwords/core/browsersync";
import { Button, Callout, inputClass } from "../../../frontend/src/passwords/ui/kit";
import type { SyncSettings, SyncStateOut } from "./browsersync";
import { ext } from "./rpc";

async function call<T>(m: unknown): Promise<T> {
  const r = (await ext.runtime.sendMessage(m)) as { ok: boolean; r?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "No answer from the extension");
  return r.r as T;
}

type Perm = "tabs" | "history" | "notifications" | "readingList";

function Check({ testId, checked, onChange, label, children }: { testId: string; checked: boolean; onChange: (on: boolean) => void; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
        <input type="checkbox" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {children && <p className="pl-6 text-xs text-[var(--text-muted)]">{children}</p>}
    </div>
  );
}

export function BrowserSyncSettings() {
  const [s, setS] = useState<SyncStateOut | null>(null);
  const [problem, setProblem] = useState("");
  const [excludes, setExcludes] = useState("");
  const [days, setDays] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const load = async () => {
    const st = await call<SyncStateOut>({ t: "bs:state" });
    setS(st);
    setExcludes(st.settings.excludes.join("\n"));
    if (st.unlocked) call<{ history_days: number }>({ t: "bs:prefs" }).then((p) => setDays(p.history_days), () => undefined);
  };
  useEffect(() => {
    void load();
  }, []);
  if (!s) return null;

  /** The browser asks first. The request has to come straight from the click. */
  const toggle = async (key: keyof SyncSettings, on: boolean, perm?: Perm) => {
    setProblem("");
    setNote("");
    if (perm) {
      const granted = on ? await ext.permissions.request({ permissions: [perm as chrome.runtime.ManifestPermission] }).catch(() => false) : true;
      if (!granted) return setProblem("The browser didn't give permission, so this stays off.");
    }
    try {
      await call({ t: "bs:set", settings: { [key]: on } });
      // Given back when it's not needed, so the browser's list of what we can do stays short.
      if (!on && perm) await ext.permissions.remove({ permissions: [perm as chrome.runtime.ManifestPermission] }).catch(() => false);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  const saveExcludes = async () => {
    const lines = excludes.split(/\n|,/).map((l) => l.trim()).filter(Boolean);
    const clean = lines.map(normaliseExclude);
    const bad = lines.filter((_, i) => !clean[i]);
    if (bad.length) return setProblem(`Not a site: ${bad.slice(0, 3).join(", ")}`);
    await call({ t: "bs:set", settings: { excludes: [...new Set(clean as string[])] } });
    setNote("Saved. Those sites are taken out of this browser's synced history too.");
    await load();
  };

  const forget = async () => {
    await call({ t: "bs:deleteHistory", thisDevice: true });
    setNote("This browser's synced history is deleted. Its own history is still there.");
  };

  const firefox = s.engine === "firefox";
  const errors = Object.entries(s.status).filter(([, v]) => v.error);
  return (
    <div data-testid="browser-sync-settings" className="flex flex-col gap-4">
      <p className="text-xs text-[var(--text-muted)]">
        Each of these is for this browser only, and works between Chrome, Firefox and the others, end-to-end encrypted: your server sees how big each piece is and when it changes, never what's in it. They run while the vault's unlocked. Bookmarks are on the Bookmarks screen.
      </p>
      <Check testId="bs-tabs" checked={s.settings.tabs && s.granted.tabs} onChange={(on) => void toggle("tabs", on, "tabs")} label="Share this browser's open tabs">
        Your other devices can see the tabs open here, and open them. Private windows and the browser's own pages are never shared. It updates a few seconds after a change.
      </Check>
      <Check testId="bs-notify" checked={s.settings.notify && s.granted.notifications} onChange={(on) => void toggle("notify", on, "notifications")} label="Show a notification for a tab sent here">
        Tabs you send here from another device open in the background. With this on, a notification says one arrived, and opens it when clicked. It names the device, not the page.
      </Check>
      <Check testId="bs-history" checked={s.settings.history && s.granted.history} onChange={(on) => void toggle("history", on, "history")} label="Sync this browser's history">
        Off unless you turn it on. From then on, this copies the address and title of pages you visit in this browser into your vault, encrypted, so you can search them from your other devices. Private windows are never included, and neither are the sites listed below. Synced history older than {days ?? 90} days is deleted (change that on the Tabs and history screen). Turning this off stops copying; what was synced stays until it's that old, or you delete it. Clearing this browser's history clears what it synced.
      </Check>
      {s.settings.history && (
        <div className="flex flex-col gap-2 pl-6">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Never sync history from these sites (one per line, includes their subdomains)
            <textarea data-testid="bs-excludes" className={`${inputClass} min-h-[4rem] font-mono text-xs`} value={excludes} onChange={(e) => setExcludes(e.target.value)} placeholder={"bank.example.com\nhealth.example.org"} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button small onClick={() => void saveExcludes()}>Save sites</Button>
            <Button small kind="danger" data-testid="bs-forget" onClick={() => void forget()}>Delete this browser's synced history</Button>
          </div>
        </div>
      )}
      {firefox ? (
        <p className="text-xs text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text)]">Reading list.</span> Save for later from the panel or by right-clicking a page or link. Firefox has no reading list extensions can use, so this one is the list here, and it syncs with your other browsers.
        </p>
      ) : (
        <Check testId="bs-reading" checked={s.settings.mirrorReading && s.granted.readingList} onChange={(on) => void toggle("mirrorReading", on, "readingList")} label="Keep this browser's own reading list the same">
          Save for later, from the panel or by right-clicking a page or link, always syncs. With this on, the browser's own reading list (in its side panel) matches it, both ways. The first time only adds.
        </Check>
      )}
      {note && <p role="status" className="text-xs text-[var(--text-muted)]">{note}</p>}
      {problem && <Callout kind="danger">{problem}</Callout>}
      {errors.length > 0 && (
        <Callout kind="warn">
          {errors.map(([k, v]) => (
            <span key={k} className="block">Last {k} sync: {v.error}</span>
          ))}
        </Callout>
      )}
    </div>
  );
}
