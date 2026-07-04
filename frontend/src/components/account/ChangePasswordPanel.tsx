import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import { authApi } from "@/api/auth";
import { toast } from "@/store/toastStore";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

/** Self-service "change your password" card (Security section).
 *
 *  Verifies the current password server-side, enforces the strength policy
 *  on the new one, and — because the server rotates ``token_version`` —
 *  swaps in the fresh access token it returns so this tab stays signed in
 *  while every OTHER session is logged out. */
const MIN_LEN = 12;

export function ChangePasswordPanel() {
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const tooShort = next.length > 0 && next.length < MIN_LEN;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 &&
    next.length >= MIN_LEN &&
    confirm === next &&
    next !== current &&
    !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await authApi.changePassword(current, next);
      if (res.access_token) setAccessToken(res.access_token);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Other sessions were signed out.");
    } catch (e: unknown) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't change your password.";
      toast.error(detail);
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
        Use at least {MIN_LEN} characters. Changing it signs out every other
        device.
      </p>
      <div className="grid max-w-md gap-2.5">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={inputCls}
        />
        <div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={cn(inputCls, tooShort && "border-[var(--danger-border)]")}
          />
          {tooShort && (
            <p className="mt-1 text-xs text-[var(--danger)]">
              At least {MIN_LEN} characters.
            </p>
          )}
        </div>
        <div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
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
        <div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Change password
          </button>
        </div>
      </div>
    </div>
  );
}
