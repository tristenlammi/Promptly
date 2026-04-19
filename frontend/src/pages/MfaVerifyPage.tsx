import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import axios from "axios";
import { Mail, ShieldCheck, Smartphone } from "lucide-react";

import { mfaApi } from "@/api/mfa";
import { Button } from "@/components/shared/Button";
import { useAuthStore } from "@/store/authStore";

/** Login challenge — second-factor screen reached after a password OK. */
export function MfaVerifyPage() {
  const pendingMfa = useAuthStore((s) => s.pendingMfa);
  const loginSuccess = useAuthStore((s) => s.loginSuccess);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  // ``useBackup`` toggles the input from method-specific (TOTP digits
  // or email OTP) to the longer XXXX-XXXX backup-code field. Surfaced
  // as a small text link below the main input rather than as a tab,
  // because the path is meant to feel like an escape hatch, not a
  // first-class option.
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendInfo, setResendInfo] = useState<string | null>(null);

  // Send the initial email OTP if we landed here for an email-method
  // user and the backend's best-effort send during /auth/login failed
  // (or, more usefully, as a manual "didn't get it?" trigger).
  // We only auto-trigger on the "Resend" button to avoid silently
  // burning the per-user cooldown on every refresh.

  // Bounce the user back to the login screen if the challenge token
  // expired or they refreshed the tab and lost it.
  useEffect(() => {
    if (!pendingMfa || pendingMfa.kind !== "challenge") return;
    const remaining = pendingMfa.expiresAt - Date.now();
    if (remaining <= 0) {
      clear();
      navigate("/login", { replace: true });
      return;
    }
    const t = setTimeout(() => {
      clear();
      navigate("/login", { replace: true });
    }, remaining);
    return () => clearTimeout(t);
  }, [pendingMfa, clear, navigate]);

  if (!pendingMfa || pendingMfa.kind !== "challenge") {
    return <Navigate to="/login" replace />;
  }

  const isEmail = pendingMfa.method === "email";
  const isTotp = pendingMfa.method === "totp";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const trimmed = code.trim();
    try {
      const body: Parameters<typeof mfaApi.verifyChallenge>[1] = {
        trust_device: trustDevice,
      };
      if (useBackup) body.backup_code = trimmed;
      else if (isTotp) body.totp_code = trimmed;
      else body.email_code = trimmed;

      const res = await mfaApi.verifyChallenge(pendingMfa.token, body);
      loginSuccess(res.user, res.access_token);
      navigate("/chat", { replace: true });
    } catch (err) {
      const detail =
        axios.isAxiosError(err) &&
        (err.response?.data as { detail?: string })?.detail;
      setError(detail || "Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    if (!isEmail) return;
    setResending(true);
    setResendInfo(null);
    setError(null);
    try {
      const res = await mfaApi.sendEmailOtpForChallenge(pendingMfa.token);
      setResendInfo(`Code sent to ${res.email_hint}.`);
    } catch (err) {
      const detail =
        axios.isAxiosError(err) &&
        (err.response?.data as { detail?: string })?.detail;
      setError(detail || "Could not resend code.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Two-step verification
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              {useBackup
                ? "Enter one of your backup codes."
                : isTotp
                  ? "Enter the 6-digit code from your authenticator app."
                  : `We sent a code to ${pendingMfa.emailHint ?? "your inbox"}.`}
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex items-center gap-2 rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
            {useBackup ? (
              <ShieldCheck className="h-4 w-4 text-[var(--text-muted)]" />
            ) : isTotp ? (
              <Smartphone className="h-4 w-4 text-[var(--text-muted)]" />
            ) : (
              <Mail className="h-4 w-4 text-[var(--text-muted)]" />
            )}
            <input
              autoFocus
              autoComplete="one-time-code"
              inputMode={useBackup ? "text" : "numeric"}
              pattern={useBackup ? undefined : "[0-9]*"}
              maxLength={useBackup ? 20 : 6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={useBackup ? "XXXX-XXXX" : "123456"}
              className="w-full bg-transparent text-base tracking-[0.3em] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={trustDevice}
              onChange={(e) => setTrustDevice(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Trust this device for 30 days
          </label>

          {error && (
            <div
              role="alert"
              className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}
          {resendInfo && (
            <div className="rounded-card border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              {resendInfo}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={loading}
            disabled={!code.trim()}
          >
            Verify
          </Button>
        </form>

        <div className="mt-4 flex items-center justify-between text-xs text-[var(--text-muted)]">
          <button
            type="button"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode("");
              setError(null);
            }}
            className="underline-offset-2 hover:underline"
          >
            {useBackup ? "Use your normal code" : "Use a backup code"}
          </button>
          {isEmail && !useBackup && (
            <button
              type="button"
              onClick={onResend}
              disabled={resending}
              className="underline-offset-2 hover:underline disabled:opacity-50"
            >
              {resending ? "Sending..." : "Resend code"}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            clear();
            navigate("/login", { replace: true });
          }}
          className="mt-6 block w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Cancel and return to sign-in
        </button>
      </div>
    </div>
  );
}
