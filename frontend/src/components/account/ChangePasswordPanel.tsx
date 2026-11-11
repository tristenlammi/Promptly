import { useState } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";

import { authApi } from "@/api/auth";
import { usePasswordPolicy } from "@/hooks/usePasswordPolicy";
import { toast, useToastStore } from "@/store/toastStore";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";

import { PasswordChecklist, passwordMeetsRules } from "./PasswordChecklist";

/** Self-service "change your password" card (Security section).
 *
 *  Verifies the current password server-side, enforces the strength policy
 *  on the new one, and — because the server rotates ``token_version`` —
 *  swaps in the fresh access token it returns so this tab stays signed in
 *  while every OTHER session is logged out. */

export function ChangePasswordPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const policy = usePasswordPolicy();
  const MIN_LEN = policy.min_length;
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  // The server's answer, shown in the form (not a toast that outlives it).
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== next;
  const sameAsOld = next.length > 0 && next === current;
  const canSubmit =
    current.length > 0 &&
    passwordMeetsRules(next, MIN_LEN) &&
    confirm === next &&
    next !== current &&
    !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authApi.changePassword(current, next);
      if (res.access_token) setAccessToken(res.access_token);
      // Clears must_change_password, which lifts the first-sign-in gate.
      if (res.user) setUser(res.user);
      setCurrent("");
      setNext("");
      setConfirm("");
      // An error toast from an earlier try would otherwise still be up.
      useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.type !== "error") }));
      setDone(true);
      toast.success("Your new password is saved. Other devices were signed out.");
      onChanged?.();
    } catch (e: unknown) {
      setError(apiErrorMessage(e, "Couldn't change your password. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)]";

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <KeyRound className="h-4 w-4 text-[var(--text-muted)]" />
        Password
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        {policy.summary} Changing it signs out every other device.
      </p>
      <form
        className="grid max-w-md gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          aria-label="Current password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
            setDone(false);
          }}
          className={inputCls}
        />
        <div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            aria-label="New password"
            aria-describedby="new-password-rules"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setError(null);
              setDone(false);
            }}
            className={inputCls}
          />
          <PasswordChecklist id="new-password-rules" password={next} minLength={MIN_LEN} />
          {sameAsOld && (
            <p className="mt-1 text-xs text-[var(--danger)]">Choose a different password from your current one.</p>
          )}
        </div>
        <div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            aria-label="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={cn(inputCls, mismatch && "border-[var(--danger-border)]")}
          />
          {mismatch && (
            <p className="mt-1 text-xs text-[var(--danger)]">
              Passwords don't match.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" data-testid="password-error" className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-[var(--success)]">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Password changed.
          </p>
        )}
        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-strong)] px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Change password
          </button>
        </div>
      </form>
    </div>
  );
}
