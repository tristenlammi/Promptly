// The full vault inside the extension (tab and side panel), and the first-run connect
// flow: enter a server, grant that one host, approve in a signed-in tab, then get the
// Secret Key onto this browser as any new device does.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { VaultApi } from "../../../frontend/src/passwords/core/api";
import { fromB64u } from "../../../frontend/src/passwords/core/bytes";
import { IdbStore } from "../../../frontend/src/passwords/core/store";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { Button, Callout, errorText, inputClass, Label, Spinner } from "../../../frontend/src/passwords/ui/kit";
import type { Platform } from "../../../frontend/src/passwords/ui/platform";
import { JoinDevice } from "../../../frontend/src/passwords/ui/Unlock";
import { VaultApp } from "../../../frontend/src/passwords/ui/VaultApp";
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
  const [server, setServer] = useState("");
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
      const started = await api.connectStart(deviceName(), engine);
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

  const platform = useMemo<Platform | null>(() => {
    if (!connected) return null;
    const api = new VaultApi(connected.server, () => connected.token);
    return {
      kind: engine,
      baseUrl: connected.server,
      api,
      store,
      copy: (text) => navigator.clipboard.writeText(text),
      clearClipboard: () => navigator.clipboard.writeText(""),
      restore: async () => {
        const s = await call<{ unlock: string | null; session: string | null }>({ t: "session" });
        return s.unlock ? { secret: fromB64u(s.unlock), session: s.session } : null;
      },
      unlock: (password: string) => call({ t: "unlock", password }),
      lock: () => call({ t: "lock" }),
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
