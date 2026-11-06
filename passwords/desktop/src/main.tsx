// The desktop app's main window: first-run connect flow, then the shared vault UI on a
// Windows `Platform`. Mirrors the extension's vault.tsx. Connect happens by device token, and
// this page never holds the token after handing it to Rust.
import { listen } from "@tauri-apps/api/event";
import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ApiError, type DeviceRequestOut, VaultApi } from "../../../frontend/src/passwords/core/api";
import { memoryPin } from "../../../frontend/src/passwords/core/connections";
import { IdbStore } from "../../../frontend/src/passwords/core/store";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { Button, Callout, errorText, inputClass, Label, Spinner } from "../../../frontend/src/passwords/ui/kit";
import type { Platform } from "../../../frontend/src/passwords/ui/platform";
import { JoinDevice } from "../../../frontend/src/passwords/ui/Unlock";
import { VaultApp } from "../../../frontend/src/passwords/ui/VaultApp";
import { native, nativeFetch } from "./native";
import { DesktopSettings } from "./settings";
import { Shell } from "./shell";

const store = new IdbStore("promptly-vault");
const pin = memoryPin();

// External links leave the app. Everything else stays inside (see `allowed_navigation`).
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      native.openExternal(href).catch(() => undefined);
    } else if (href === "/") {
      // The web app's "home" link. There's nothing above this page here.
      e.preventDefault();
    }
  },
  true,
);

function Connect({ notice, onDone }: { notice: string; onDone: () => void }) {
  const [server, setServer] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState(notice);
  const [waiting, setWaiting] = useState(false);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const origin = await native.connectionBegin(server);
      const api = new VaultApi(origin, () => null, nativeFetch);
      const started = await api.connectStart(await native.deviceName(), "windows", ["vault", "mail_codes"]);
      setCode(started.code);
      setWaiting(true);
      await native.openExternal(`${origin}/passwords/connect?code=${started.code}`);
      const until = Date.now() + 9 * 60 * 1000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await api.connectPoll(started.id, started.poll_secret);
        if (r.status === "approved" && r.token) {
          await native.connectionSave(r.token, r.device_id ?? "", r.user_id ?? "");
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
          <p className="text-[var(--text-muted)]">Your browser will open so you can approve this computer while signed in to Promptly.</p>
          {error && <Callout kind="danger">{error}</Callout>}
          <Button kind="primary" type="submit" disabled={!server.trim()}>Connect</Button>
        </form>
      )}
      {waiting && (
        <>
          <p>A Promptly tab opened in your browser. Sign in if you need to, check it shows the code <code data-testid="connect-code" className="font-mono">{code}</code>, and approve it.</p>
          <Spinner label="Waiting for your approval…" />
        </>
      )}
    </main>
  );
}

/** A new device is asking to join. The vault's Devices screen does the approving, with the
 *  safety words; this only makes sure it's seen. */
function DeviceRequestNotice({ requests }: { requests: DeviceRequestOut[] }) {
  const [hash, setHash] = useState(location.hash);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const waiting = requests.filter((r) => !dismissed.includes(r.id));
  // The Devices screen lists them itself.
  if (!waiting.length || hash.startsWith("#/devices")) return null;
  const first = waiting[0];
  return (
    <div role="alert" data-testid="device-request" className="fixed bottom-4 right-4 z-40 flex max-w-sm flex-col gap-2 rounded-xl border border-[var(--warning)]/50 bg-[var(--surface)] p-3 text-sm text-[var(--text)] shadow-md">
      <p>
        <strong>{first.name}</strong> wants to join your vault{waiting.length > 1 ? `, and ${waiting.length - 1} more` : ""}. If that wasn't you, refuse it.
      </p>
      <div className="flex gap-2">
        <Button small kind="primary" onClick={() => { location.hash = "#/devices"; }}>Review</Button>
        <Button small onClick={() => setDismissed((d) => [...d, ...waiting.map((r) => r.id)])}>Not now</Button>
      </div>
    </div>
  );
}

/** If the screens ever crash, don't leave a blank window: reloading also drops the keys. */
class CrashScreen extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4 text-sm text-[var(--text)]">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p>Your vault has been locked. Nothing was lost.</p>
        <Button kind="primary" onClick={() => location.reload()}>Start again</Button>
      </main>
    );
  }
}

function Root() {
  const [step, setStep] = useState<"load" | "connect" | "noaccount" | "join" | "vault">("load");
  // A plain string, so going through `reload` again doesn't build a second Shell: each one
  // listens for Rust's events, and two would answer quick search over each other.
  const [server, setServer] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceName, setDeviceName] = useState("Windows app");
  const [deviceRequests, setDeviceRequests] = useState<DeviceRequestOut[]>([]);

  const reload = async () => {
    const c = await native.connectionGet();
    if (!c) return setStep("connect");
    setServer(c.server);
    setDeviceName(await native.deviceName());
    const client = new VaultClient(new VaultApi(c.server, () => null, nativeFetch), store, "windows");
    if (!(await client.hasDeviceKit())) {
      try {
        const pre = await client.api.prelogin();
        return setStep(pre.exists ? "join" : "noaccount");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return forgetToken();
        return setStep("join");
      }
    }
    setStep("vault");
  };

  const forgetToken = async () => {
    await native.connectionClear();
    setServer(null);
    setNotice("This computer isn't connected any more. It may have been removed from your devices.");
    setStep("connect");
  };

  useEffect(() => {
    reload();
  }, []);

  const shellRef = useRef<Shell | null>(null);
  const platform = useMemo<Platform | null>(() => {
    if (!server) return null;
    const api = new VaultApi(server, () => null, nativeFetch);
    const shell = new Shell(api, store);
    shellRef.current = shell;
    shell.onDeviceRequests = setDeviceRequests;
    return {
      kind: "windows",
      pin,
      adoptSecret: (secret) => shell.adoptSecret(secret),
      baseUrl: server,
      api,
      store,
      signIn: () => {
        forgetToken();
      },
      copy: async (text, sensitive) => {
        const s = await store.getMeta<{ clipboardSeconds?: number }>("settings");
        await native.copy(text, sensitive, s?.clipboardSeconds);
      },
      clearClipboard: async () => {
        await native.clearClipboard();
      },
      restore: async () => shell.restore(),
      unlock: (password) => shell.unlock(password),
      lock: () => shell.lock(),
      hello: {
        available: async () => (await native.helloStatus()).available,
        enable: (secret) => native.helloEnable(secret),
        unlock: () => shell.unlockWithHello(),
        disable: () => native.helloDisable(),
      },
      backup: { save: (data, name) => native.backupSave(data, name) },
      notifyChanged: () => shell.notifyChanged(),
    };
  }, [server]);

  useEffect(() => {
    const off = listen("app:settings", () => setSettingsOpen(true));
    return () => {
      off.then((f) => f());
    };
  }, []);

  if (step === "load") return <main className="flex min-h-[100dvh] items-center justify-center"><Spinner label="Loading…" /></main>;
  if (step === "connect") return <Connect notice={notice} onDone={() => location.reload()} />;
  if (step === "noaccount" && server) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4 text-sm text-[var(--text)]">
        <h1 className="text-xl font-semibold">Set up your vault first</h1>
        <p>Your Promptly account has no vault yet. Make one on your server, then come back here.</p>
        <Button kind="primary" onClick={() => native.openExternal(`${server}/passwords`)}>Open Promptly</Button>
        <Button onClick={reload}>I've done that</Button>
      </main>
    );
  }
  if (step === "join" && server) {
    const client = new VaultClient(new VaultApi(server, () => null, nativeFetch), store, "windows");
    return <JoinDevice vault={client} deviceName={deviceName} onReady={async () => { await client.lock(); await reload(); }} />;
  }
  if (!platform || !server) return null;
  return (
    <>
      <CrashScreen>
        <VaultApp platform={platform} />
      </CrashScreen>
      <DeviceRequestNotice requests={deviceRequests} />
      {settingsOpen && shellRef.current && (
        <DesktopSettings
          shell={shellRef.current}
          server={server}
          onClose={() => setSettingsOpen(false)}
          onDisconnect={async () => {
            await shellRef.current?.lock();
            await store.clear();
            await native.connectionClear();
            location.reload();
          }}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
