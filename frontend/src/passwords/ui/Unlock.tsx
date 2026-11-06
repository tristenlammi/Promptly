// Unlock, and getting the Secret Key onto a new device.
import { KeyRound, Lock } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ApiError } from "../core/api";
import { parseKitQr } from "../core/kit";
import { parseSecretKey } from "../core/keys";
import { type DeviceJoin, type VaultClient, WrongPasswordError } from "../core/vault";
import { Button, Callout, errorText, inputClass, Label, Spinner } from "./kit";
import { scanQrFromCamera } from "./qr";

export function Unlock({ vault, preview, onOpen, hello }: { vault: VaultClient; preview: boolean; onOpen: () => void; hello?: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      // Let the spinner paint: Argon2 blocks the page for a moment.
      await new Promise((r) => setTimeout(r, 30));
      await vault.unlock(password);
      setPassword("");
      onOpen();
    } catch (err) {
      if (err instanceof WrongPasswordError) setError("That master password isn't right.");
      else if (err instanceof ApiError && err.status === 429) setError(errorText(err));
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-4 p-4">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text)]">
        <Lock className="h-6 w-6 text-[var(--accent)]" /> Your vault is locked
      </h1>
      {preview && <span className="w-fit rounded bg-[var(--warning)]/20 px-2 py-0.5 text-xs font-medium text-[var(--text)]">Preview</span>}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Label text="Master password">
          <input ref={input} className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Label>
        {error && <Callout kind="danger">{error}</Callout>}
        {busy ? <Spinner label="Unlocking…" /> : <Button kind="primary" type="submit" disabled={!password}>Unlock</Button>}
        {hello && <Button onClick={() => hello().then(onOpen).catch((e) => setError(errorText(e)))}>Unlock with Windows Hello</Button>}
      </form>
    </main>
  );
}

/** A device with no Secret Key yet: approve from another device, or use the kit. */
export function JoinDevice({ vault, deviceName, onReady }: { vault: VaultClient; deviceName: string; onReady: () => void }) {
  const [mode, setMode] = useState<"choose" | "approve" | "kit">("choose");
  const [join, setJoin] = useState<DeviceJoin | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [status, setStatus] = useState("");
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setError("");
    try {
      setJoin(await vault.requestDevice(deviceName));
      setMode("approve");
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    if (!join) return;
    let live = true;
    const tick = async () => {
      try {
        const s = await join.poll();
        if (!live) return;
        setWords(s.words);
        if (s.status === "approved") {
          setStatus("approved");
          return;
        }
        if (s.status === "denied") {
          setStatus("denied");
          return;
        }
        setTimeout(tick, 2000);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };
    tick();
    return () => {
      live = false;
    };
  }, [join]);

  const useKit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const raw = await parseSecretKey(secret);
      await new Promise((r) => setTimeout(r, 30));
      await vault.unlock(password, raw);
      onReady();
    } catch (err) {
      setError(err instanceof WrongPasswordError ? "That master password or Secret Key isn't right." : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    try {
      const text = await scanQrFromCamera();
      const kit = text ? parseKitQr(text) : null;
      if (kit) setSecret(kit.secretKey);
      else if (text) setError("That QR isn't a recovery kit.");
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text)]">
        <KeyRound className="h-6 w-6 text-[var(--accent)]" /> Add this device
      </h1>
      {mode === "choose" && (
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>This device doesn't have your Secret Key yet.</p>
          <Button kind="primary" onClick={start}>Approve from another device</Button>
          <Button onClick={() => setMode("kit")}>Use my recovery kit</Button>
        </div>
      )}
      {mode === "approve" && join && status === "" && (
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>Open Passwords on a device that's unlocked, go to Devices, and approve <strong>{deviceName}</strong>. Your code is <code className="font-mono">{join.code}</code>.</p>
          {words ? (
            <Callout>
              <div className="mb-1 font-medium">Check both devices show these words:</div>
              <div data-testid="safety-words" className="font-mono">{words.join(" ")}</div>
            </Callout>
          ) : (
            <Spinner label="Waiting for your other device…" />
          )}
        </div>
      )}
      {status === "approved" && (
        <form onSubmit={useKit2(setError, setBusy, vault, password, onReady)} className="flex flex-col gap-3">
          <Callout>Approved. Now your master password.</Callout>
          <Label text="Master password">
            <input className={inputClass} type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          {error && <Callout kind="danger">{error}</Callout>}
          {busy ? <Spinner label="Unlocking…" /> : <Button kind="primary" type="submit">Unlock</Button>}
        </form>
      )}
      {status === "denied" && <Callout kind="danger">That request was refused from your other device.</Callout>}
      {mode === "kit" && (
        <form onSubmit={useKit} className="flex flex-col gap-3">
          <Label text="Secret Key" hint="From your recovery kit. Starts with PWK1.">
            <input className={`${inputClass} font-mono`} autoFocus value={secret} autoComplete="off" spellCheck={false} onChange={(e) => setSecret(e.target.value)} />
          </Label>
          <Button onClick={scan}>Scan the QR on my kit</Button>
          <Label text="Master password">
            <input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          {error && <Callout kind="danger">{error}</Callout>}
          {busy ? <Spinner label="Unlocking…" /> : <Button kind="primary" type="submit">Unlock</Button>}
          <button type="button" className="text-left text-xs text-[var(--accent-text)] underline" onClick={() => setMode("choose")}>Back</button>
        </form>
      )}
      {mode === "choose" && error && <Callout kind="danger">{error}</Callout>}
    </main>
  );
}

function useKit2(setError: (s: string) => void, setBusy: (b: boolean) => void, vault: VaultClient, password: string, onReady: () => void) {
  return async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 30));
      await vault.unlock(password);
      onReady();
    } catch (err) {
      setError(err instanceof WrongPasswordError ? "That master password isn't right." : errorText(err));
    } finally {
      setBusy(false);
    }
  };
}
