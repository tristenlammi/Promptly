import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Eye, EyeOff, KeyRound, Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

interface ResetPasswordModalProps {
  open: boolean;
  username: string;
  /** Resolve to commit, throw to surface an inline error. */
  onConfirm: (password: string) => Promise<void>;
  onClose: () => void;
}

const MIN_LENGTH = 8;

/**
 * Lets an admin set a one-shot password for another account. The
 * backend marks ``must_change_password`` and bumps token_version, so
 * every active session is invalidated and the user is forced through a
 * password-change screen on next login.
 */
export function ResetPasswordModal({
  open,
  username,
  onConfirm,
  onClose,
}: ResetPasswordModalProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setConfirm("");
    setShow(false);
    setBusy(false);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatched = confirm.length > 0 && confirm !== password;
  const canSubmit =
    password.length >= MIN_LENGTH && confirm === password && !busy;

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
      onClose();
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(
          (err.response?.data as { detail?: string })?.detail ??
            err.message ??
            "Reset failed"
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Reset password"
      description={`Set a temporary password for “${username}”.`}
      widthClass="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={busy}
            leftIcon={!busy ? <KeyRound className="h-3.5 w-3.5" /> : undefined}
          >
            {busy ? "Resetting…" : "Reset password"}
          </Button>
        </>
      }
    >
      <div
        className={cn(
          "mb-4 flex items-start gap-2.5 rounded-card border px-3 py-2.5 text-xs",
          "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        )}
      >
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The user will be forced to change this password on their next login,
          and every active session will be invalidated immediately. Share the
          temporary password through a secure channel.
        </span>
      </div>

      <div className="space-y-3">
        <Field
          inputRef={inputRef}
          label="Temporary password"
          show={show}
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          onToggleShow={() => setShow((v) => !v)}
          autoComplete="new-password"
        />
        {tooShort && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Must be at least {MIN_LENGTH} characters.
          </p>
        )}
        <Field
          label="Confirm password"
          show={show}
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            setError(null);
          }}
          onToggleShow={() => setShow((v) => !v)}
          autoComplete="new-password"
        />
        {mismatched && (
          <p className="text-[11px] text-red-600 dark:text-red-400">
            Passwords don&apos;t match.
          </p>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Updating…
        </div>
      )}
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  inputRef,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      <div className="relative">
        <input
          ref={inputRef}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className={cn(
            "w-full rounded-input border bg-[var(--bg)] px-3 py-1.5 pr-9 text-sm",
            "border-[var(--border)] text-[var(--text)]",
            "focus:border-[var(--accent)] focus:outline-none"
          )}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </label>
  );
}
