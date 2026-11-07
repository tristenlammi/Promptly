// How long this browser stays unlocked. Used by the toolbar panel and the vault page's Settings.
import { useEffect, useState } from "react";

import { ext, type LockChoice, type LockWhen } from "./rpc";

const MINUTES: [number, string][] = [
  [1, "After 1 minute"],
  [5, "After 5 minutes"],
  [15, "After 15 minutes"],
  [30, "After 30 minutes"],
  [60, "After 1 hour"],
  [240, "After 4 hours"],
  [720, "After 12 hours"],
];

async function call<T>(m: unknown): Promise<T> {
  const r = (await ext.runtime.sendMessage(m)) as { ok: boolean; r?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "No answer from the extension");
  return r.r as T;
}

export function LockSetting() {
  const [choice, setChoice] = useState<LockChoice | null>(null);
  const [askingNever, setAskingNever] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    call<LockChoice>({ t: "lockChoice" }).then(setChoice).catch(() => undefined);
  }, []);
  if (!choice) return null;

  const save = async (when: LockWhen, onSleep: boolean) => {
    setError("");
    const before = choice;
    setChoice({ when, onSleep });
    try {
      setChoice(await call<LockChoice>({ t: "setLockChoice", when, onSleep }));
    } catch (e) {
      setChoice(before);
      setError(e instanceof Error ? e.message : "That didn't save.");
    }
  };
  const custom = typeof choice.when === "number" && !MINUTES.some(([m]) => m === choice.when);

  return (
    <div data-testid="lock-choice" className="flex flex-col gap-2 text-sm text-[var(--text)]">
      <label className="flex flex-col gap-1">
        <span>Lock this browser's vault</span>
        <select
          className="input"
          value={String(choice.when)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "never") return setAskingNever(true);
            setAskingNever(false);
            void save(v === "browser" ? "browser" : Number(v), choice.onSleep);
          }}
        >
          {custom && <option value={String(choice.when)}>After {String(choice.when)} minutes</option>}
          {MINUTES.map(([m, label]) => (
            <option key={m} value={String(m)}>{label}</option>
          ))}
          <option value="browser">When the browser closes</option>
          <option value="never">Never</option>
        </select>
      </label>
      {askingNever && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-2">
          <p>With Never, the key to your vault stays on this computer. Anyone who can open this browser gets your passwords and can sign in with your passkeys, with no password. So can anything that gets at this computer's files.</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setAskingNever(false);
                void save("never", choice.onSleep);
              }}
            >
              Never lock
            </button>
            <button type="button" className="btn" onClick={() => setAskingNever(false)}>Cancel</button>
          </div>
        </div>
      )}
      {choice.when === "never" ? (
        <p className="text-xs text-[var(--text-muted)]">Stays unlocked until you lock it yourself, even after a restart.</p>
      ) : (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={choice.onSleep} onChange={(e) => void save(choice.when, e.target.checked)} />
          Also lock when the computer sleeps
        </label>
      )}
      {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
