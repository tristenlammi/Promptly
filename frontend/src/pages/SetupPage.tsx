import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { ShieldCheck, Sparkles } from "lucide-react";

import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/shared/Button";

/**
 * First-run wizard shown when GET /auth/setup-status returns
 * `requires_setup: true`. Creating the initial admin both populates the DB
 * and logs us straight in as that user.
 */
export function SetupPage() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const setUser = useAuthStore((s) => s.setUser);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setStatus = useAuthStore((s) => s.setStatus);
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.setup(email.trim(), username.trim(), password);
      setUser(res.user);
      setAccessToken(res.access_token);
      setStatus("authenticated");
      navigate("/chat", { replace: true });
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(
          (err.response?.data as { detail?: string })?.detail ??
            err.message ??
            "Setup failed"
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
            <h1 className="text-lg font-semibold tracking-tight">
              Welcome to Promptly
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              Create the first administrator account to get started.
            </p>
          </div>
        </div>

        <div className="mb-4 flex items-start gap-2.5 rounded-card border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-2.5 text-xs text-[var(--text)]">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
            aria-hidden
          />
          <div className="leading-relaxed">
            This account will have full control over the server — managing
            users, model providers and everything else. You can create
            additional users from the admin panel afterwards.
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <LabeledInput
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoFocus
          />
          <LabeledInput
            label="Username"
            value={username}
            onChange={setUsername}
            required
            minLength={3}
            pattern="[A-Za-z0-9_.\-]+"
            title="Letters, numbers, dot, underscore or hyphen."
          />
          <LabeledInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            minLength={8}
            autoComplete="new-password"
          />
          <LabeledInput
            label="Confirm password"
            type="password"
            value={confirm}
            onChange={setConfirm}
            required
            minLength={8}
            autoComplete="new-password"
          />

          {error && (
            <div
              role="alert"
              className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={loading}
          >
            Create admin account
          </Button>
        </form>
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
