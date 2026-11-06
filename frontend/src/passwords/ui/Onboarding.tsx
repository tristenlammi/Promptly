// First run: explain, master password, recovery kit, prove the kit, and on.
// It can't finish until the kit is saved and proven, because without it the vault
// can be lost for good.
import { Download, Printer, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { buf } from "../core/bytes";
import { buildKitPdf } from "../core/kit";
import { encodeSecretKey, lastGroup } from "../core/keys";
import { KDF_FLOOR, type KdfParams } from "../core/primitives";
import { type Strength, strengthOf } from "../core/strength";
import type { VaultClient } from "../core/vault";
import { Button, Callout, errorText, inputClass, Label, Spinner } from "./kit";

export function downloadBlob(data: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([typeof data === "string" ? data : buf(data)], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** The KDF floor, raised a step if this device is quick. Run once at setup. */
async function calibrate(): Promise<KdfParams> {
  const { argon2 } = await import("../core/primitives");
  const start = performance.now();
  await argon2(new Uint8Array(16), new Uint8Array(16), KDF_FLOOR);
  const ms = performance.now() - start;
  if (ms < 180) return { ...KDF_FLOOR, m: 262144 };
  if (ms < 400) return { ...KDF_FLOOR, m: 131072 };
  return KDF_FLOOR;
}

export function StrengthMeter({ password, inputs }: { password: string; inputs?: string[] }) {
  const [s, setS] = useState<Strength | null>(null);
  useEffect(() => {
    let live = true;
    if (!password) {
      setS(null);
      return;
    }
    strengthOf(password, inputs).then((r) => live && setS(r));
    return () => {
      live = false;
    };
  }, [password, inputs]);
  if (!s) return null;
  const colour = ["bg-[var(--danger)]", "bg-[var(--danger)]", "bg-[var(--warning)]", "bg-[var(--success)]", "bg-[var(--success)]"][s.score];
  return (
    <div className="flex flex-col gap-1" data-testid="strength">
      <div className="flex h-1.5 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`flex-1 rounded ${i < Math.max(1, s.score) ? colour : "bg-[var(--surface-2)]"}`} />
        ))}
      </div>
      <div className="text-xs text-[var(--text-muted)]">
        {s.label}
        {s.crackTime ? `. Guessing it would take about ${s.crackTime}.` : ""} {s.warning}
      </div>
    </div>
  );
}

type Props = { vault: VaultClient; username: string; preview: boolean; serverUrl: string; onDone: () => void };

export function Onboarding({ vault, username, preview, serverUrl, onDone }: Props) {
  const [step, setStep] = useState<"explain" | "password" | "kit" | "prove" | "next">("explain");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [encoded, setEncoded] = useState("");
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState("");
  const [understood, setUnderstood] = useState(false);

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 10) return setError("Use at least 10 characters. A few random words works well.");
    if (password !== again) return setError("Those two don't match.");
    const s = await strengthOf(password, [username]);
    if (s.score < 2) return setError("That's too easy to guess. Try a few random words.");
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const { secretKey } = await vault.setup(password, await calibrate());
      setEncoded(await encodeSecretKey(secretKey));
      secretKey.fill(0);
      setStep("kit");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const savePdf = () => {
    downloadBlob(buildKitPdf({ secretKey: encoded, serverUrl, username, createdOn: new Date().toISOString().slice(0, 10) }), "Promptly-Passwords-Recovery-Kit.pdf", "application/pdf");
    setSaved(true);
  };

  const prove = async (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim().toUpperCase() !== lastGroup(encoded)) return setError("That's not the last group. Look at your kit again.");
    setError("");
    setBusy(true);
    try {
      await vault.api.confirmKit();
      setStep("next");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-lg flex-col justify-center gap-4 p-4">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text)]">
        <ShieldCheck className="h-6 w-6 text-[var(--accent)]" /> Set up Passwords
      </h1>
      {preview && (
        <Callout kind="warn">
          <strong>Preview.</strong> This is new and hasn't had an independent security review yet. Try it with low-value accounts first, and keep your passwords somewhere else as well for now.
        </Callout>
      )}

      {step === "explain" && (
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>Your vault is locked by two things, and both stay with you:</p>
          <ul className="list-disc pl-5">
            <li><strong>A master password</strong> you choose. It's separate from your Promptly sign-in, and it never leaves your device.</li>
            <li><strong>A Secret Key</strong> your device makes. You'll save it in a recovery kit.</li>
          </ul>
          <p>Your server only ever holds scrambled data, so a stolen backup can't be opened, and your admin can't read it.</p>
          <Callout kind="danger">
            <strong>If you lose both your master password and your recovery kit, your vault is gone for good.</strong> Nobody can get it back, not the admin and not anyone else.
          </Callout>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand
          </label>
          <Button kind="primary" disabled={!understood} onClick={() => setStep("password")}>Continue</Button>
        </div>
      )}

      {step === "password" && (
        <form onSubmit={submitPassword} className="flex flex-col gap-3">
          <Label text="Master password" hint="Long and memorable beats short and clever. It can't be reset.">
            <input className={inputClass} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          <StrengthMeter password={password} inputs={[username]} />
          <Label text="Type it again">
            <input className={inputClass} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Label>
          {error && <Callout kind="danger">{error}</Callout>}
          {busy ? <Spinner label="Creating your vault. This takes a moment on purpose." /> : <Button kind="primary" type="submit">Create vault</Button>}
        </form>
      )}

      {step === "kit" && (
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>This is your Secret Key. You'll need it, with your master password, to open your vault on a new device. Save your recovery kit now, and print it if you can.</p>
          <code data-testid="secret-key" className="select-all rounded-lg bg-[var(--surface-1)] p-3 text-center font-mono text-sm">{encoded}</code>
          <div className="flex flex-wrap gap-2">
            <Button kind="primary" onClick={savePdf}><Download className="h-4 w-4" /> Save recovery kit (PDF)</Button>
            <Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print this page</Button>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I've saved my recovery kit somewhere safe
          </label>
          <Button kind="primary" disabled={!saved} onClick={() => setStep("prove")}>Continue</Button>
        </div>
      )}

      {step === "prove" && (
        <form onSubmit={prove} className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>Just to be sure you can get to it: type the last group of your Secret Key, from your kit.</p>
          <Label text="Last group of your Secret Key">
            <input className={`${inputClass} font-mono uppercase`} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Label>
          {error && <Callout kind="danger">{error}</Callout>}
          {busy ? <Spinner /> : <Button kind="primary" type="submit">Finish</Button>}
          <button type="button" className="text-left text-xs text-[var(--accent-text)] underline" onClick={() => setStep("kit")}>Show my kit again</button>
        </form>
      )}

      {step === "next" && (
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p className="font-medium">Your vault is ready.</p>
          <p>Next you might want to:</p>
          <ul className="list-disc pl-5">
            <li>Bring in your passwords from another manager or browser: Import, in the sidebar.</li>
            <li>Install the browser extension so filling just works: see Devices.</li>
            <li>Turn on Passwords in Promptly for Android.</li>
          </ul>
          <Button kind="primary" onClick={onDone}>Open my vault</Button>
        </div>
      )}
    </main>
  );
}
