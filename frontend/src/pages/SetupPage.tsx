import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  Cloud,
  Globe,
  HardDrive,
  ShieldCheck,
  Sparkles,
  Check,
} from "lucide-react";

import { adminApi, type OriginPreview } from "@/api/admin";
import { authApi } from "@/api/auth";
import { customModelsApi } from "@/api/customModels";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/shared/Button";

/**
 * First-run wizard shown when ``GET /auth/setup-status`` returns
 * ``requires_setup: true``.
 *
 * Step 1 — create the initial admin account (auto-logs in).
 * Step 2 — declare the public URL the operator wants to reach
 *          Promptly on. Persists to ``app_settings.public_origins``
 *          which feeds the dynamic CORS middleware on every request.
 *          Skippable for "I'll set this up later" / "I'm only using
 *          this on localhost".
 * Step 3 — pick how Custom-Model knowledge gets embedded (local
 *          Ollama vs API model). Persists to ``app_settings``.
 *
 * The user can skip steps 2 and 3 entirely; CORS will continue to
 * accept localhost requests, and Custom Models just won't be usable
 * until an embedding provider is configured from the admin panel
 * later.
 */
type Step = 1 | 2 | 3;
const TOTAL_STEPS: Step = 3;

export function SetupPage() {
  const [step, setStep] = useState<Step>(1);
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
      // Account is created and we're logged in — advance to the
      // public-URL step so CORS gets configured before the operator
      // ever tries to load Promptly from a public hostname.
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
                : step === 2
                  ? "Where will people reach Promptly?"
                  : "One last thing — how should knowledge libraries be embedded?"}
            </p>
          </div>
        </div>

        <StepDots current={step} total={TOTAL_STEPS} />

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

        {step === 2 && <PublicUrlStep onContinue={() => setStep(3)} />}

        {step === 3 && <EmbeddingStep onDone={finish} />}
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
// Step 2 — public URL / CORS
// --------------------------------------------------------------------

function PublicUrlStep({ onContinue }: { onContinue: () => void }) {
  // Default to wherever the operator is currently loading the page
  // from. On first install that's almost always ``http://localhost:8087``,
  // which is exactly what the always-allowed defaults already cover —
  // saving it is harmless and the operator can skip if they're not
  // ready to commit a real public hostname yet.
  const initial = useMemo(() => {
    if (typeof window === "undefined") return "";
    const origin = window.location.origin;
    return origin.startsWith("http") ? origin : "";
  }, []);
  const [value, setValue] = useState(initial);
  const [preview, setPreview] = useState<OriginPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Debounced preview — every keystroke would hammer the API but
  // ~400 ms after the operator stops typing is plenty quick for the
  // warning chip to feel live.
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        const result = await adminApi.previewOrigin(trimmed);
        setPreview(result);
        setPreviewError(null);
      } catch (err) {
        setPreview(null);
        setPreviewError(extractError(err, "Couldn't validate that URL."));
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [value]);

  const save = async () => {
    setSaveError(null);
    if (!preview) {
      setSaveError("Enter a valid URL first.");
      return;
    }
    setSaving(true);
    try {
      await adminApi.updateAppSettings({ public_origins: [preview.canonical] });
      onContinue();
    } catch (err) {
      setSaveError(extractError(err, "Couldn't save the public URL."));
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    // "Skip" = leave public_origins empty; localhost stays allowed by
    // the always-on defaults so the install is still reachable. The
    // admin can come back later via Admin → Settings.
    setSaving(false);
    setSkipping(true);
    try {
      onContinue();
    } finally {
      setSkipping(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        Enter the URL people will use to reach Promptly. This is what gets
        added to the CORS allow-list so logins work from a real domain.
        Localhost is always allowed — you only need this for a public
        hostname (e.g. a Cloudflare Tunnel or your own DNS name).
      </p>

      <LabeledInput
        label="Public URL"
        value={value}
        onChange={setValue}
        placeholder="https://chat.example.com"
        autoFocus
      />

      {previewError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {previewError}
        </div>
      )}

      {preview && preview.canonical !== value.trim() && (
        <div className="flex items-start gap-2 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Will be saved as{" "}
            <span className="font-mono text-[var(--text)]">
              {preview.canonical}
            </span>
          </span>
        </div>
      )}

      {preview?.warnings.map((warning, i) => (
        <div
          key={i}
          role="status"
          className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {warning}
        </div>
      ))}

      {saveError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {saveError}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          onClick={skip}
          disabled={saving}
          loading={skipping}
        >
          Skip for now
        </Button>
        <Button
          type="button"
          variant="primary"
          className="flex-1"
          onClick={save}
          disabled={!preview || skipping}
          loading={saving}
        >
          Save and continue
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Step 3 — embedding provider
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
