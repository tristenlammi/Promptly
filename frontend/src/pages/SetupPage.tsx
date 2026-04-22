import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  Cloud,
  HardDrive,
  ShieldCheck,
  Sparkles,
  Check,
} from "lucide-react";

import { authApi } from "@/api/auth";
import { customModelsApi } from "@/api/customModels";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/shared/Button";

/**
 * First-run wizard shown when GET /auth/setup-status returns
 * ``requires_setup: true``.
 *
 * Step 1 — create the initial admin account (auto-logs in).
 * Step 2 — pick how Custom-Model knowledge gets embedded (local
 *   Ollama vs API model). Persists to ``app_settings``.
 *
 * The user can skip step 2 entirely; Custom Models just won't be
 * usable until an embedding provider is configured from the admin
 * panel later.
 */
export function SetupPage() {
  const [step, setStep] = useState<1 | 2>(1);
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

  const onSubmitAccount = async (e: FormEvent) => {
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
      // Do NOT navigate yet — we still need the embedding choice.
      setStep(2);
    } catch (err) {
      setError(extractError(err, "Setup failed"));
    } finally {
      setLoading(false);
    }
  };

  const finish = () => navigate("/chat", { replace: true });

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
              {step === 1
                ? "Create the first administrator account to get started."
                : "One last thing — how should knowledge libraries be embedded?"}
            </p>
          </div>
        </div>

        <StepDots current={step} total={2} />

        {step === 1 && (
          <AccountStep
            email={email}
            onEmail={setEmail}
            username={username}
            onUsername={setUsername}
            password={password}
            onPassword={setPassword}
            confirm={confirm}
            onConfirm={setConfirm}
            onSubmit={onSubmitAccount}
            loading={loading}
            error={error}
          />
        )}

        {step === 2 && <EmbeddingStep onDone={finish} />}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Step 1 — admin account
// --------------------------------------------------------------------

function AccountStep({
  email,
  onEmail,
  username,
  onUsername,
  password,
  onPassword,
  confirm,
  onConfirm,
  onSubmit,
  loading,
  error,
}: {
  email: string;
  onEmail: (v: string) => void;
  username: string;
  onUsername: (v: string) => void;
  password: string;
  onPassword: (v: string) => void;
  confirm: string;
  onConfirm: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <>
      <div className="mb-4 flex items-start gap-2.5 rounded-card border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-2.5 text-xs text-[var(--text)]">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
          aria-hidden
        />
        <div className="leading-relaxed">
          This account will have full control over the server — managing users,
          model providers and everything else. You can create additional users
          from the admin panel afterwards.
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <LabeledInput
          label="Email"
          type="email"
          value={email}
          onChange={onEmail}
          required
          autoFocus
        />
        <LabeledInput
          label="Username"
          value={username}
          onChange={onUsername}
          required
          minLength={3}
          pattern="[A-Za-z0-9_.\-]+"
          title="Letters, numbers, dot, underscore or hyphen."
        />
        <LabeledInput
          label="Password"
          type="password"
          value={password}
          onChange={onPassword}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <LabeledInput
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={onConfirm}
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
          Continue
        </Button>
      </form>
    </>
  );
}

// --------------------------------------------------------------------
// Step 2 — embedding provider
// --------------------------------------------------------------------

function EmbeddingStep({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState<"local" | "skip" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const choose = async (pick: "local" | "skip") => {
    setError(null);
    setChoice(pick);
    if (pick === "skip") {
      setDone(true);
      return;
    }
    setLoading(true);
    try {
      await customModelsApi.bootstrapLocalEmbedding();
      setDone(true);
    } catch (err) {
      setError(extractError(err, "Could not configure local embeddings"));
      setChoice(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        Custom Models let you attach a knowledge library of files. Those files
        get chunked and embedded so the model can retrieve relevant context at
        chat time. Pick an embedding backend — you can change this later in
        Admin → Models.
      </p>

      <ProviderCard
        icon={<HardDrive className="h-5 w-5" />}
        title="Local (Ollama)"
        subtitle="Bundled — runs entirely on this server. Recommended."
        bullet="Uses nomic-embed-text (270 MB, downloaded automatically)"
        selected={choice === "local"}
        loading={loading && choice === "local"}
        disabled={done || loading}
        onClick={() => choose("local")}
      />

      <ProviderCard
        icon={<Cloud className="h-5 w-5" />}
        title="API provider"
        subtitle="Use OpenAI, Gemini, or another OpenAI-compatible API."
        bullet="Configure in Admin → Models after setup finishes"
        selected={choice === "skip"}
        disabled={done || loading}
        onClick={() => choose("skip")}
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
        type="button"
        variant="primary"
        className="w-full"
        disabled={!done}
        onClick={onDone}
      >
        Finish setup
      </Button>
    </div>
  );
}

function ProviderCard({
  icon,
  title,
  subtitle,
  bullet,
  selected,
  loading,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  bullet: string;
  selected: boolean;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "w-full rounded-card border px-3 py-3 text-left transition",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-[var(--border)] hover:border-[var(--accent)]/50",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div
          className={[
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            selected
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--bg)] text-[var(--text-muted)]",
          ].join(" ")}
        >
          {loading ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : selected ? (
            <Check className="h-4 w-4" />
          ) : (
            icon
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-[var(--text-muted)]">{subtitle}</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            {bullet}
          </div>
        </div>
      </div>
    </button>
  );
}

// --------------------------------------------------------------------
// Shared UI bits
// --------------------------------------------------------------------

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <div
          key={n}
          className={[
            "h-1 flex-1 rounded-full transition",
            n === current
              ? "bg-[var(--accent)]"
              : n < current
                ? "bg-[var(--accent)]/40"
                : "bg-[var(--border)]",
          ].join(" ")}
        />
      ))}
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

function extractError(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    return (
      (err.response?.data as { detail?: string })?.detail ??
      err.message ??
      fallback
    );
  }
  return err instanceof Error ? err.message : String(err);
}
