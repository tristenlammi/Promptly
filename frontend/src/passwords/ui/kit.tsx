// Small building blocks in Promptly's look. Own file so the vault bundle doesn't
// pull in the main app's stores.
import { Check, Copy, Eye, EyeOff, X } from "lucide-react";
import { type ButtonHTMLAttributes, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import type { VaultClient } from "../core/vault";
import type { Platform } from "./platform";

export type Settings = {
  autoLockMinutes: number;
  clipboardSeconds: number;
  lockOnSleep: boolean;
  healthOptIn: boolean;
  fillOnClickOnly: boolean;
};
export const DEFAULT_SETTINGS: Settings = { autoLockMinutes: 15, clipboardSeconds: 30, lockOnSleep: true, healthOptIn: false, fillOnClickOnly: false };

export type Ctx = {
  platform: Platform;
  vault: VaultClient;
  settings: Settings;
  setSettings: (s: Settings) => void;
  preview: boolean;
  version: number;
  bump: () => void;
  go: (route: string) => void;
  route: string;
  toast: (message: string, kind?: "ok" | "err") => void;
  copy: (text: string, what: string, sensitive?: boolean) => Promise<void>;
};
export const VaultContext = createContext<Ctx | null>(null);

export function useVault(): Ctx {
  const c = useContext(VaultContext);
  if (!c) throw new Error("no vault context");
  return c;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "plain" | "danger" | "ghost"; small?: boolean };

export function Button({ kind = "plain", small, className = "", ...rest }: BtnProps) {
  const looks = {
    primary: "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] border-transparent",
    plain: "bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-1)] border-[var(--border)]",
    danger: "bg-[var(--surface)] text-[var(--danger)] hover:bg-[var(--surface-1)] border-[var(--danger)]/40",
    ghost: "bg-transparent text-[var(--text)] hover:bg-[var(--surface-1)] border-transparent",
  }[kind];
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition disabled:opacity-50 ${small ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm"} ${looks} ${className}`}
    />
  );
}

export function IconButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-1)] hover:text-[var(--text)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

export function Label({ text, children, hint }: { text: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-[var(--text)]">{text}</span>
      {children}
      {hint && <span className="text-xs text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

export function Callout({ kind = "info", children }: { kind?: "info" | "warn" | "danger"; children: ReactNode }) {
  const c = {
    info: "border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)]",
    warn: "border-[var(--warning)]/50 bg-[var(--warning)]/10 text-[var(--text)]",
    danger: "border-[var(--danger)]/50 bg-[var(--danger)]/10 text-[var(--text)]",
  }[kind];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${c}`}>{children}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[90dvh] w-full overflow-auto rounded-2xl bg-[var(--surface)] p-4 shadow-lg outline-none ${wide ? "max-w-2xl" : "max-w-md"}`}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A secret shown as dots until asked for, with copy. Only in the DOM when revealed. */
export function SecretRow({ label, value, what, mono = true }: { label: string; value: string; what?: string; mono?: boolean }) {
  const [shown, setShown] = useState(false);
  const { copy } = useVault();
  return (
    <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-[var(--text-muted)]">{label}</div>
        <div className={`break-all text-sm text-[var(--text)] ${mono ? "font-mono" : ""}`}>{shown ? value : "•".repeat(Math.min(value.length || 8, 16))}</div>
      </div>
      <IconButton label={shown ? `Hide ${label}` : `Show ${label}`} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </IconButton>
      <CopyButton label={label} value={value} onCopy={() => copy(value, what ?? label, true)} />
    </div>
  );
}

export function CopyButton({ label, onCopy }: { label: string; value: string; onCopy: () => Promise<void> | void }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={`Copy ${label}`}
      onClick={async () => {
        await onCopy();
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="h-4 w-4 text-[var(--success)]" /> : <Copy className="h-4 w-4" />}
    </IconButton>
  );
}

export function PlainRow({ label, value, copyable = true }: { label: string; value: string; copyable?: boolean }) {
  const { copy } = useVault();
  return (
    <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-[var(--text-muted)]">{label}</div>
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">{value}</div>
      </div>
      {copyable && <CopyButton label={label} value={value} onCopy={() => copy(value, label)} />}
    </div>
  );
}

/** Only ever web links: no javascript: or data: from an imported item. */
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
      {label}
    </div>
  );
}
