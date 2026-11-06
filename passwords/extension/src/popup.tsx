// The toolbar popup: this site's logins first, then search, 2FA codes, a generator.
// This is the safest way to fill: a page can't touch or cover it. It has to open fast,
// so anything heavy (the generator's word list and site rules, site matching) stays in
// the background and is asked for.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { nativeHello, nativeHelloStatus, toB64u } from "./native";
import { ext, type Candidate, type FillOutcome, pageHost, type StateOut } from "./rpc";

declare const __TEST_BUILD__: boolean;

type Row = { id: string; title: string; username: string; kind: string; hasTotp: boolean; reprompt: boolean; favorite?: boolean };
type Counts = { login: number; card: number; identity: number; note: number; other: number; codes: number; favorites: number; bookmarks: number };

// Inline, so the popup stays small enough to open fast. Paths from Lucide (ISC), as the vault page uses.
const PATHS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72M14 7l3 3"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  note: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6M8 13h8M8 17h6"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/>',
} as const;

function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />;
}

const Mark = () => <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-[#fff]"><Icon name="key" size={14} /></span>;

const openPage = (route = "") => ext.tabs.create({ url: ext.runtime.getURL(`vault.html${route ? `#/${route}` : ""}`) });

async function call<T>(m: unknown): Promise<T> {
  // The worker or event page may be on its way out, and a second try wakes a new one.
  const r = (await ext.runtime.sendMessage(m).catch(() => new Promise((wait) => setTimeout(wait, 150)).then(() => ext.runtime.sendMessage(m)))) as { ok: boolean; r?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "No answer from the extension");
  return r.r as T;
}

const OPEN_DEVICES = () => ext.tabs.create({ url: ext.runtime.getURL("vault.html#/devices") });

/** Written here while the click still counts. The background clears it when it's due,
 *  with this popup long closed. */
async function copySecret(text: string) {
  await navigator.clipboard.writeText(text);
  await call({ t: "clipWatch", text });
}

function Popup() {
  const [state, setState] = useState<StateOut | null>(null);
  const reload = useCallback(() => call<StateOut>({ t: "state" }).then(setState), []);
  useEffect(() => {
    reload();
  }, [reload]);
  if (!state) return <p className="p-3 text-sm">Loading…</p>;
  if (!state.connected || !state.hasKit) return <SetupView connected={state.connected} />;
  if (!state.unlocked) return <UnlockView onDone={reload} preview={state.preview} />;
  return <Open state={state} onLock={reload} />;
}

/** Signing in on the website doesn't connect this: the browser has to agree, and the vault's keys
 *  never come from a page. If the page in front looks like Promptly, its address is filled in. */
function SetupView({ connected }: { connected: boolean }) {
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    // A test build can be opened in a tab of its own and aimed at another tab.
    const aimed = __TEST_BUILD__ ? Number(new URLSearchParams(location.search).get("tab")) : 0;
    (aimed ? ext.tabs.get(aimed).then((t) => [t]) : ext.tabs.query({ active: true, currentWindow: true }))
      .then(([t]) => {
        const u = new URL(t?.url ?? "");
        if ((u.protocol === "https:" || u.protocol === "http:") && (u.pathname.startsWith("/passwords") || u.searchParams.get("next")?.startsWith("/passwords"))) setServer(u.origin);
      })
      .catch(() => undefined);
  }, []);
  const steps = connected ? ["Enter your Secret Key and master password, or approve this browser from another device."] : ["Connect to your server. The browser asks to allow it.", "Approve this browser in a Promptly tab.", "Enter your Secret Key and master password."];
  return (
    <div className="flex w-[360px] flex-col gap-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <Mark />
        <h1 className="text-base font-semibold">{connected ? "Finish setting up" : "Set up Promptly Passwords"}</h1>
      </div>
      <p className="text-[var(--text-muted)]">{connected ? "This browser is connected. One step left." : "Signing in on the website doesn't connect the extension. It takes about a minute, once for each browser."}</p>
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs font-semibold">{i + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {server && !connected && <p data-testid="setup-server" className="rounded-lg bg-[var(--surface-1)] p-2 text-xs">Your server looks like <span className="font-medium">{server}</span>. You can check that on the next screen.</p>}
      <button className="btn-primary" onClick={() => ext.tabs.create({ url: ext.runtime.getURL(`vault.html${server && !connected ? `?server=${encodeURIComponent(server)}` : ""}`) })}>Set up</button>
    </div>
  );
}

function UnlockView({ onDone, preview }: { onDone: () => void; preview: boolean }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await call({ t: "unlock", password: pw });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't unlock");
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-[360px] flex-col gap-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <Mark />
        <p className="text-base font-semibold">Unlock your vault</p>
        {preview && <span className="badge">Preview</span>}
      </div>
      <input className="input" type="password" aria-label="Master password" placeholder="Master password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {error && <p className="err">{error}</p>}
      <HelloLine onDone={onDone} onError={setError} />
      <PinLine onDone={onDone} onError={setError} />
      <button className="btn-primary" type="submit" disabled={busy || !pw}>{busy ? "Unlocking…" : "Unlock"}</button>
    </form>
  );
}

/** Only shows if the Windows app is there and Hello has been turned on for this browser. */
function HelloLine({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    nativeHelloStatus().then((s) => setOn(s.available && s.enabled));
  }, []);
  if (!on) return null;
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        onError("");
        try {
          const secret = await nativeHello().unlock();
          if (!secret) return; // The person said no.
          await call({ t: "unlockWithSecret", secret: toB64u(secret) });
          secret.fill(0);
          onDone();
        } catch (err) {
          onError(err instanceof Error ? err.message : "Windows Hello didn't work");
        }
      }}
    >
      Use Windows Hello
    </button>
  );
}

/** Only shows if a PIN was set in this browser session. */
function PinLine({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [has, setHas] = useState(false);
  const [pin, setPin] = useState("");
  useEffect(() => {
    call<{ pin: boolean }>({ t: "extSettings" }).then((s) => setHas(s.pin)).catch(() => undefined);
  }, []);
  if (!has) return null;
  return (
    <div className="flex gap-2">
      <input className="input" type="password" inputMode="numeric" aria-label="PIN" placeholder="PIN" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
      <button
        type="button"
        className="btn"
        disabled={!pin}
        onClick={async () => {
          try {
            await call({ t: "pinUnlock", pin });
            onDone();
          } catch (err) {
            setPin("");
            onError(err instanceof Error ? err.message : "Couldn't unlock");
            call<{ pin: boolean }>({ t: "extSettings" }).then((s) => setHas(s.pin)).catch(() => undefined);
          }
        }}
      >
        Use PIN
      </button>
    </div>
  );
}

/** Less common things, out of the way of the list. */
function PageTools({ tab, matches, setMessage }: { tab: chrome.tabs.Tab | null; matches: Candidate[]; setMessage: (m: string) => void }) {
  const [report, setReport] = useState("");
  const [uri, setUri] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  if (tab?.id === undefined) return null;
  const tabId = tab.id;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">This page</summary>
      <div className="mt-1 flex flex-col gap-1">
        <button className="btn" onClick={async () => {
          const r = await call<{ uri: string | null }>({ t: "scanTabQr", windowId: tab.windowId });
          if (r.uri) setUri(r.uri);
          else setMessage("No QR code showing on this page.");
        }}>Scan a 2FA QR code on this page</button>
        {uri && (
          <>
            {matches[0] && <button className="btn-primary" onClick={async () => {
              try {
                const r = await call<{ ok: boolean; replaces?: string }>({ t: "addTotp", itemId: matches[0].id, uri, title: matches[0].title, url: tab.url ?? "", replace: replacing });
                if (r.replaces) {
                  setReplacing(true);
                  setMessage(`${r.replaces} already has a 2FA code. Click again only if you meant to replace it. The old secret is kept in that item's custom fields.`);
                  return;
                }
                setMessage(`Added 2FA to ${matches[0].title}.`);
                setUri(null);
                setReplacing(false);
              } catch (e) { setMessage(e instanceof Error ? e.message : "Couldn't add it"); }
            }}>{replacing ? "Replace the code on" : "Add to"} {matches[0].title}</button>}
            <button className="btn" onClick={async () => {
              try {
                const title = pageHost(tab.url ?? "")?.replace(/^www\./, "") ?? "2FA code";
                await call({ t: "addTotp", itemId: null, uri, title, url: tab.url ?? "" });
                setMessage("Saved as a new 2FA code.");
                setUri(null);
              } catch (e) { setMessage(e instanceof Error ? e.message : "Couldn't add it"); }
            }}>Save as a new 2FA code</button>
          </>
        )}
        <button className="btn" onClick={async () => {
          await call({ t: "teach", tabId });
          window.close();
        }}>Show me which boxes to fill here</button>
        <button className="btn" onClick={async () => {
          const r = await call<string>({ t: "reportForm", tabId });
          setReport(r ?? "");
        }}>Describe this form for a bug report</button>
        {report && (
          <>
            <p>The structure only, with no values or text you typed. Check it before sending it to anyone.</p>
            <textarea className="input" rows={6} readOnly value={report} aria-label="Form description" />
            <button className="btn" onClick={async () => { await navigator.clipboard.writeText(report); setMessage("Copied the form description."); }}>Copy description</button>
          </>
        )}
      </div>
    </details>
  );
}

type Tab = "vault" | "codes" | "generator" | "bookmarks" | "more";
const TABS: { id: Tab; label: string; icon: keyof typeof PATHS }[] = [
  { id: "vault", label: "Vault", icon: "key" },
  { id: "codes", label: "Codes", icon: "shield" },
  { id: "generator", label: "Generator", icon: "wand" },
  { id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
  { id: "more", label: "More", icon: "menu" },
];

function Open({ state, onLock }: { state: StateOut; onLock: () => void }) {
  const [tabInfo, setTabInfo] = useState<chrome.tabs.Tab | null>(null);
  const [matches, setMatches] = useState<Candidate[]>([]);
  const [lookalike, setLookalike] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<{ itemId: string; outcome: FillOutcome; prior: object } | null>(null);
  const [tab, setTab] = useState<Tab>("vault");
  const [adding, setAdding] = useState(false);
  const [reprompt, setReprompt] = useState<{ pass: () => void } | null>(null);

  useEffect(() => {
    (async () => {
      // A test build can be opened in a tab of its own and aimed at another tab.
      const aimed = __TEST_BUILD__ ? Number(new URLSearchParams(location.search).get("tab")) : 0;
      const t = aimed ? await ext.tabs.get(aimed) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
      setTabInfo(t ?? null);
      if (t?.id !== undefined) {
        const r = await call<{ candidates: Candidate[]; lookalike: string | null }>({ t: "matches", tabId: t.id });
        setMatches(r.candidates);
        setLookalike(r.lookalike);
      }
    })();
  }, []);

  useEffect(() => {
    if (!q || tab === "bookmarks") return setRows([]);
    call<Row[]>({ t: "list", query: q }).then(setRows);
  }, [q, tab]);

  const doFill = async (itemId: string, extra: object = {}) => {
    if (tabInfo?.id === undefined) return;
    setMessage("");
    const r = await call<FillOutcome>({ t: "fill", tabId: tabInfo.id, itemId, ...extra });
    if (r.ok) {
      if (r.left?.length) {
        // The person should know, and nothing's been closed on them.
        setMessage(`Filled, but left out ${r.left.join(", ")}: that box can't be seen on the page.`);
        return;
      }
      setMessage("Filled.");
      setTimeout(() => window.close(), 700);
      return;
    }
    if (r.reason === "reprompt") return setReprompt({ pass: () => doFill(itemId, { ...extra, reprompted: true }) });
    if (r.reason.startsWith("confirm")) return setConfirm({ itemId, outcome: r, prior: extra });
    setMessage(r.reason === "no-fields" ? "No fields to fill on this page. If you can see one, This page below can describe it for a bug report." : r.reason === "locked" ? "Locked." : "Couldn't fill this page.");
  };

  const answer = () => {
    if (!confirm) return;
    const o = confirm.outcome as FillOutcome & { reason: string; origin?: string; frames?: string[] };
    const more: Record<string, unknown> = { ...confirm.prior };
    if (o.reason === "confirm-origin") more.confirmOrigin = o.origin;
    if (o.reason === "confirm-downgrade") more.confirmDowngrade = true;
    if (o.reason === "confirm-lookalike") more.confirmLookalike = true;
    if (o.reason === "confirm-card") {
      more.confirmCard = true;
      more.confirmFrames = o.frames ?? [];
    }
    setConfirm(null);
    doFill(confirm.itemId, more);
  };

  const rowProps = { onReprompt: (pass: () => void) => setReprompt({ pass }), setMessage };
  const searching = !!q && tab !== "bookmarks";
  return (
    <div className="flex h-[580px] w-[360px] flex-col text-sm">
      <header className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2">
        <Mark />
        <span className="ml-1 min-w-0 flex-1 truncate font-semibold">Passwords</span>
        {state.preview && <span className="badge" title="Try it on low-value accounts first.">Preview</span>}
        <button className="icon-btn" aria-label="Add a login" title="Add a login" onClick={() => setAdding(!adding)}><Icon name="plus" /></button>
        <button className="icon-btn" aria-label="Open vault" title="Open the full vault" onClick={() => openPage()}><Icon name="external" /></button>
        <button className="icon-btn" aria-label="Lock" title="Lock" onClick={async () => { await call({ t: "lock" }); onLock(); }}><Icon name="lock" /></button>
      </header>
      <div className="relative px-3 pt-2">
        <span className="pointer-events-none absolute left-5 top-[15px] text-[var(--text-muted)]"><Icon name="search" size={14} /></span>
        <input
          className="input !pl-7"
          aria-label={tab === "bookmarks" ? "Search bookmarks" : "Search your vault"}
          placeholder={tab === "bookmarks" ? "Search bookmarks" : "Search your vault"}
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAdding(false);
            if (tab !== "bookmarks" && e.target.value) setTab("vault");
          }}
        />
      </div>

      <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        {state.deviceRequests > 0 && (
          <button data-testid="device-request" className="btn-primary" onClick={OPEN_DEVICES}>
            A new device is asking to join your vault. Check it
          </button>
        )}
        {lookalike && <p className="err">This site looks like {lookalike}, but it isn't. Be careful.</p>}
        {message && <p role="status" className="text-xs font-medium">{message}</p>}
        {confirm && <ConfirmBox outcome={confirm.outcome} onYes={answer} onNo={() => setConfirm(null)} />}
        {reprompt && (
          <RepromptBox
            onPass={() => {
              const r = reprompt;
              setReprompt(null);
              r.pass();
            }}
            onCancel={() => setReprompt(null)}
          />
        )}
        {adding && <AddLogin tab={tabInfo} onDone={() => setAdding(false)} />}

        {tab === "vault" && !adding && (
          searching ? (
            <div className="flex flex-col">
              {rows.map((m) => <ItemRow key={m.id} row={m} onFill={() => doFill(m.id)} {...rowProps} />)}
              {rows.length === 0 && <p className="muted">Nothing matches that.</p>}
            </div>
          ) : (
            <VaultHome tab={tabInfo} matches={matches} doFill={doFill} rowProps={rowProps} />
          )
        )}
        {tab === "codes" && <CodesTab query={q} {...rowProps} />}
        {tab === "generator" && <Generator host={pageHost(tabInfo?.url ?? "") ?? undefined} />}
        {tab === "bookmarks" && <BookmarksTab query={q} />}
        {tab === "more" && <MoreTab preview={state.preview} setMessage={setMessage} />}
      </main>

      <nav aria-label="Sections" className="grid grid-cols-5 border-t border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-label={t.label}
            aria-current={tab === t.id ? "page" : undefined}
            className={`flex flex-col items-center gap-0.5 py-1.5 text-[10px] font-medium ${tab === t.id ? "text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"}`}
            onClick={() => {
              setTab(t.id);
              setAdding(false);
            }}
          >
            <Icon name={t.icon} size={18} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const CATEGORIES: { id: string; label: string; icon: keyof typeof PATHS; count: keyof Counts }[] = [
  { id: "login", label: "Logins", icon: "key", count: "login" },
  { id: "card", label: "Cards", icon: "card", count: "card" },
  { id: "identity", label: "Identities", icon: "user", count: "identity" },
  { id: "note", label: "Secure notes", icon: "note", count: "note" },
  { id: "other", label: "Keys and documents", icon: "folder", count: "other" },
];

type RowProps = { onReprompt: (pass: () => void) => void; setMessage: (m: string) => void };

function VaultHome({ tab, matches, doFill, rowProps }: { tab: chrome.tabs.Tab | null; matches: Candidate[]; doFill: (id: string) => void; rowProps: RowProps }) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [favourites, setFavourites] = useState<Row[]>([]);
  const [category, setCategory] = useState<{ id: string; label: string } | null>(null);
  const [list, setList] = useState<Row[]>([]);
  useEffect(() => {
    call<Counts>({ t: "counts" }).then(setCounts).catch(() => undefined);
    call<Row[]>({ t: "list", favorite: true }).then(setFavourites).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (category) call<Row[]>({ t: "list", kind: category.id }).then(setList);
  }, [category]);
  if (category) {
    return (
      <div className="flex flex-col">
        <button className="mb-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-muted)]" onClick={() => setCategory(null)}><Icon name="back" size={14} /> {category.label}</button>
        {list.map((m) => <ItemRow key={m.id} row={m} onFill={() => doFill(m.id)} {...rowProps} />)}
        {list.length === 0 && <p className="muted">Nothing here yet.</p>}
      </div>
    );
  }
  const here = new Set(matches.map((m) => m.id));
  const stars = favourites.filter((f) => !here.has(f.id));
  return (
    <>
      {tab?.id !== undefined && <PasskeyRows tabId={tab.id} setMessage={rowProps.setMessage} />}
      {tab?.id !== undefined && <SaveOffer tabId={tab.id} />}
      {tab?.id !== undefined && <MailRows tabId={tab.id} setMessage={rowProps.setMessage} />}
      <div className="flex flex-col">
        <p className="section">This site</p>
        {matches.length === 0 && <p className="muted">Nothing saved for this site.</p>}
        {matches.map((m) => <ItemRow key={m.id} row={m} here onFill={() => doFill(m.id)} {...rowProps} />)}
      </div>
      {stars.length > 0 && (
        <div className="flex flex-col">
          <p className="section">Favourites</p>
          {stars.map((m) => <ItemRow key={m.id} row={m} onFill={() => doFill(m.id)} {...rowProps} />)}
        </div>
      )}
      <div className="flex flex-col">
        <p className="section">Your vault</p>
        {CATEGORIES.map((c) => (
          <button key={c.id} className="row" onClick={() => setCategory(c)} aria-label={`Show ${c.label}`}>
            <span className="text-[var(--text-muted)]"><Icon name={c.icon} /></span>
            <span className="min-w-0 flex-1 truncate text-left">{c.label}</span>
            <span className="text-xs text-[var(--text-muted)]">{counts ? counts[c.count] : ""}</span>
            <span className="text-[var(--text-muted)]"><Icon name="chevron" size={14} /></span>
          </button>
        ))}
      </div>
      <PageTools tab={tab} matches={matches} setMessage={rowProps.setMessage} />
    </>
  );
}

/** A 2FA code that keeps itself up to date. Gated the same way as showing the item. */
function useCode(row: { id: string; hasTotp: boolean; reprompt: boolean }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [period, setPeriod] = useState(30);
  const [passed, setPassed] = useState(false);
  const gated = row.reprompt && !passed;
  useEffect(() => {
    if (!row.hasTotp || gated) return;
    let live = true;
    const tick = async () => {
      const r = await call<{ code: string; period: number } | null>({ t: "totp", id: row.id, reprompted: passed });
      if (live && r) {
        setCode(r.code);
        setPeriod(r.period);
        setLeft(r.period - (Math.floor(Date.now() / 1000) % r.period));
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [row.id, row.hasTotp, gated, passed]);
  return { code, left, period, gated, pass: () => setPassed(true) };
}

function CodesTab({ query, onReprompt, setMessage }: { query: string } & RowProps) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    call<Row[]>({ t: "list", query, totp: true }).then(setRows).catch(() => undefined);
  }, [query]);
  // A code a second each is cheap, and this many fit nobody's screen anyway.
  const shown = rows.slice(0, 30);
  return (
    <div className="flex flex-col gap-1">
      {shown.map((r) => <CodeRow key={r.id} row={r} onReprompt={onReprompt} setMessage={setMessage} />)}
      {rows.length === 0 && <p className="muted">{query ? "No 2FA codes match that." : "No 2FA codes yet. Add one to a login in the vault."}</p>}
      {rows.length > shown.length && <p className="muted">Search to find the rest.</p>}
    </div>
  );
}

function CodeRow({ row, onReprompt, setMessage }: { row: Row } & RowProps) {
  const { code, left, period, gated, pass } = useCode(row);
  const pretty = code && code.length > 4 ? `${code.slice(0, Math.floor(code.length / 2))} ${code.slice(Math.floor(code.length / 2))}` : code;
  return (
    <div className="row !cursor-default">
      <Avatar title={row.title} />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium">{row.title}</span>
        {row.username && <span className="block truncate text-xs text-[var(--text-muted)]">{row.username}</span>}
      </div>
      {gated && <button className="btn" aria-label={`Show 2FA code for ${row.title}`} onClick={() => onReprompt(pass)}>Show</button>}
      {code && (
        <button
          className="flex items-center gap-2 rounded-md px-1 py-0.5 font-mono text-sm font-semibold hover:bg-[var(--surface-2)]"
          aria-label={`Copy 2FA code for ${row.title}`}
          title="Copy"
          onClick={async () => {
            try {
              await copySecret(code);
              setMessage("2FA code copied.");
            } catch {
              setMessage("Couldn't copy that.");
            }
          }}
        >
          {pretty}
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 36 36" className="shrink-0 -rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--surface-2)" strokeWidth="5" />
            <circle cx="18" cy="18" r="15" fill="none" stroke={left <= 5 ? "var(--danger)" : "var(--accent)"} strokeWidth="5" strokeDasharray={`${(left / period) * 94.2} 94.2`} />
          </svg>
          <span className="sr-only">{left} seconds left</span>
        </button>
      )}
    </div>
  );
}

type BookmarkRow = { id: string; title: string; url?: string; parent: string; pos: number };
const ROOT_NAMES: [string, string][] = [["root:bar", "Bookmarks bar"], ["root:other", "Other bookmarks"], ["root:menu", "Bookmarks menu"], ["root:mobile", "Mobile bookmarks"]];

/** Works from the vault, so it shows the same list in any browser, whether or not this one syncs. */
type BookmarkStatus = { on: boolean; granted: boolean; held?: unknown; at?: string; total?: number; failed?: number; error?: string; inBrowser?: number };

function BookmarksTab({ query }: { query: string }) {
  const [rows, setRows] = useState<BookmarkRow[] | null>(null);
  const [state, setState] = useState<BookmarkStatus | null>(null);
  const [problem, setProblem] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [path, setPath] = useState<{ id: string; title: string }[]>([]);
  const refresh = useCallback(async (sync: boolean) => {
    try {
      setSyncing(sync);
      const status = await call<BookmarkStatus>({ t: sync ? "bookmarkSyncNow" : "bookmarkState" });
      setState(status);
      setRows(await call<BookmarkRow[]>({ t: "bookmarkTree" }));
      setProblem("");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't read your bookmarks");
    } finally {
      setSyncing(false);
    }
  }, []);
  useEffect(() => {
    void refresh(false).then(() => refresh(true));
  }, [refresh]);
  if (problem) return <p role="alert" className="err">{problem}</p>;
  if (!rows || !state) return <p className="muted">Loading your bookmarks…</p>;
  const open = (b: BookmarkRow) => call({ t: "openBookmark", id: b.id }).then(() => window.close());
  const line = (b: BookmarkRow) => (
    <button key={b.id} className="row" aria-label={`Open bookmark ${b.title || b.url}`} title={b.url} onClick={() => open(b)}>
      <span className="text-[var(--text-muted)]"><Icon name="globe" /></span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{b.title || b.url}</span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{hostName(b.url)}</span>
      </span>
    </button>
  );
  const folder = (id: string, title: string) => (
    <button key={id} className="row" aria-label={`Open folder ${title}`} onClick={() => setPath([...path, { id, title }])}>
      <span className="text-[var(--text-muted)]"><Icon name="folder" /></span>
      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
      <span className="text-xs text-[var(--text-muted)]">{rows.filter((r) => r.parent === id).length}</span>
      <span className="text-[var(--text-muted)]"><Icon name="chevron" size={14} /></span>
    </button>
  );
  const notice = !state.on ? (
    <div data-testid="bookmarks-off" className="flex flex-col gap-2 rounded-lg bg-[var(--surface-1)] p-3 text-xs">
      <p>{rows.length ? "This browser isn't syncing bookmarks yet." : "Keep the same bookmarks in every browser, encrypted so your server can't read them."}</p>
      <button className="btn-primary" onClick={() => openPage("bookmarks")}>Turn on bookmark sync</button>
    </div>
  ) : state.held ? (
    <button data-testid="bookmarks-held" className="btn-primary" onClick={() => openPage("bookmarks")}>Bookmark sync has stopped to check with you</button>
  ) : (
    <div data-testid="bookmarks-status" className="flex flex-col gap-2 rounded-lg bg-[var(--surface-1)] p-3 text-xs">
      <p>
        {state.error ? <span className="err">Bookmarks didn't sync: {state.error}</span> : syncing ? "Syncing your bookmarks…" : state.at ? `Sync is on. Last synced ${new Date(state.at).toLocaleTimeString()}.` : "Sync is on, and waiting for its first run."}
        {state.inBrowser !== undefined && ` This browser has ${state.inBrowser} ${state.inBrowser === 1 ? "bookmark" : "bookmarks"}.`}
        {state.failed ? ` ${state.failed} couldn't be changed, and will be tried again.` : ""}
      </p>
      <div className="flex gap-2">
        <button className="btn flex-1" disabled={syncing} onClick={() => void refresh(true)}>Sync now</button>
        <button className="btn flex-1" onClick={() => openPage("bookmarks")}>Sync settings</button>
      </div>
    </div>
  );

  if (query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter((r) => r.url && words.every((w) => `${r.title} ${r.url}`.toLowerCase().includes(w))).slice(0, 100);
    return (
      <div className="flex flex-col">
        {hits.map(line)}
        {hits.length === 0 && <p className="muted">No bookmarks match that.</p>}
      </div>
    );
  }
  const at = path[path.length - 1];
  const here = at ? rows.filter((r) => r.parent === at.id).sort((a, b) => a.pos - b.pos) : [];
  return (
    <div className="flex flex-col gap-2">
      {notice}
      <div className="flex flex-col">
        {at ? (
          <>
            <button className="mb-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-muted)]" onClick={() => setPath(path.slice(0, -1))}><Icon name="back" size={14} /> <span className="truncate">{at.title}</span></button>
            {here.map((r) => (r.url !== undefined ? line(r) : folder(r.id, r.title)))}
            {here.length === 0 && <p className="muted">This folder's empty.</p>}
          </>
        ) : (
          <>
            {ROOT_NAMES.filter(([id]) => rows.some((r) => r.parent === id)).map(([id, title]) => folder(id, title))}
            {rows.length === 0 && state.on && !syncing && <p className="muted">No bookmarks yet. Add one in this browser, and it'll sync in a few seconds.</p>}
          </>
        )}
      </div>
    </div>
  );
}

const hostName = (url?: string) => {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const MORE_LINKS: { route: string; label: string; icon: keyof typeof PATHS }[] = [
  { route: "security", label: "Security check", icon: "shield" },
  { route: "shared", label: "Shared vaults", icon: "user" },
  { route: "sends", label: "Secure Send", icon: "external" },
  { route: "devices", label: "Devices", icon: "globe" },
  { route: "transfer", label: "Import and export", icon: "folder" },
  { route: "trash", label: "Trash", icon: "note" },
  { route: "settings", label: "Settings", icon: "menu" },
];

function MoreTab({ preview, setMessage }: { preview: boolean; setMessage: (m: string) => void }) {
  const [syncing, setSyncing] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        className="row"
        disabled={syncing}
        onClick={async () => {
          setSyncing(true);
          try {
            await call({ t: "sync" });
            setMessage("Synced.");
          } catch {
            setMessage("Couldn't reach your server. Your vault still works from this browser's copy.");
          }
          setSyncing(false);
        }}
      >
        <span className="text-[var(--text-muted)]"><Icon name="sync" /></span>
        <span className="flex-1 text-left">{syncing ? "Syncing…" : "Sync now"}</span>
      </button>
      {MORE_LINKS.map((l) => (
        <button key={l.route} className="row" onClick={() => openPage(l.route)}>
          <span className="text-[var(--text-muted)]"><Icon name={l.icon} /></span>
          <span className="flex-1 text-left">{l.label}</span>
          <span className="text-[var(--text-muted)]"><Icon name="external" size={13} /></span>
        </button>
      ))}
      {preview && <p className="muted mt-2"><span className="badge">Preview</span> Try it on low-value accounts first.</p>}
    </div>
  );
}

const AVATAR_TINTS = ["#D97757", "#3B82A0", "#6B8E4E", "#9B6BB3", "#B7791F", "#4F7D7A"];

function Avatar({ title }: { title: string }) {
  let n = 0;
  for (const ch of title) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-[#fff]" style={{ background: AVATAR_TINTS[n % AVATAR_TINTS.length] }}>{(title.trim()[0] ?? "?").toUpperCase()}</span>;
}

type OfferRow = { key: string; credentialId: string; title: string; userName: string; rpId: string; origin: string };

/** Passkeys a page is asking for right now, and if it isn't, a word on why nothing's happening.
 *  A page can start asking while this is open. */
function PasskeyRows({ tabId, setMessage }: { tabId: number; setMessage: (m: string) => void }) {
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const look = () =>
      call<{ offers: OfferRow[]; saved: string | null } | null>({ t: "pkOffers", tabId })
        .then((r) => {
          if (!live || !r) return;
          setOffers(r.offers);
          setSaved(r.saved);
        })
        .catch(() => undefined);
    void look();
    const t = setInterval(look, 1500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tabId]);
  return (
    <>
      {offers.map((o) => (
        <button
          key={`${o.key}:${o.credentialId}`}
          data-testid="passkey-offer"
          className="btn-primary"
          aria-label={`Sign in with a passkey as ${o.userName || o.title}`}
          onClick={async () => {
            const r = await call<{ ok: boolean; reason?: string }>({ t: "pkUseOffer", tabId, key: o.key, credentialId: o.credentialId });
            if (r.ok) window.close();
            else setMessage(r.reason === "busy" ? "A passkey window is already open." : "This page isn't asking for that passkey any more.");
          }}
        >
          Sign in with a passkey: {o.userName || o.title}
        </button>
      ))}
      {!offers.length && saved && (
        <p data-testid="passkey-saved" className="rounded-lg bg-[var(--surface-1)] p-2 text-xs">You have a passkey for {saved}, but this page isn't asking for one. Sites decide when they do: look for "Use a passkey", "Sign in with a passkey" or "Try another way".</p>
      )}
    </>
  );
}

type MailRow = { id: string; domain: string; ago: string; code: string | null; linkHost: string | null };

/** Codes and sign-in links from Promptly Mail. What's in an email is untrusted, so it's text here
 *  and nothing's filled or opened until it's clicked. Only mail from this page's own site gets a
 *  row. The setting is off by default, and then the background returns nothing. */
function MailRows({ tabId, setMessage }: { tabId: number; setMessage: (m: string) => void }) {
  const [rows, setRows] = useState<MailRow[]>([]);
  const [others, setOthers] = useState<string[]>([]);
  const [asking, setAsking] = useState<MailRow | null>(null);
  useEffect(() => {
    call<{ mail: MailRow[]; otherMail: string[] }>({ t: "mailForTab", tabId })
      .then((r) => {
        setRows(r.mail);
        setOthers(r.otherMail);
      })
      .catch(() => undefined);
  }, [tabId]);
  if (asking) {
    return (
      <div className="flex flex-col gap-1 text-xs" data-testid="mail-link-ask">
        <p>An email says it's from {asking.domain}, and has a sign-in link to {asking.linkHost}. Email senders can be forged. Only open it if you just asked for it.</p>
        <button className="btn-primary" onClick={() => setAsking(null)}>Don't open it</button>
        <button className="btn" onClick={async () => {
          const r = await call<{ ok: boolean }>({ t: "mailLinkOpen", tabId, id: asking.id, confirmed: true });
          setAsking(null);
          if (r.ok) window.close();
          else setMessage("To be safe, open that link from the email yourself.");
        }}>Open {asking.linkHost}</button>
      </div>
    );
  }
  if (!rows.length && !others.length) return null;
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="mail-rows">
      {rows.map((m) => (
        <div key={m.id} className="flex flex-col gap-1">
          {m.code && (
            <button className="btn" aria-label={`Fill code from ${m.domain}`} onClick={async () => {
              const r = await call<{ ok: boolean }>({ t: "mailCodeFill", tabId, id: m.id });
              if (r.ok) window.close();
              else setMessage("To be safe, type this one in yourself.");
            }}>Code from email: {m.code} (from {m.domain}, {m.ago})</button>
          )}
          {m.linkHost && (
            <button className="btn" aria-label={`Sign-in link from ${m.domain}`} onClick={() => setAsking(m)}>Sign-in link from {m.domain}? {m.ago}</button>
          )}
        </div>
      ))}
      {others.map((d) => <p key={d} className="muted">An email from {d} has a code. It isn't from this site, so it's not offered here.</p>)}
    </div>
  );
}

/** The same question as the bar on the page, here where a page can't cover it. */
function SaveOffer({ tabId }: { tabId: number }) {
  const [offer, setOffer] = useState<{ kind: "save" | "update"; username: string; host: string } | null>(null);
  useEffect(() => {
    call<typeof offer>({ t: "saveOfferFor", tabId }).then(setOffer).catch(() => undefined);
  }, [tabId]);
  if (!offer) return null;
  const answer = async (a: string) => {
    await call({ t: "saveAnswerFor", tabId, answer: a });
    setOffer(null);
  };
  return (
    <div data-testid="save-offer" className="flex flex-col gap-1 rounded border p-2 text-xs">
      <p className="font-medium">{offer.kind === "update" ? `Update your password for ${offer.host}?` : `Save this login for ${offer.host}?`}</p>
      {offer.username && <p>{offer.username}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => answer(offer.kind)}>{offer.kind === "update" ? "Update" : "Save"}</button>
        <button className="btn" onClick={() => answer("dismiss")}>Not now</button>
        <button className="btn" onClick={() => answer("never")}>Never for this site</button>
      </div>
    </div>
  );
}

function ItemRow({ row, onFill, onReprompt, setMessage, here = false }: { row: Row | Candidate; onFill: () => void; here?: boolean } & RowProps) {
  const { code, left, gated, pass } = useCode(row);
  const copyField = async (field: "username" | "password", reprompted = false) => {
    try {
      const r = await call<{ value?: string; reason?: string }>({ t: "secretField", id: row.id, field, reprompted });
      if (r.reason === "reprompt") return onReprompt(() => void copyField(field, true));
      if (r.reason === "fill-only") return setMessage("You can fill this one, but its password stays hidden.");
      if (!r.value) return setMessage(`This item has no ${field}.`);
      if (field === "password") await copySecret(r.value);
      else await navigator.clipboard.writeText(r.value);
      setMessage(`${field === "password" ? "Password" : "Username"} copied.`);
    } catch {
      setMessage("Couldn't copy that.");
    }
  };
  return (
    <div className="row group !cursor-default">
      <Avatar title={row.title} />
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onFill} aria-label={`Fill ${row.title}`} title="Fill on this page">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{row.title}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{row.username || row.kind}</span>
        </span>
        {here && <span aria-hidden="true" className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-0.5 text-xs font-medium text-[#fff] group-hover:hidden group-focus-within:hidden">Fill</span>}
      </button>
      {row.hasTotp && gated && (
        <button className="text-xs" aria-label={`Show 2FA code for ${row.title}`} onClick={() => onReprompt(pass)}>Show 2FA</button>
      )}
      {code && (
        <button
          className="font-mono text-xs"
          aria-label={`Copy 2FA code for ${row.title}`}
          title={`${left}s left`}
          onClick={async () => {
            try {
              await copySecret(code);
              setMessage("2FA code copied.");
            } catch {
              setMessage("Couldn't copy that.");
            }
          }}
        >
          {code} <span className="text-[var(--text-muted)]">{left}</span>
        </button>
      )}
      <span className="hidden items-center group-focus-within:flex group-hover:flex">
        {row.kind === "login" && (
          <>
            <button className="icon-btn" aria-label={`Copy username for ${row.title}`} title="Copy username" onClick={() => void copyField("username")}><Icon name="user" size={14} /></button>
            <button className="icon-btn" aria-label={`Copy password for ${row.title}`} title="Copy password" onClick={() => void copyField("password")}><Icon name="key" size={14} /></button>
          </>
        )}
        <button className="icon-btn" aria-label={`Open ${row.title} in the vault`} title="Open in the vault" onClick={() => openPage(`item/${row.id}`)}><Icon name="external" size={14} /></button>
      </span>
    </div>
  );
}

function ConfirmBox({ outcome, onYes, onNo }: { outcome: FillOutcome; onYes: () => void; onNo: () => void }) {
  const o = outcome as { reason: string; origin?: string; lookalike?: string; frames?: string[]; fills?: string[] };
  const text = useMemo(() => {
    switch (o.reason) {
      case "confirm-origin":
        return `This will fill a form from ${o.origin}. That isn't the site saved with this login. Only go on if you trust it.`;
      case "confirm-downgrade":
        return `${o.origin} isn't encrypted (http), and this login was saved for https. Anyone on the network could read it.`;
      case "confirm-lookalike":
        return `${o.origin} looks like ${o.lookalike}, but it's a different site. This could be phishing.`;
      case "confirm-card":
        return o.frames?.length
          ? `Fill your card or address details into this page? Some boxes are in frames from ${o.frames.join(", ")}, which will get what goes in those boxes. Only go on if you trust them.`
          : "Fill your card or address details into this page?";
      default:
        return "Are you sure?";
    }
  }, [o]);
  return (
    <div role="alertdialog" className="flex flex-col gap-2 rounded border p-2">
      <p className="err">{text}</p>
      {!!o.fills?.length && <p data-testid="will-fill" className="text-xs">It will fill: {o.fills.join(", ")}.</p>}
      <div className="flex gap-2">
        <button className="btn-primary" onClick={onNo}>Don't fill</button>
        <button className="btn" onClick={onYes}>Fill anyway</button>
      </div>
    </div>
  );
}

function RepromptBox({ onPass, onCancel }: { onPass: () => void; onCancel: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-col gap-2 rounded border p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await call<boolean>({ t: "check", password: pw })) onPass();
        else setError("That isn't your master password.");
      }}
    >
      <p className="font-medium">This item asks for your master password.</p>
      <input className="input" type="password" aria-label="Master password again" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
      {error && <p className="err">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" type="submit">Continue</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Generator({ host }: { host?: string }) {
  const [mode, setMode] = useState<"password" | "passphrase" | "pin" | "username">("password");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const again = useCallback(() => {
    setNote("");
    call<{ password: string }>({ t: "generate", host, mode }).then((r) => setValue(r.password));
  }, [host, mode]);
  useEffect(again, [again]);
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="What to make" className="grid grid-cols-4 gap-1 rounded-lg bg-[var(--surface-1)] p-1 text-xs">
        {(["password", "passphrase", "pin", "username"] as const).map((m) => (
          <button key={m} aria-pressed={mode === m} className={`rounded-md py-1 font-medium capitalize ${mode === m ? "bg-[var(--surface)] shadow-sm" : "text-[var(--text-muted)]"}`} onClick={() => setMode(m)}>{m === "pin" ? "PIN" : m}</button>
        ))}
      </div>
      <code data-testid="generated" className="min-h-[56px] break-all rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-sm">{value}</code>
      {host && mode === "password" && <p className="text-xs text-[var(--text-muted)]">Follows {host}'s password rules if we know them.</p>}
      <div className="grid grid-cols-2 gap-2">
        <button className="btn" onClick={again}>Again</button>
        <button
          className="btn-primary"
          onClick={async () => {
            try {
              await copySecret(value);
              setNote("Copied.");
            } catch {
              setNote("Couldn't copy that.");
            }
          }}
        >
          Copy
        </button>
      </div>
      {note && <p role="status" className="text-xs">{note}</p>}
      <PlusAddress host={host} />
    </div>
  );
}

/** me+shop@example.com, to see later who leaked or sold an address (plan 5.11). */
function PlusAddress({ host }: { host?: string }) {
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    call<{ email: string | null }>({ t: "plusBase" }).then((r) => r.email && setEmail(r.email));
  }, []);
  useEffect(() => {
    if (!email) return setAddress(null);
    call<{ address: string | null }>({ t: "plusAddress", email, host }).then((r) => setAddress(r.address));
  }, [email, host]);
  return (
    <div className="flex flex-col gap-1 border-t pt-2 text-xs">
      <label htmlFor="plus-email" className="font-medium">An email address for this site</label>
      <input id="plus-email" className="input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      {address && <code data-testid="plus-address" className="break-all font-mono">{address}</code>}
      {address && <button className="btn" onClick={() => navigator.clipboard.writeText(address)}>Copy address</button>}
      <p className="text-[var(--text-muted)]">Only works where your email provider allows a plus in the address.</p>
    </div>
  );
}

function AddLogin({ tab, onDone }: { tab: chrome.tabs.Tab | null; onDone: () => void }) {
  const host = pageHost(tab?.url ?? "") ?? "";
  const [title, setTitle] = useState(host.replace(/^www\./, ""));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    call<{ password: string }>({ t: "generate", host }).then((r) => setPassword((now) => now || r.password));
  }, [host]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await call({ t: "addLogin", title, url: tab?.url ? new URL(tab.url).origin : "", username, password });
    onDone();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded border p-2">
      <input className="input" aria-label="Name" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="input" aria-label="Username" placeholder="Username or email" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input className="input font-mono" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn-primary" type="submit">Save</button>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(
  <Fragment>
    <Popup />
  </Fragment>,
);
