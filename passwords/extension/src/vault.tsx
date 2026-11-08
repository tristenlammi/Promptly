// The full vault inside the extension (tab and side panel), and the first-run connect
// flow: enter a server, grant that one host, approve in a signed-in tab, then get the
// Secret Key onto this browser as any new device does.
import { LockSetting } from "./lockchoice";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { VaultApi } from "../../../frontend/src/passwords/core/api";
import { b64u, fromB64u } from "../../../frontend/src/passwords/core/bytes";
import { IdbStore } from "../../../frontend/src/passwords/core/store";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { Button, Callout, errorText, inputClass, Label, Spinner } from "../../../frontend/src/passwords/ui/kit";
import type { Platform } from "../../../frontend/src/passwords/ui/platform";
import { JoinDevice } from "../../../frontend/src/passwords/ui/Unlock";
import { VaultApp } from "../../../frontend/src/passwords/ui/VaultApp";
import { nativeHello } from "./native";
import { BrowserSyncSettings } from "./syncsettings";
import { ext, type StateOut } from "./rpc";

declare const __ENGINE__: string;
declare const __TEST_BUILD__: boolean;

const engine = __ENGINE__ === "firefox" ? "firefox" : "chromium";

async function call<T>(m: unknown): Promise<T> {
  const r = (await ext.runtime.sendMessage(m)) as { ok: boolean; r?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "No answer from the extension");
  return r.r as T;
}

const store = new IdbStore("promptly-vault");
let changedTimer: ReturnType<typeof setTimeout> | null = null;
let lockingHere = false;

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Vivaldi/.test(ua) ? "Vivaldi" : /OPR\//.test(ua) ? "Opera" : "Chrome";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser} extension${os ? ` on ${os}` : ""}`;
}

function normaliseServer(input: string): string | null {
  try {
    const u = new URL(input.includes("://") ? input : `https://${input}`);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|.*\.localhost)$/.test(u.hostname))) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function Connect({ onDone }: { onDone: () => void }) {
  // Only ever a suggestion, from the page in front when Set up was clicked. It's on screen to check.
  const suggested = new URLSearchParams(location.search).get("server") ?? "";
  const [server, setServer] = useState(suggested);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const origin = normaliseServer(server);
    if (!origin) return setError("That doesn't look like a server address. It needs https, except on your own machine.");
    // Must happen inside the click: browsers refuse it otherwise.
    const granted = await ext.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return setError("The browser needs permission to talk to that server.");
    try {
      const api = new VaultApi(origin, () => null);
      const started = await api.connectStart(deviceName(), engine, ["vault", "mail_codes"]);
      setCode(started.code);
      setWaiting(true);
      await ext.tabs.create({ url: `${origin}/passwords/connect?code=${started.code}` });
      const until = Date.now() + 9 * 60 * 1000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await api.connectPoll(started.id, started.poll_secret);
        if (r.status === "approved" && r.token) {
          await call({ t: "connected", serverUrl: origin, token: r.token, deviceId: r.device_id, userId: r.user_id });
          return onDone();
        }
        if (r.status === "denied") {
          setWaiting(false);
          return setError("That was refused on the server.");
        }
      }
      setWaiting(false);
      setError("That timed out. Try again.");
    } catch (err) {
      setWaiting(false);
      setError(errorText(err));
    }
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4 text-sm text-[var(--text)]">
      <h1 className="text-xl font-semibold">Connect to your Promptly</h1>
      {!waiting && (
        <form onSubmit={start} className="flex flex-col gap-3">
          <Label text="Your server's address" hint="The address you use for Promptly, for example https://home.example.org">
            <input className={inputClass} autoFocus value={server} onChange={(e) => setServer(e.target.value)} />
          </Label>
          {suggested && <p className="text-[var(--text-muted)]">This came from the page you were on. Make sure it's your own Promptly: this is where your encrypted vault will sync.</p>}
          <p className="text-[var(--text-muted)]">The browser will ask to let this extension talk to that one server. Then you'll approve this browser in a Promptly tab.</p>
          {error && <Callout kind="danger">{error}</Callout>}
          <Button kind="primary" type="submit">Connect</Button>
        </form>
      )}
      {waiting && (
        <>
          <p>A Promptly tab opened. Sign in if you need to, check it shows the code <code data-testid="connect-code" className="font-mono">{code}</code>, and approve it.</p>
          <Spinner label="Waiting for your approval…" />
        </>
      )}
    </main>
  );
}

function Access({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<"ask" | "busy">("ask");
  const all = async () => {
    setState("busy");
    const granted = await ext.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    await call({ t: "setAccess", onClickOnly: !granted });
    onDone();
  };
  const onClick = async () => {
    await call({ t: "setAccess", onClickOnly: true });
    onDone();
  };
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4 text-sm text-[var(--text)]">
      <h1 className="text-xl font-semibold">How should filling work?</h1>
      <p>To offer your logins on sign-in pages, the extension needs to read those pages for their forms. It reads the structure only, sends nothing anywhere, and your server never learns which sites you visit.</p>
      <Button kind="primary" disabled={state === "busy"} onClick={all}>On all sites (best filling)</Button>
      <Button disabled={state === "busy"} onClick={onClick}>Only when I click the toolbar button</Button>
      <p className="text-[var(--text-muted)]">"Only when I click" is the safest: pages can't trick you into a click they can't see. Filling takes one more click. You can change this in Settings.</p>
    </main>
  );
}

/** Bookmarks in this browser, kept the same as every other browser this vault is connected in. */
function BookmarkSettings() {
  type Shown = { on: boolean; granted: boolean; at?: string; total?: number; unsynced?: number; failed?: number; held?: { fromBrowser: number; fromVault: number }; error?: string; inBrowser?: number };
  const [s, setS] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const load = () => call<Shown>({ t: "bookmarkState" }).then(setS);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const toggle = async (on: boolean) => {
    // Has to be asked for while the click still counts, so before anything else happens.
    const asked = on ? ext.permissions.request({ permissions: ["bookmarks"] }) : Promise.resolve(true);
    const granted = await asked.catch(() => false);
    setProblem("");
    if (!granted) return setProblem("The browser didn't give permission to reach your bookmarks, so sync stays off.");
    setBusy(true);
    try {
      const r = await call<{ ok: boolean; error?: string }>({ t: "setBookmarks", on });
      if (!r.ok) setProblem(r.error ?? "Couldn't change that.");
      if (!on) await ext.permissions.remove({ permissions: ["bookmarks"] }).catch(() => false);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const answer = async (go: boolean) => {
    setBusy(true);
    try {
      await call({ t: "bookmarkAnswer", go });
      await load();
    } finally {
      setBusy(false);
    }
  };
  const saveCopy = async () => {
    const html = await call<string | null>({ t: "bookmarkExport" });
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "bookmarks.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  return (
    <div data-testid="bookmark-settings" className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={s.on} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Keep my bookmarks the same in every browser
      </label>
      <p className="text-xs text-[var(--text-muted)]">
        Bookmarks are encrypted in your vault, so your server can't read them. Turn this on in each browser you use. They sync about once a minute while the vault's unlocked, and catch up when you next unlock. The first sync only adds: nothing in this browser is removed, and exact duplicates in a folder become one. If you also use a browser's own bookmark sync, turn that off to avoid surprises.
      </p>
      {problem && <Callout kind="danger">{problem}</Callout>}
      {s.on && !s.held && (
        <p role="status" data-testid="bookmark-status" className="text-xs text-[var(--text-muted)]">
          {s.at ? `${s.total ?? 0} bookmarks and folders, last synced ${new Date(s.at).toLocaleTimeString()}.` : "Waiting for the first sync."}
          {s.inBrowser !== undefined ? ` This browser has ${s.inBrowser}.` : ""}
          {s.unsynced ? ` ${s.unsynced} stay in this browser only, because they aren't web addresses.` : ""}
          {s.failed ? ` ${s.failed} couldn't be changed in this browser, and will be tried again.` : ""}
          {s.error ? ` Last problem: ${s.error}` : ""}
        </p>
      )}
      {s.on && s.held && (
        <Callout kind="warn">
          <div data-testid="bookmark-held" className="flex flex-col gap-2">
            <p>
              Bookmark sync has stopped to check with you. It would delete {s.held.fromBrowser ? `${s.held.fromBrowser} from your vault and every other browser, because they're gone from this one` : ""}
              {s.held.fromBrowser && s.held.fromVault ? ", and " : ""}
              {s.held.fromVault ? `${s.held.fromVault} from this browser, because they're gone from your vault` : ""}. If you didn't mean to delete that many, keep them.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button small kind="primary" disabled={busy} onClick={() => void answer(false)}>Keep them everywhere</Button>
              <Button small disabled={busy} onClick={() => void answer(true)}>Yes, delete them</Button>
            </div>
          </div>
        </Callout>
      )}
      {s.granted && <Button small onClick={() => void saveCopy()}>Save a copy of this browser's bookmarks</Button>}
    </div>
  );
}

/** What only the extension has. Mail codes are opt-in even though the device may read them. */
type ExtShown = { onClickOnly: boolean; mailCodes: boolean; pin: boolean; clipCheck: boolean };

function useExtSettings() {
  const [s, setS] = useState<ExtShown | null>(null);
  const load = () => call<ExtShown>({ t: "extSettings" }).then(setS);
  useEffect(() => {
    void load();
  }, []);
  return { s, load };
}

function ExtFilling() {
  const { s, load } = useExtSettings();
  const [error, setError] = useState("");
  if (!s) return null;
  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.mailCodes}
            onChange={async (e) => {
              await call({ t: "setMailCodes", on: e.target.checked });
              await load();
            }}
          />
          Offer codes and sign-in links from Promptly Mail on sign-in pages
        </label>
        <p className="text-xs text-[var(--text-muted)]">Which ones match the page is worked out here. The page's address isn't sent.</p>
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.onClickOnly}
            onChange={(e) => {
              setError("");
              const onClickOnly = e.target.checked;
              // Turning this off needs every site, and the browser only asks inside the click.
              const asked = onClickOnly ? Promise.resolve(true) : ext.permissions.request({ origins: ["https://*/*", "http://*/*"] });
              void asked.then(async (granted) => {
                if (granted) await call({ t: "setAccess", onClickOnly });
                else setError("The browser didn't give the extension access to all sites, so filling stays on click.");
                await load();
              });
            }}
          />
          Only fill when I click the toolbar button
        </label>
        <p className="text-xs text-[var(--text-muted)]">Sites' passkey requests then go to your browser's own passkeys, not your vault.</p>
      </div>
      {error && <Callout kind="danger">{error}</Callout>}
    </div>
  );
}

function ExtClipboard() {
  const { s, load } = useExtSettings();
  if (!s) return null;
  return (
    <div className="flex flex-col gap-1 text-sm text-[var(--text)]">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.clipCheck}
          onChange={(e) => {
            const on = e.target.checked;
            const asked = on ? ext.permissions.request({ permissions: ["clipboardRead"] }) : ext.permissions.remove({ permissions: ["clipboardRead"] });
            void asked.catch(() => false).then(load);
          }}
        />
        Don't clear the clipboard if I've copied something else since
      </label>
      <p className="text-xs text-[var(--text-muted)]">The browser has to let the extension read your clipboard for this.</p>
    </div>
  );
}

function ExtPin() {
  const { s, load } = useExtSettings();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  if (!s) return null;
  return (
    <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
      {s.pin ? (
        <Button
          small
          className="w-fit"
          onClick={async () => {
            await call({ t: "setPin", pin: null });
            await load();
          }}
        >
          Remove my PIN
        </Button>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Label text="A short PIN for this browser" hint="Works until the browser closes, and five wrong tries remove it. Weaker than your master password.">
            <input className={inputClass} inputMode="numeric" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Label>
          <Button
            small
            disabled={!pin}
            onClick={async () => {
              setError("");
              try {
                await call({ t: "setPin", pin });
                setPin("");
                await load();
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            Set PIN
          </Button>
        </div>
      )}
      {error && <Callout kind="danger">{error}</Callout>}
    </div>
  );
}

function Root() {
  const [state, setState] = useState<StateOut | null>(null);
  const [step, setStep] = useState<"load" | "connect" | "noaccount" | "join" | "access" | "vault">("load");
  const [connected, setConnected] = useState<{ server: string; token: string } | null>(null);

  const reload = async () => {
    const s = await call<StateOut>({ t: "state" });
    setState(s);
    if (!s.connected) return setStep("connect");
    const server = (await store.getMeta<string>("server_url"))!;
    const token = (await store.getMeta<string>("device_token"))!;
    setConnected({ server, token });
    const client = new VaultClient(new VaultApi(server, () => token), store, engine);
    if (!(await client.hasDeviceKit())) {
      try {
        const pre = await client.api.prelogin();
        return setStep(pre.exists ? "join" : "noaccount");
      } catch {
        return setStep("join");
      }
    }
    const seen = await store.getMeta<boolean>("access_asked");
    // Chromium's test build is granted site access up front, since nothing can click
    // its permission prompt. Firefox's can answer, so it walks the real path.
    if (!seen && !(__TEST_BUILD__ && engine === "chromium")) return setStep("access");
    setStep("vault");
  };

  useEffect(() => {
    reload();
  }, []);

  // Using this page counts as using the vault, so the background's auto-lock waits. It's
  // told at most every 20 seconds, which is plenty next to a timer in minutes.
  useEffect(() => {
    let last = 0;
    const active = () => {
      const now = Date.now();
      if (now - last < 20_000) return;
      last = now;
      call({ t: "activity" }).catch(() => undefined);
    };
    const events = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, active, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, active));
  }, []);

  // Locked from somewhere else: the popup, the timer, the machine going to sleep. This
  // page holds keys of its own, so it starts over and comes back locked.
  useEffect(() => {
    const listener = (m: { t?: string }) => {
      if (m?.t === "locked" && !lockingHere) location.reload();
    };
    ext.runtime.onMessage.addListener(listener);
    return () => ext.runtime.onMessage.removeListener(listener);
  }, []);

  const platform = useMemo<Platform | null>(() => {
    if (!connected) return null;
    const api = new VaultApi(connected.server, () => connected.token);
    const bridge = nativeHello();
    return {
      kind: engine,
      baseUrl: connected.server,
      api,
      store,
      lockControls: <LockSetting />,
      pinControls: <ExtPin />,
      fillControls: <ExtFilling />,
      clipboardControls: <ExtClipboard />,
      bookmarkControls: <BookmarkSettings />,
      browserSyncControls: <BrowserSyncSettings />,
      // Through the desktop app's host, where it's installed and has registered this
      // extension. Otherwise it reports it's not available, and nothing's offered.
      hello: {
        ...bridge,
        unlock: async () => {
          const secret = await bridge.unlock();
          if (secret) await call({ t: "unlockWithSecret", secret: b64u(secret) });
          return secret;
        },
      },
      // The background keeps time for sensitive copies, so they clear with this page closed.
      copy: async (text, sensitive) => {
        await navigator.clipboard.writeText(text);
        if (sensitive) await call({ t: "clipWatch", text });
      },
      clearClipboard: async () => {
        await call({ t: "clipClear" });
      },
      restore: async () => {
        const s = await call<{ unlock: string | null; session: string | null }>({ t: "session" });
        return s.unlock ? { secret: fromB64u(s.unlock), session: s.session } : null;
      },
      unlock: (password: string) => {
        lockingHere = false;
        return call({ t: "unlock", password });
      },
      lock: () => {
        lockingHere = true;
        // Only for this one. A lock from anywhere else later on still has to bring the page back.
        return call({ t: "lock" }).finally(() => {
          lockingHere = false;
        });
      },
      // The background holds its own secret, made from the old password. If it can't get a new
      // one, this browser asks for the password rather than carrying on with a stale one.
      rekeyed: (password) => call({ t: "unlock", password }).catch(() => call({ t: "lock" })),
      notifyChanged: () => {
        // Now, in case this page closes straight after a save, and once more when a
        // burst of changes has settled.
        call({ t: "sync" }).catch(() => undefined);
        if (changedTimer) clearTimeout(changedTimer);
        changedTimer = setTimeout(() => call({ t: "sync" }).catch(() => undefined), 500);
      },
      subscribeChanged: (cb) => {
        const listener = (m: { t?: string }) => {
          if (m?.t === "vaultChanged") cb();
        };
        ext.runtime.onMessage.addListener(listener);
        return () => ext.runtime.onMessage.removeListener(listener);
      },
    };
  }, [connected]);

  if (step === "load" || !state) return <main className="flex min-h-[100dvh] items-center justify-center"><Spinner label="Loading…" /></main>;
  if (step === "connect") return <Connect onDone={reload} />;
  if (step === "noaccount" && connected) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4 text-sm text-[var(--text)]">
        <h1 className="text-xl font-semibold">Set up your vault first</h1>
        <p>Your Promptly account has no vault yet. Make one on your server, then come back here.</p>
        <Button kind="primary" onClick={() => ext.tabs.create({ url: `${connected.server}/passwords` })}>Open Promptly</Button>
        <Button onClick={reload}>I've done that</Button>
      </main>
    );
  }
  if (step === "join" && connected) {
    const client = new VaultClient(new VaultApi(connected.server, () => connected.token), store, engine);
    return <JoinDevice vault={client} deviceName={deviceName()} onReady={async () => { await client.lock(); await reload(); }} />;
  }
  if (step === "access") {
    return (
      <Access
        onDone={async () => {
          await store.setMeta("access_asked", true);
          reload();
        }}
      />
    );
  }
  return platform ? <VaultApp platform={platform} /> : null;
}

createRoot(document.getElementById("root")!).render(<Root />);
