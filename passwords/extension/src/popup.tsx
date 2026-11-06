// The toolbar popup: this site's logins first, then search, 2FA codes, a generator.
// This is the safest way to fill: a page can't touch or cover it.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { DEFAULT_PASSWORD, generateForSite } from "../../../frontend/src/passwords/core/generator";
import { hostOf } from "../../../frontend/src/passwords/core/match";
import { ext, type Candidate, type FillOutcome, type StateOut } from "./rpc";

declare const __TEST_BUILD__: boolean;

type Row = { id: string; title: string; username: string; kind: string; hasTotp: boolean; reprompt: boolean };

async function call<T>(m: unknown): Promise<T> {
  const r = (await ext.runtime.sendMessage(m)) as { ok: boolean; r?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "No answer from the extension");
  return r.r as T;
}

const OPEN_VAULT = () => ext.tabs.create({ url: ext.runtime.getURL("vault.html") });

function Popup() {
  const [state, setState] = useState<StateOut | null>(null);
  const reload = useCallback(() => call<StateOut>({ t: "state" }).then(setState), []);
  useEffect(() => {
    reload();
  }, [reload]);
  if (!state) return <p className="p-3 text-sm">Loading…</p>;
  if (!state.connected || !state.hasKit) {
    return (
      <div className="flex flex-col gap-2 p-3 text-sm">
        <p className="font-semibold">Connect to your Promptly</p>
        <p>Set up this browser, one time, in a full tab.</p>
        <button className="btn-primary" onClick={OPEN_VAULT}>Set up</button>
      </div>
    );
  }
  if (!state.unlocked) return <UnlockView onDone={reload} preview={state.preview} />;
  return <Open state={state} onLock={reload} />;
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
    <form onSubmit={submit} className="flex flex-col gap-2 p-3 text-sm">
      <p className="font-semibold">Unlock your vault {preview && <span className="badge">Preview</span>}</p>
      <input className="input" type="password" aria-label="Master password" placeholder="Master password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {error && <p className="err">{error}</p>}
      <PinLine onDone={onDone} onError={setError} />
      <button className="btn-primary" type="submit" disabled={busy || !pw}>{busy ? "Unlocking…" : "Unlock"}</button>
    </form>
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
                await call({ t: "addTotp", itemId: matches[0].id, uri, title: matches[0].title, url: tab.url ?? "" });
                setMessage(`Added 2FA to ${matches[0].title}.`);
                setUri(null);
              } catch (e) { setMessage(e instanceof Error ? e.message : "Couldn't add it"); }
            }}>Add to {matches[0].title}</button>}
            <button className="btn" onClick={async () => {
              try {
                const title = hostOf(tab.url ?? "")?.replace(/^www\./, "") ?? "2FA code";
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
          </>
        )}
      </div>
    </details>
  );
}

function Open({ state, onLock }: { state: StateOut; onLock: () => void }) {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [matches, setMatches] = useState<Candidate[]>([]);
  const [lookalike, setLookalike] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<{ itemId: string; outcome: FillOutcome; prior: object } | null>(null);
  const [view, setView] = useState<"list" | "generate" | "add">("list");
  const [reprompt, setReprompt] = useState<{ itemId: string; prior: object } | null>(null);

  useEffect(() => {
    (async () => {
      // A test build can be opened in a tab of its own and aimed at another tab.
      const aimed = __TEST_BUILD__ ? Number(new URLSearchParams(location.search).get("tab")) : 0;
      const t = aimed ? await ext.tabs.get(aimed) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
      setTab(t ?? null);
      if (t?.id !== undefined) {
        const r = await call<{ candidates: Candidate[]; lookalike: string | null }>({ t: "matches", tabId: t.id });
        setMatches(r.candidates);
        setLookalike(r.lookalike);
      }
    })();
  }, []);

  useEffect(() => {
    if (!q) return setRows([]);
    call<Row[]>({ t: "list", query: q }).then(setRows);
  }, [q]);

  const doFill = async (itemId: string, extra: object = {}) => {
    if (tab?.id === undefined) return;
    setMessage("");
    const r = await call<FillOutcome>({ t: "fill", tabId: tab.id, itemId, ...extra });
    if (r.ok) {
      setMessage(r.totpCopied ? "Filled. 2FA code copied." : "Filled.");
      setTimeout(() => window.close(), 700);
      return;
    }
    if (r.reason === "reprompt") return setReprompt({ itemId, prior: extra });
    if (r.reason.startsWith("confirm")) return setConfirm({ itemId, outcome: r, prior: extra });
    setMessage(r.reason === "no-fields" ? "No fields to fill on this page." : r.reason === "locked" ? "Locked." : "Couldn't fill this page.");
  };

  const answer = () => {
    if (!confirm) return;
    const o = confirm.outcome as FillOutcome & { reason: string; origin?: string };
    const more: Record<string, unknown> = { ...confirm.prior };
    if (o.reason === "confirm-origin") more.confirmOrigin = o.origin;
    if (o.reason === "confirm-downgrade") more.confirmDowngrade = true;
    if (o.reason === "confirm-lookalike") more.confirmLookalike = true;
    if (o.reason === "confirm-card") more.confirmCard = true;
    setConfirm(null);
    doFill(confirm.itemId, more);
  };

  const list = q ? rows : [];
  return (
    <div className="flex w-[340px] flex-col gap-2 p-2 text-sm">
      <div className="flex items-center gap-2">
        <input className="input" aria-label="Search your vault" placeholder="Search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" aria-label="Generator" title="Generator" onClick={() => setView(view === "generate" ? "list" : "generate")}>⚙</button>
        <button className="btn" aria-label="Add a login" title="Add a login" onClick={() => setView(view === "add" ? "list" : "add")}>＋</button>
      </div>
      {state.preview && <p className="text-xs"><span className="badge">Preview</span> Try it on low-value accounts first.</p>}
      {lookalike && <p className="err">This site looks like {lookalike}, but it isn't. Be careful.</p>}
      {message && <p role="status" className="text-xs font-medium">{message}</p>}
      <PageTools tab={tab} matches={matches} setMessage={setMessage} />
      {confirm && <ConfirmBox outcome={confirm.outcome} onYes={answer} onNo={() => setConfirm(null)} />}
      {reprompt && (
        <RepromptBox
          onPass={() => {
            const r = reprompt;
            setReprompt(null);
            doFill(r.itemId, { ...r.prior, reprompted: true });
          }}
          onCancel={() => setReprompt(null)}
        />
      )}

      {view === "generate" && <Generator host={hostOf(tab?.url ?? "") ?? undefined} />}
      {view === "add" && <AddLogin tab={tab} onDone={() => setView("list")} />}

      {view === "list" && (
        <div className="flex flex-col">
          {!q && <p className="section">This site</p>}
          {!q && matches.length === 0 && <p className="muted">Nothing saved for this site.</p>}
          {(q ? list : matches).map((m) => (
            <ItemRow key={m.id} row={m} onFill={() => doFill(m.id)} />
          ))}
          {q && list.length === 0 && <p className="muted">Nothing matches that.</p>}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <button className="link" onClick={OPEN_VAULT}>Open vault</button>
        <button className="link" onClick={async () => { await call({ t: "lock" }); onLock(); }}>Lock</button>
      </div>
    </div>
  );
}

function ItemRow({ row, onFill }: { row: Row | Candidate; onFill: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!row.hasTotp) return;
    let live = true;
    const tick = async () => {
      const r = await call<{ code: string; period: number } | null>({ t: "totp", id: row.id });
      if (live && r) {
        setCode(r.code);
        setLeft(r.period - (Math.floor(Date.now() / 1000) % r.period));
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [row.id, row.hasTotp]);
  return (
    <div className="flex items-center gap-2 rounded px-1 py-1.5 hover:bg-[var(--surface-1)]">
      <button className="min-w-0 flex-1 text-left" onClick={onFill} aria-label={`Fill ${row.title}`}>
        <span className="block truncate font-medium">{row.title}</span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{row.username || row.kind}</span>
      </button>
      {code && (
        <button className="font-mono text-xs" aria-label={`Copy 2FA code for ${row.title}`} title={`${left}s left`} onClick={() => navigator.clipboard.writeText(code)}>
          {code} <span className="text-[var(--text-muted)]">{left}</span>
        </button>
      )}
    </div>
  );
}

function ConfirmBox({ outcome, onYes, onNo }: { outcome: FillOutcome; onYes: () => void; onNo: () => void }) {
  const o = outcome as { reason: string; origin?: string; lookalike?: string };
  const text = useMemo(() => {
    switch (o.reason) {
      case "confirm-origin":
        return `This will fill a form from ${o.origin}. That isn't the site saved with this login. Only go on if you trust it.`;
      case "confirm-downgrade":
        return `${o.origin} isn't encrypted (http), and this login was saved for https. Anyone on the network could read it.`;
      case "confirm-lookalike":
        return `${o.origin} looks like ${o.lookalike}, but it's a different site. This could be phishing.`;
      case "confirm-card":
        return "Fill your card or address details into this page?";
      default:
        return "Are you sure?";
    }
  }, [o]);
  return (
    <div role="alertdialog" className="flex flex-col gap-2 rounded border p-2">
      <p className="err">{text}</p>
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
  const [value, setValue] = useState("");
  const again = useCallback(() => setValue(generateForSite(host, DEFAULT_PASSWORD)), [host]);
  useEffect(again, [again]);
  return (
    <div className="flex flex-col gap-2 rounded border p-2">
      <code data-testid="generated" className="break-all font-mono text-xs">{value}</code>
      <div className="flex gap-2">
        <button className="btn" onClick={again}>Again</button>
        <button className="btn-primary" onClick={() => navigator.clipboard.writeText(value)}>Copy</button>
      </div>
    </div>
  );
}

function AddLogin({ tab, onDone }: { tab: chrome.tabs.Tab | null; onDone: () => void }) {
  const host = hostOf(tab?.url ?? "") ?? "";
  const [title, setTitle] = useState(host.replace(/^www\./, ""));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(() => generateForSite(host));
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
