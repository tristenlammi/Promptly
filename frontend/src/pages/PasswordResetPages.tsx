import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * "Forgot password?" — an emailed, single-use, 30-minute link (R-191).
 * There used to be no way back in without an admin.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't send that — try again in a minute."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Reset your password">
      {sent ? (
        <p className="text-sm text-[var(--text-muted)]">
          If that address has an account, we've emailed a link to reset the
          password. It works once, for 30 minutes. No email? This server may not
          be set up to send any — ask your administrator to reset it.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Your email address" type="email" value={email} onChange={setEmail} autoComplete="email" />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!email.trim()}>
            Email me a link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-xs">
        <Link to="/login" className="text-[var(--accent-text)] underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </p>
    </Card>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.resetPassword(token, password);
      navigate("/login?signed_out=password_reset", { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't reset the password."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Choose a new password">
      {!token ? (
        <Alert>This link is incomplete. Open the link from the email again.</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
          <Field label="Confirm new password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!password || !confirm}>
            Set password
          </Button>
        </form>
      )}
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required
        className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
      />
    </label>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
    >
      {children}
    </div>
  );
}
