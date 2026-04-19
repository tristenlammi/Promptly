import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import axios from "axios";
import { Sparkles } from "lucide-react";

import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/shared/Button";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const status = useAuthStore((s) => s.status);
  const loginSuccess = useAuthStore((s) => s.loginSuccess);
  const setStatus = useAuthStore((s) => s.setStatus);
  const setPendingMfa = useAuthStore((s) => s.setPendingMfa);
  const navigate = useNavigate();

  if (status === "authenticated") {
    return <Navigate to="/chat" replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await authApi.login(email, password);
      switch (res.status) {
        case "ok":
          loginSuccess(res.user, res.access_token);
          navigate("/chat", { replace: true });
          break;
        case "mfa_required":
          setPendingMfa({
            kind: "challenge",
            token: res.challenge_token,
            method: res.method,
            emailHint: res.email_hint ?? null,
            expiresAt: Date.now() + res.expires_in * 1000,
          });
          setStatus("mfa_required");
          navigate("/mfa/verify", { replace: true });
          break;
        case "mfa_enrollment_required":
          setPendingMfa({
            kind: "enrollment",
            token: res.enrollment_token,
            expiresAt: Date.now() + res.expires_in * 1000,
          });
          setStatus("mfa_enrollment_required");
          navigate("/mfa/enroll", { replace: true });
          break;
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(
          (err.response?.data as { detail?: string })?.detail ??
            err.message ??
            "Request failed"
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Promptly</h1>
            <p className="text-xs text-[var(--text-muted)]">
              Sign in to your account
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <LabeledInput
            label="Email or username"
            type="text"
            value={email}
            onChange={setEmail}
            required
            autoFocus
            autoComplete="username"
          />
          <LabeledInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoComplete="current-password"
          />

          {error && (
            <div
              role="alert"
              className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}

          <Button type="submit" variant="primary" className="w-full" loading={loading}>
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-[var(--text-muted)]">
          Accounts are created by an administrator from the admin panel.
        </p>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
      />
    </label>
  );
}
