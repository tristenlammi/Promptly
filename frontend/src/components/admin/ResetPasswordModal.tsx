import { useEffect, useRef, useState } from "react";
import { usePasswordPolicy } from "@/hooks/usePasswordPolicy";
import { Eye, EyeOff, KeyRound, Loader2, Mail, ShieldAlert } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";

interface ResetPasswordModalProps {
  open: boolean;
  username: string;
  /** Resolve to commit, throw to surface an inline error. */
  onConfirm: (password: string) => Promise<void>;
  /** Email a single-use reset link instead (AP5). Same contract. */
  onSendLink: () => Promise<void>;
  /** Email is set up on the server, so a link can be sent. */
  canEmail: boolean;
  onClose: () => void;
}


/**
 * Lets an admin reset another account's password, two ways:
 *
 * - **Email a reset link** (the default when email is set up): the person
 *   chooses their own password and the admin never knows a working one.
 * - **Set a temporary password**: the backend marks
 *   ``must_change_password`` and bumps token_version, so every active
 *   session ends and the person picks a new password on next sign-in.
 *
 * Either way the person is told (email, notification, a banner and their
 * Recent activity): admin changes to an account are never silent.
 */
export function ResetPasswordModal({
  open,
  username,
  onConfirm,
  onSendLink,
  canEmail,
  onClose,
}: ResetPasswordModalProps) {
  const MIN_LENGTH = usePasswordPolicy().min_length;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"link" | "password">(canEmail ? "link" : "password");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(canEmail ? "link" : "password");
    setPassword("");
    setConfirm("");
    setShow(false);
    setBusy(false);
    setError(null);
    if (!canEmail) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, canEmail]);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatched = confirm.length > 0 && confirm !== password;
  const canSubmit =
    mode === "link"
      ? !busy
      : password.length >= MIN_LENGTH && confirm === password && !busy;

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "link") await onSendLink();
      else await onConfirm(password);
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Reset failed"));
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Reset password"
      description={`Reset the password for “${username}”. They'll be told it was you.`}
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
            leftIcon={
              busy ? undefined : mode === "link" ? (
                <Mail className="h-3.5 w-3.5" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )
            }
          >
            {mode === "link"
              ? busy
                ? "Sending…"
                : "Send reset link"
              : busy
                ? "Resetting…"
                : "Reset password"}
          </Button>
        </>
      }
    >
      <fieldset className="mb-4 space-y-2">
        <legend className="sr-only">How to reset it</legend>
        <ModeOption
          checked={mode === "link"}
          disabled={!canEmail || busy}
          onSelect={() => {
            setMode("link");
            setError(null);
          }}
          title="Email them a reset link"
          hint={
            canEmail
              ? "They choose their own password. You never know it, and nothing changes until they use the link (it lasts 30 minutes)."
              : "Set up email in App settings to use this."
          }
        />
        <ModeOption
          checked={mode === "password"}
          disabled={busy}
          onSelect={() => {
            setMode("password");
            setError(null);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          title="Set a temporary password"
          hint="For when email isn't an option. You pass it on yourself."
        />
      </fieldset>

      {mode === "link" ? (
        <p className="text-xs text-[var(--text-muted)]">
          We&apos;ll email “{username}” a link to choose a new password. It
          shows in their Recent activity as sent by you.
        </p>
      ) : (
        <>
      <div
        className={cn(
          "mb-4 flex items-start gap-2.5 rounded-card border px-3 py-2.5 text-xs",
          "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        )}
      >
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Every device they&apos;re signed in on is signed out now, and
          they&apos;ll choose a new password when they next sign in.
          They&apos;re emailed and shown a notice that you reset it. Share the
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
        </>
      )}

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

function ModeOption({
  checked,
  disabled,
  onSelect,
  title,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-card border px-3 py-2.5",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] hover:bg-[var(--hover)]",
        disabled && !checked && "cursor-not-allowed opacity-60 hover:bg-transparent"
      )}
    >
      <input
        type="radio"
        name="reset-mode"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 accent-[var(--accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--text)]">{title}</span>
        <span className="block text-xs text-[var(--text-muted)]">{hint}</span>
      </span>
    </label>
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
