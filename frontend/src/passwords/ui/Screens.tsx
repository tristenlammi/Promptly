// The smaller screens: Generator, 2FA codes, Trash, Devices, Activity, Settings,
// and the page that approves a new client.
import { Check, MonitorSmartphone, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ActivityOut, DeviceOut, DeviceRequestOut, VaultApi } from "../core/api";
import { buf } from "../core/bytes";
import { DEFAULT_PASSWORD, DEFAULT_PASSPHRASE, generatePassphrase, generatePassword, generatePin, generateUsername, plusAddress } from "../core/generator";
import { Button, Callout, CopyButton, errorText, inputClass, Label, Modal, useVault } from "./kit";
import { StrengthMeter } from "./Onboarding";
import { TotpRow } from "./ItemView";
import { ClockWarning, PasskeyUnlockPanel, PinPanel, TravelPanel } from "./Connections";

export function GeneratorScreen() {
  const { copy } = useVault();
  const [mode, setMode] = useState<"password" | "passphrase" | "pin" | "username">("password");
  const [opts, setOpts] = useState(DEFAULT_PASSWORD);
  const [phrase, setPhrase] = useState(DEFAULT_PASSPHRASE);
  const [pinLen, setPinLen] = useState(6);
  const [userStyle, setUserStyle] = useState<"words" | "random">("words");
  const [email, setEmail] = useState("");
  const [tag, setTag] = useState("");
  const [value, setValue] = useState("");

  const regenerate = useCallback(() => {
    try {
      if (mode === "password") setValue(generatePassword(opts));
      else if (mode === "passphrase") setValue(generatePassphrase(phrase));
      else if (mode === "pin") setValue(generatePin(pinLen));
      else setValue(email && tag ? plusAddress(email, tag) : generateUsername(userStyle));
    } catch (e) {
      setValue(errorText(e));
    }
  }, [mode, opts, phrase, pinLen, userStyle, email, tag]);

  useEffect(regenerate, [regenerate]);

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-lg font-semibold text-[var(--text)]">Generator</h1>
      <div role="tablist" className="flex flex-wrap gap-1">
        {(["password", "passphrase", "pin", "username"] as const).map((m) => (
          <Button key={m} small kind={mode === m ? "primary" : "plain"} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
            {m[0].toUpperCase() + m.slice(1)}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <code data-testid="generated" className="min-w-0 flex-1 break-all font-mono text-base text-[var(--text)]">{value}</code>
        <Button small onClick={regenerate} aria-label="Generate again"><RefreshCw className="h-3.5 w-3.5" /></Button>
        <CopyButton label="generated value" value={value} onCopy={() => copy(value, "Generated value", mode !== "username")} />
      </div>
      {mode !== "username" && <StrengthMeter password={value} />}
      {mode === "password" && (
        <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
          <Label text={`Length: ${opts.length}`}>
            <input type="range" min={8} max={64} value={opts.length} onChange={(e) => setOpts({ ...opts, length: Number(e.target.value) })} />
          </Label>
          {(
            [
              ["lower", "Lowercase"],
              ["upper", "Uppercase"],
              ["digits", "Numbers"],
              ["symbols", "Symbols"],
              ["avoidAmbiguous", "Skip look-alikes (O and 0, l and 1)"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      )}
      {mode === "passphrase" && (
        <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
          <Label text={`Words: ${phrase.words}`}>
            <input type="range" min={3} max={12} value={phrase.words} onChange={(e) => setPhrase({ ...phrase, words: Number(e.target.value) })} />
          </Label>
          <Label text="Between words">
            <input className={inputClass} maxLength={3} value={phrase.separator} onChange={(e) => setPhrase({ ...phrase, separator: e.target.value })} />
          </Label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={phrase.capitalize} onChange={(e) => setPhrase({ ...phrase, capitalize: e.target.checked })} />Capitalise words</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={phrase.includeNumber} onChange={(e) => setPhrase({ ...phrase, includeNumber: e.target.checked })} />Add a number</label>
        </div>
      )}
      {mode === "pin" && (
        <Label text={`Digits: ${pinLen}`}>
          <input type="range" min={4} max={12} value={pinLen} onChange={(e) => setPinLen(Number(e.target.value))} />
        </Label>
      )}
      {mode === "username" && (
        <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
          <label className="flex items-center gap-2"><input type="radio" checked={userStyle === "words"} onChange={() => setUserStyle("words")} />Words</label>
          <label className="flex items-center gap-2"><input type="radio" checked={userStyle === "random"} onChange={() => setUserStyle("random")} />Random</label>
          <h2 className="mt-2 font-medium">Or a plus-address</h2>
          <p className="text-xs text-[var(--text-muted)]">A one-site address that lands in your inbox, so you can see who leaked or sold it. Your email provider has to support plus-addressing.</p>
          <Label text="Your email"><input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Label>
          <Label text="This site"><input className={inputClass} value={tag} onChange={(e) => setTag(e.target.value)} /></Label>
          {email && tag && <PlusRule address={plusAddress(email, tag)} />}
        </div>
      )}
    </section>
  );
}

export function CodesScreen() {
  const { vault, version } = useVault();
  const [q, setQ] = useState("");
  const items = useMemo(() => {
    void version;
    return vault.search(q).filter((i) => i.body.totp?.secret);
  }, [vault, q, version]);
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <h1 className="text-lg font-semibold text-[var(--text)]">2FA codes</h1>
      <ClockWarning />
      <input className={inputClass} placeholder="Search" aria-label="Search codes" value={q} onChange={(e) => setQ(e.target.value)} />
      {items.length === 0 && <p className="text-sm text-[var(--text-muted)]">No 2FA codes yet. Add one to a login, or scan a QR from a new 2FA code item.</p>}
      <div className="flex flex-col gap-2">
        {items.map((i) => (
          <div key={i.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3">
            <TotpRow cfg={i.body.totp!} label={i.body.title} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function TrashScreen() {
  const { vault, version, bump, toast } = useVault();
  const items = useMemo(() => {
    void version;
    return vault.trash();
  }, [vault, version]);
  const act = async (fn: () => Promise<void>, msg: string) => {
    await fn();
    vault.sync().catch(() => undefined);
    bump();
    toast(msg);
  };
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <h1 className="text-lg font-semibold text-[var(--text)]">Trash</h1>
      <p className="text-sm text-[var(--text-muted)]">Items here are deleted for good after 30 days.</p>
      {items.length === 0 && <p className="text-sm text-[var(--text-muted)]">Trash is empty.</p>}
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)]">
            <span className="min-w-0 flex-1 truncate">{i.body.title}</span>
            <Button small onClick={() => act(() => vault.restoreItem(i.id), "Restored")}>Restore</Button>
            <Button small kind="danger" onClick={() => act(() => vault.purgeItem(i.id), "Deleted for good")}>Delete for good</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApproveDevice({ request, onDone }: { request: DeviceRequestOut; onDone: () => void }) {
  const { vault, toast } = useVault();
  const [words, setWords] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    vault.beginApproval(request.id, request.device_pub).then((r) => setWords(r.words)).catch((e) => setError(errorText(e)));
  }, [vault, request]);
  const approve = async () => {
    try {
      await vault.finishApproval(request.id, request.device_pub);
      toast(`${request.name} approved`);
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const deny = async () => {
    await vault.api.deviceRequestDeny(request.id);
    onDone();
  };
  return (
    <Modal title={`Approve ${request.name}?`} onClose={onDone}>
      <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
        <p>Only approve this if you're setting up {request.name} right now. It will get your Secret Key.</p>
        <p>Its code: <code className="font-mono">{request.code}</code></p>
        {words ? (
          <Callout>
            <div className="mb-1 font-medium">Both devices must show these words:</div>
            <div data-testid="safety-words" className="font-mono">{words.join(" ")}</div>
          </Callout>
        ) : !error && <p>Preparing…</p>}
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="flex gap-2">
          <Button kind="primary" disabled={!words} onClick={approve}><Check className="h-4 w-4" /> The words match, approve</Button>
          <Button kind="danger" onClick={deny}><X className="h-4 w-4" /> Refuse</Button>
        </div>
      </div>
    </Modal>
  );
}

export function DevicesScreen() {
  const { vault, toast } = useVault();
  const [devices, setDevices] = useState<DeviceOut[]>([]);
  const [requests, setRequests] = useState<DeviceRequestOut[]>([]);
  const [approving, setApproving] = useState<DeviceRequestOut | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([vault.api.devices(), vault.api.deviceRequests()]);
      setDevices(d);
      setRequests(r);
    } catch (e) {
      setError(errorText(e));
    }
  }, [vault]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const revoke = async (d: DeviceOut) => {
    await vault.api.revokeDevice(d.id);
    toast(`${d.name} removed`);
    load();
  };
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <h1 className="text-lg font-semibold text-[var(--text)]">Devices</h1>
      {error && <Callout kind="danger">{error}</Callout>}
      {requests.map((r) => (
        <Callout key={r.id} kind="warn">
          <div className="flex items-center justify-between gap-2">
            <span><strong>{r.name}</strong> wants to join your vault.</span>
            <Button small kind="primary" onClick={() => setApproving(r)}>Review</Button>
          </div>
        </Callout>
      ))}
      <ul className="flex flex-col gap-2">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--text)]">
            <MonitorSmartphone className="h-5 w-5 text-[var(--text-muted)]" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{d.name}{d.current ? " (this device)" : ""}</div>
              <div className="text-xs text-[var(--text-muted)]">{d.platform}{d.last_seen_at ? ` · last seen ${new Date(d.last_seen_at).toLocaleString()}` : ""}</div>
            </div>
            <Button small kind="danger" onClick={() => revoke(d)} aria-label={`Remove ${d.name}`}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>
          </li>
        ))}
      </ul>
      {devices.length === 0 && <p className="text-sm text-[var(--text-muted)]">Connect the browser extension, the Windows app or Promptly for Android, and they'll appear here. This browser doesn't need adding.</p>}
      <p className="text-xs text-[var(--text-muted)]">Removing a device stops it syncing. What it already downloaded stays there, encrypted.</p>
      {approving && (
        <ApproveDevice
          request={approving}
          onDone={() => {
            setApproving(null);
            load();
          }}
        />
      )}
    </section>
  );
}

const EVENT_TEXT: Record<string, string> = {
  vault_created: "Vault created",
  unlocked: "Unlocked",
  unlock_locked_out: "Too many wrong tries: unlock paused",
  master_password_changed: "Master password changed",
  vault_reset: "Vault reset",
  device_added: "Device added",
  device_removed: "Device removed",
  device_approved: "New device approved",
  device_denied: "New device refused",
  vault_shared_created: "Shared vault created",
  vault_deleted: "Shared vault deleted",
  vault_left: "Left a shared vault",
  vault_member_added: "Someone added to a shared vault",
  vault_invited: "You were invited to a shared vault",
  vault_role_changed: "A member's role changed",
  vault_key_rotated: "Shared vault's key changed",
  vault_removed: "Removed from a shared vault",
  exported: "Vault exported",
};

export function ActivityScreen() {
  const { vault } = useVault();
  const [rows, setRows] = useState<ActivityOut[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    vault.api.activity().then(setRows).catch((e) => setError(errorText(e)));
  }, [vault]);
  return (
    <section className="flex max-w-xl flex-col gap-3">
      <h1 className="text-lg font-semibold text-[var(--text)]">Activity</h1>
      <p className="text-sm text-[var(--text-muted)]">Things that happened to your vault. It never records item names.</p>
      {error && <Callout kind="danger">{error}</Callout>}
      <ul className="flex flex-col">
        {rows.map((r, i) => (
          <li key={i} className="flex justify-between gap-3 border-b border-[var(--border)] py-2 text-sm text-[var(--text)] last:border-0">
            <span>{EVENT_TEXT[r.event] ?? r.event}</span>
            <time className="text-xs text-[var(--text-muted)]">{new Date(r.at).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SettingsScreen() {
  const { vault, settings, setSettings, toast, platform } = useVault();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<string[]>([]);
  const [helloOn, setHelloOn] = useState(false);
  const [helloAvailable, setHelloAvailable] = useState(false);
  const [helloPassword, setHelloPassword] = useState("");
  useEffect(() => {
    vault.myIdentityWords().then(setWords);
    platform.hello?.available().then(setHelloAvailable);
    vault.store.getMeta<boolean>("hello_enabled").then((v) => setHelloOn(!!v));
  }, [vault, platform]);

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < 10) return setError("Use at least 10 characters.");
    if (next !== again) return setError("Those two don't match.");
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30));
    try {
      await vault.changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      toast("Master password changed");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex max-w-xl flex-col gap-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Settings</h1>
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">On this device</h2>
        <Label text="Lock after this many idle minutes">
          <input className={inputClass} type="number" min={1} max={1440} value={settings.autoLockMinutes} onChange={(e) => setSettings({ ...settings, autoLockMinutes: Math.max(1, Number(e.target.value) || 15) })} />
        </Label>
        <label className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" checked={settings.lockOnSleep} onChange={(e) => setSettings({ ...settings, lockOnSleep: e.target.checked })} />Lock when the computer sleeps
        </label>
        <Label text="Clear copied secrets after this many seconds">
          <input className={inputClass} type="number" min={5} max={600} value={settings.clipboardSeconds} onChange={(e) => setSettings({ ...settings, clipboardSeconds: Math.max(5, Number(e.target.value) || 30) })} />
        </Label>
        {platform.settingsExtras}
        {platform.pin && <PinPanel />}
        <PasskeyUnlockPanel />
        <TravelPanel />
        {helloAvailable && (
          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={helloOn}
              onChange={async (e) => {
                const on = e.target.checked;
                try {
                  if (on) {
                    const raw = await vault.exportUnlockSecret(helloPassword);
                    await platform.hello!.enable(raw);
                  } else {
                    await platform.hello!.disable();
                  }
                  await vault.store.setMeta("hello_enabled", on);
                  setHelloOn(on);
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            />
            Unlock with Windows Hello
          </label>
        )}
        {helloAvailable && !helloOn && (
          <Label text="Master password, to turn on Windows Hello">
            <input className={inputClass} type="password" autoComplete="current-password" value={helloPassword} onChange={(e) => setHelloPassword(e.target.value)} />
          </Label>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">Your safety words</h2>
        <p className="text-sm text-[var(--text-muted)]">Someone sharing a vault with you can compare these, to be sure it's really you. They change only if your account is reset.</p>
        <code data-testid="my-words" className="rounded-lg bg-[var(--surface-1)] p-2 font-mono text-sm text-[var(--text)]">{words.join(" ")}</code>
      </div>
      <form onSubmit={change} className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">Change master password</h2>
        <Label text="Current master password"><input className={inputClass} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Label>
        <Label text="New master password"><input className={inputClass} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Label>
        <StrengthMeter password={next} />
        <Label text="Type it again"><input className={inputClass} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Label>
        {error && <Callout kind="danger">{error}</Callout>}
        <Button kind="primary" type="submit" disabled={busy || !current || !next}>Change it</Button>
      </form>
      <ResetVault />
    </section>
  );
}

function ResetVault() {
  const { vault, toast } = useVault();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await vault.api.reset({ confirm: confirmText, password: password || undefined, totp_code: code || undefined });
      await vault.store.clear();
      toast("Vault reset");
      location.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--danger)]">Reset vault</h2>
      <p className="text-sm text-[var(--text-muted)]">Only for someone who lost both their master password and recovery kit. It destroys everything in your personal vault, for good. Nobody can undo it.</p>
      <Button kind="danger" className="w-fit" onClick={() => setOpen(true)}>Reset vault…</Button>
      {open && (
        <Modal title="Destroy this vault?" onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Callout kind="danger">Everything in your personal vault will be gone. This can't be undone.</Callout>
            <Label text="Your Promptly sign-in password"><input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Label>
            <Label text="Your Promptly 2FA code, if you use one"><input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Label>
            <Label text="Type DELETE MY VAULT"><input className={inputClass} value={confirmText} onChange={(e) => setConfirm(e.target.value)} /></Label>
            {error && <Callout kind="danger">{error}</Callout>}
            <Button kind="danger" type="submit" disabled={confirmText !== "DELETE MY VAULT"}>Destroy my vault</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** /passwords/connect?code=…: a client asking to be tied to this account. */
export function ConnectScreen({ api, code }: { api: VaultApi; code: string }) {
  const [info, setInfo] = useState<{ name: string; platform: string; scopes: string[] } | null>(null);
  const [state, setState] = useState<"loading" | "ask" | "done" | "denied" | "bad">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    api.connectInfo(code).then(
      (i) => {
        setInfo(i);
        setState("ask");
      },
      () => setState("bad"),
    );
  }, [api, code]);
  const approve = async () => {
    try {
      await api.connectApprove(code);
      setState("done");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const deny = async () => {
    await api.connectDeny(code);
    setState("denied");
  };
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4 text-sm text-[var(--text)]">
      <h1 className="text-xl font-semibold">Connect a device</h1>
      {state === "loading" && <p>Checking that code…</p>}
      {state === "bad" && <Callout kind="danger">That code isn't valid any more. Start again from the device.</Callout>}
      {state === "ask" && info && (
        <>
          <p><strong>{info.name}</strong> wants to connect to your Promptly as a {info.platform} device. The code on it should say <code className="font-mono">{code}</code>.</p>
          <p className="text-[var(--text-muted)]">This doesn't open your vault. It still needs your master password and Secret Key.</p>
          {error && <Callout kind="danger">{error}</Callout>}
          <div className="flex gap-2">
            <Button kind="primary" onClick={approve}>Connect</Button>
            <Button onClick={deny}>Don't connect</Button>
          </div>
        </>
      )}
      {state === "done" && <Callout>Connected. You can close this tab and go back to the device.</Callout>}
      {state === "denied" && <Callout>Not connected.</Callout>}
    </main>
  );
}

export const _unused = buf;

/** Mail sent to this address files itself under its own label, as it arrives. */
function PlusRule({ address }: { address: string }) {
  const { vault, toast } = useVault();
  return (
    <Button
      small
      className="w-fit"
      onClick={async () => {
        try {
          const r = await vault.api.request<{ label: string }>("POST", "/mail/plus-rule", { address });
          toast(`Mail to this address will be labelled ${r.label}`);
        } catch (e) {
          toast(errorText(e), "err");
        }
      }}
    >
      Label its mail in Promptly Mail
    </Button>
  );
}
