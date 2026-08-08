import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cloud,
  Globe,
  HardDrive,
  Mail,
  ShieldCheck,
  Sparkles,
  Check,
} from "lucide-react";

import { adminApi, type OriginPreview } from "@/api/admin";
import { authApi } from "@/api/auth";
import { apiErrorMessage } from "@/utils/apiError";
import { customModelsApi } from "@/api/customModels";
import { mfaApi } from "@/api/mfa";
import { modelsApi } from "@/api/models";
import type { ProviderType } from "@/api/types";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/shared/Button";
import { EnrollmentWizard } from "@/components/mfa/EnrollmentWizard";

/**
 * First-run wizard shown when ``GET /auth/setup-status`` returns
 * ``requires_setup: true``.
 *
 * Step 1 — create the initial admin account (auto-logs in).
 * Step 2 — connect a model provider. This one comes first among the
 *          optional-ish steps because without it the app finishes setup
 *          unable to answer a single message — the previous wizard
 *          configured SMTP and CORS but never the model, so a fresh
 *          install landed on a chat screen that couldn't reply. Auto-
 *          satisfied when ``bootstrap.py`` already seeded a provider
 *          from an ``*_API_KEY`` env var.
 * Step 3 — declare the public URL the operator wants to reach
 *          Promptly on. Persists to ``app_settings.public_origins``
 *          which feeds the dynamic CORS middleware on every request.
 *          Skippable for "I'll set this up later" / "I'm only using
 *          this on localhost".
 * Step 4 — pick how Custom-Model knowledge gets embedded (local
 *          Ollama vs API model). Persists to ``app_settings``.
 * Step 5 — outgoing email (SMTP), optional.
 * Step 6 — offer two-step verification for the freshly-created admin
 *          account (embeds the self-service ``EnrollmentWizard``).
 *
 * The user can skip steps 2–6 entirely; CORS will continue to accept
 * localhost requests, Custom Models just won't be usable until an
 * embedding provider is configured from the admin panel later, and
 * MFA stays available under Account → Security. Skipping step 2 warns
 * explicitly that chat won't work until a provider is added.
 */
type Step = 1 | 2 | 3 | 4 | 5 | 6;
const TOTAL_STEPS: Step = 6;

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

    // Mirror the backend's validation (auth/schemas.py + password_policy.py)
    // so the common mistakes never round-trip as a 422.
    const name = username.trim();
    if (name.length < 3 || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      setError(
        "Username must be at least 3 characters using only letters, numbers, dots, dashes or underscores (no spaces)."
      );
      return;
    }
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    if (!/\d/.test(password)) {
      setError("Password must include at least one number.");
      return;
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      setError("Password must include at least one symbol (like ! @ # or -).");
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
      // NOTE: deliberately NOT flipping auth status to "authenticated" here.
      // The whole wizard only renders while status is "needs_setup"
      // (App.tsx), and the authenticated branch redirects /setup → /chat — so
      // flipping it at account-creation time booted the operator straight
      // into the app and made every step after this one unreachable. The
      // remaining steps still make authenticated calls: the axios client
      // reads `accessToken`, which is set above, and never looks at `status`.
      // The flip happens in `finish()` instead.
      setStep(2);
    } catch (err) {
      setError(extractError(err, "Setup failed"));
    } finally {
      setLoading(false);
    }
  };

  /** Leaving the wizard is the one place auth status flips to
   *  "authenticated" — that's what swaps App.tsx over to the real app
   *  routes. Must happen before the navigate, or the "needs_setup"
   *  catch-all bounces /chat straight back to /setup. */
  const finish = () => {
    setStatus("authenticated");
    navigate("/chat", { replace: true });
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
              {step === 1
                ? "Create the first administrator account to get started."
                : step === 2
                  ? "Connect a model so Promptly can answer."
                  : step === 3
                    ? "Where will people reach Promptly?"
                    : step === 4
                      ? "Choose an embedding model — the one that powers search."
                      : step === 5
                        ? "Set up outgoing email (optional)."
                        : "One last thing — protect your admin account."}
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

        {step === 2 && <ProviderStep onDone={() => setStep(3)} />}

        {step === 3 && <PublicUrlStep onContinue={() => setStep(4)} />}

        {step === 4 && <EmbeddingStep onDone={() => setStep(5)} />}

        {step === 5 && <EmailStep onDone={() => setStep(6)} />}

        {step === 6 && <MfaStep email={email} onFinish={finish} />}
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
          minLength={10}
          autoComplete="new-password"
        />
        <p className="text-[11px] text-[var(--text-muted)]">
          At least 10 characters, including a number and a symbol.
        </p>
        <LabeledInput
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={onConfirm}
          required
          minLength={10}
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
// Step 3 — public URL / CORS
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
// Step 4 — embedding model
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
      {/* Say what this is, plainly and up front. The old copy opened with a
          paragraph about Custom Models and buried "pick an embedding backend"
          at the end — and because the tiles looked almost identical to the
          chat-provider tiles two steps earlier, it read as picking the same
          thing twice. Name the thing, then say how it differs from the chat
          model. */}
      <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
        <div className="text-sm font-medium text-[var(--text)]">
          Embedding model
        </div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
          This is the model that powers{" "}
          <span className="font-medium text-[var(--text)]">search</span> — it
          turns your files, notes and workspace content into vectors so
          Promptly can find the relevant parts to answer from.
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
          It's{" "}
          <span className="font-medium text-[var(--text)]">
            not the chat model
          </span>{" "}
          you connected earlier and it never writes replies. Without one, file
          search and workspace knowledge stay switched off.
        </p>
      </div>

      <p className="text-xs leading-relaxed text-[var(--text-muted)]">
        You can change this later in Admin → Models.
      </p>

      <ProviderCard
        icon={<HardDrive className="h-5 w-5" />}
        title="Local embedding model"
        subtitle="Bundled Ollama — runs entirely on this server. Recommended."
        bullet="Downloads nomic-embed-text (270 MB) automatically"
        selected={choice === "local"}
        loading={loading && choice === "local"}
        disabled={done || loading}
        onClick={() => choose("local")}
      />

      {/* This tile configures nothing — it defers to the admin panel. The old
          "API provider" label implied it set something up here. */}
      <ProviderCard
        icon={<Cloud className="h-5 w-5" />}
        title="Cloud embedding model — set up later"
        subtitle="OpenAI, Gemini, or any OpenAI-compatible API."
        bullet="Nothing is configured now; you'll finish this in Admin → Models"
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

      {/* Confirm what actually happened — picking a tile used to do nothing
          visible except enable Continue, which left "did that work?" open. */}
      {done && !error && (
        <div
          className={[
            "rounded-card border px-3 py-2 text-xs",
            choice === "local"
              ? "border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]"
              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
          ].join(" ")}
        >
          {choice === "local"
            ? "Local embedding model configured — file and workspace search are on."
            : "No embedding model set yet. File and workspace search stay off until you add one in Admin → Models."}
        </div>
      )}

      <Button
        type="button"
        variant="primary"
        className="w-full"
        disabled={!done}
        onClick={onDone}
      >
        Continue
      </Button>
    </div>
  );
}

// --------------------------------------------------------------------
// Step 2 — connect a model provider
// --------------------------------------------------------------------

/** The handful of providers worth offering during first-run. Everything else
 *  (Gemini, DeepSeek, Atlas, any OpenAI-compatible endpoint) is available in
 *  Admin → Models afterwards; this step optimises for "get to a working chat",
 *  not for completeness. `base_url` is left null on purpose — the backend
 *  resolves a per-type default at call time (models_config/provider.py). */
const SETUP_PROVIDERS: {
  type: ProviderType;
  name: string;
  title: string;
  subtitle: string;
  bullet: string;
  keyless?: boolean;
  keyHint?: string;
}[] = [
  {
    type: "openrouter",
    name: "OpenRouter",
    title: "OpenRouter",
    subtitle: "One key, 300+ models. Recommended.",
    bullet: "Anthropic, OpenAI, Google, Llama and more from a single key",
    keyHint: "sk-or-...",
  },
  {
    type: "anthropic",
    name: "Anthropic",
    title: "Anthropic",
    subtitle: "Claude models, direct from Anthropic.",
    bullet: "console.anthropic.com → API keys",
    keyHint: "sk-ant-...",
  },
  {
    type: "openai",
    name: "OpenAI",
    title: "OpenAI",
    subtitle: "GPT models, direct from OpenAI.",
    bullet: "platform.openai.com → API keys",
    keyHint: "sk-...",
  },
  {
    type: "ollama",
    name: "Ollama",
    title: "Local (Ollama)",
    subtitle: "Models running on this machine. No API key.",
    bullet: "Expects Ollama on http://localhost:11434",
    keyless: true,
  },
];

function ProviderStep({ onDone }: { onDone: () => void }) {
  const [picked, setPicked] = useState<ProviderType | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [modelCount, setModelCount] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);

  const choice = SETUP_PROVIDERS.find((p) => p.type === picked) ?? null;

  // An operator who set OPENROUTER_API_KEY (or similar) in .env already has a
  // provider seeded by bootstrap.py — don't make them configure a second one.
  useEffect(() => {
    let alive = true;
    modelsApi
      .list()
      .then((providers) => {
        if (!alive) return;
        const existing = providers.find((p) => p.enabled);
        if (existing) {
          setDone(true);
          setModelCount(existing.models?.length ?? 0);
          setPicked(existing.type);
        }
      })
      .catch(() => {
        /* Non-fatal — fall through to the manual form. */
      })
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, []);

  const connect = async () => {
    if (!choice) return;
    setError(null);
    setLoading(true);
    try {
      const provider = await modelsApi.create({
        name: choice.name,
        type: choice.type,
        // Null base_url → the backend's per-type default applies.
        base_url: null,
        api_key: choice.keyless ? null : apiKey.trim(),
        enabled: true,
      });
      // Creating a provider doesn't populate its model list; without this the
      // chat picker would still be empty and setup would "succeed" into the
      // exact broken state this step exists to prevent.
      let count = 0;
      try {
        const withModels = await modelsApi.fetchModels(provider.id);
        count = withModels.models?.length ?? 0;
      } catch {
        // The provider saved fine but the model list couldn't be fetched
        // (bad key, provider down, Ollama not running). Say so rather than
        // silently continuing — but keep the provider so it can be fixed
        // in Admin → Models instead of re-entered.
        setError(
          "Saved, but couldn't load models from that provider. Check the API key (or that Ollama is running), then use Refresh models in Admin → Models."
        );
        setDone(true);
        setModelCount(0);
        return;
      }
      setModelCount(count);
      setDone(true);
    } catch (err) {
      setError(extractError(err, "Could not connect that provider"));
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="py-6 text-center text-xs text-[var(--text-muted)]">
        Checking for existing providers…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">
        Promptly needs at least one model provider before it can answer
        anything. Pick one now — you can add more later in Admin → Models.
      </p>

      {!done &&
        SETUP_PROVIDERS.map((p) => (
          <ProviderCard
            key={p.type}
            icon={p.type === "ollama" ? <HardDrive className="h-5 w-5" /> : <Cloud className="h-5 w-5" />}
            title={p.title}
            subtitle={p.subtitle}
            bullet={p.bullet}
            selected={picked === p.type}
            disabled={loading}
            onClick={() => {
              setPicked(p.type);
              setError(null);
              setSkipped(false);
            }}
          />
        ))}

      {!done && choice && !choice.keyless && (
        <div className="space-y-1">
          <label
            htmlFor="setup-api-key"
            className="text-xs font-medium text-[var(--text-muted)]"
          >
            {choice.name} API key
          </label>
          <input
            id="setup-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={choice.keyHint}
            disabled={loading}
            className="w-full rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <p className="text-[11px] text-[var(--text-muted)]">
            Stored encrypted on this server. It never leaves your instance
            except to call {choice.name}.
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {done && !error && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
          {modelCount
            ? `Connected — ${modelCount} model${modelCount === 1 ? "" : "s"} available.`
            : "Provider connected."}
        </div>
      )}

      {skipped && (
        <div
          role="alert"
          className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          Chat won't work until you add a provider. You can do it any time from
          Admin → Models.
        </div>
      )}

      {!done && (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={!choice || loading || (!choice.keyless && !apiKey.trim())}
          onClick={connect}
        >
          {loading ? "Connecting…" : "Connect"}
        </Button>
      )}

      {done ? (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          onClick={onDone}
        >
          Continue
        </Button>
      ) : skipped ? (
        <button
          type="button"
          onClick={onDone}
          className="w-full text-center text-xs text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
        >
          Continue without a provider
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setSkipped(true)}
          className="w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Skip for now
        </button>
      )}
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
// Step 5 — outgoing email (SMTP)
// --------------------------------------------------------------------

function EmailStep({ onDone }: { onDone: () => void }) {
  const [fromAddress, setFromAddress] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Display name recipients see in the From header. Fixed here to keep the
  // wizard compact; editable later under Admin → Settings.
  const fromName = "Promptly";
  const [useTls, setUseTls] = useState(true);

  const [detecting, setDetecting] = useState(false);
  const [providerNote, setProviderNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; msg: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const isGmail = /@(gmail|googlemail)\.com$/i.test(fromAddress.trim());
  const canSave =
    fromAddress.trim() !== "" && host.trim() !== "" && port.trim() !== "";

  // Type the address → look up the servers (Mozilla ISPDB). Best-effort:
  // silently leaves the fields for manual entry if there's no match.
  const detect = async (addr: string) => {
    const email = addr.trim();
    if (!email.includes("@")) return;
    setDetecting(true);
    setProviderNote(null);
    try {
      const cfg = await adminApi.emailAutoconfig(email);
      if (cfg.found) {
        if (cfg.host) setHost(cfg.host);
        if (cfg.port) setPort(String(cfg.port));
        if (typeof cfg.use_tls === "boolean") setUseTls(cfg.use_tls);
        setUsername(cfg.username || email);
        if (cfg.note) setProviderNote(cfg.note);
      } else {
        // No ISPDB entry — default the username to the address and let the
        // operator fill the server in by hand.
        setUsername((u) => u || email);
      }
    } catch {
      setUsername((u) => u || email);
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await adminApi.updateAppSettings({
        smtp_host: host.trim(),
        smtp_port: Number(port),
        smtp_username: username.trim() || null,
        // Only send the password when the operator typed one (empty string
        // would clear it server-side).
        ...(password ? { smtp_password: password } : {}),
        smtp_use_tls: useTls,
        smtp_from_address: fromAddress.trim(),
        smtp_from_name: fromName.trim() || null,
      });
      setSaved(true);
      setTestResult(null);
    } catch (err) {
      setError(extractError(err, "Couldn't save the email settings."));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await adminApi.sendTestEmail();
      setTestResult({
        ok: true,
        msg: `Test email sent to ${fromAddress.trim()}. Check your inbox.`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        msg: extractError(err, "Couldn't send the test email."),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-xs text-[var(--text-muted)]">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
        <div className="leading-relaxed">
          Connect an email account so Promptly can send things like sign-in
          codes, <span className="text-[var(--text)]">notifications</span>,{" "}
          <span className="text-[var(--text)]">automations</span>, and{" "}
          <span className="text-[var(--text)]">feedback</span>. Optional — you
          can skip and set this up later in Admin → Settings.
        </div>
      </div>

      <LabeledInput
        label="Your email address"
        type="email"
        value={fromAddress}
        onChange={(v) => {
          setFromAddress(v);
          setSaved(false);
        }}
        onBlur={() => void detect(fromAddress)}
        placeholder="you@example.com"
        autoFocus
      />
      {detecting && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Looking up your provider's settings…
        </p>
      )}
      {isGmail && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Using Gmail? You'll need an{" "}
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] underline"
          >
            App Password
          </a>{" "}
          (turn on 2-Step Verification first) — your normal password won't work.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <LabeledInput
          label="SMTP host"
          value={host}
          onChange={(v) => {
            setHost(v);
            setSaved(false);
          }}
          placeholder="smtp.gmail.com"
        />
        <LabeledInput
          label="Port"
          value={port}
          onChange={(v) => {
            setPort(v.replace(/[^0-9]/g, ""));
            setSaved(false);
          }}
          placeholder="587"
          inputMode="numeric"
        />
      </div>
      <LabeledInput
        label="Username"
        value={username}
        onChange={(v) => {
          setUsername(v);
          setSaved(false);
        }}
        placeholder="you@example.com"
        autoComplete="off"
      />
      <LabeledInput
        label={isGmail ? "App password" : "Password"}
        type="password"
        value={password}
        onChange={(v) => {
          setPassword(v);
          setSaved(false);
        }}
        autoComplete="new-password"
      />
      <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <input
          type="checkbox"
          checked={useTls}
          onChange={(e) => {
            setUseTls(e.target.checked);
            setSaved(false);
          }}
        />
        Use encryption (TLS / STARTTLS — recommended)
      </label>

      {providerNote && (
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {providerNote}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}
      {testResult && (
        <div
          role="status"
          className={[
            "rounded-card border px-3 py-2 text-xs",
            testResult.ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
          ].join(" ")}
        >
          {testResult.msg}
        </div>
      )}

      {!saved ? (
        <div className="flex gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={onDone}
            disabled={saving}
          >
            Skip for now
          </Button>
          <Button
            type="button"
            variant="primary"
            className="flex-1"
            onClick={save}
            disabled={!canSave}
            loading={saving}
          >
            Save
          </Button>
        </div>
      ) : (
        <div className="flex gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={sendTest}
            loading={testing}
          >
            Send test email
          </Button>
          <Button
            type="button"
            variant="primary"
            className="flex-1"
            onClick={onDone}
          >
            Continue
          </Button>
        </div>
      )}
    </div>
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

/** Step 6 — offer MFA for the freshly-created admin account. Embeds the
 *  same self-service ``EnrollmentWizard`` the settings panel uses (we're
 *  authenticated by now, so the regular session endpoints apply). */
function MfaStep({ email, onFinish }: { email: string; onFinish: () => void }) {
  const [enrolling, setEnrolling] = useState(false);

  if (enrolling) {
    return (
      <EnrollmentWizard
        api={{
          beginTotp: mfaApi.beginTotp,
          verifyTotp: mfaApi.verifyTotp,
          beginEmail: mfaApi.beginEmail,
          verifyEmail: mfaApi.verifyEmail,
        }}
        defaultEmail={email}
        heading="Choose your second factor"
        subheading="Pick a method to verify it's you on every sign-in."
        onComplete={onFinish}
        onCancel={() => setEnrolling(false)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--bg)] p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
        <div>
          <p className="text-sm font-medium">Two-step verification</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            This is the administrator account for your whole install — with
            MFA, a stolen password alone can't get in. Takes about a minute
            with an authenticator app or email codes. You can also set it up
            any time under Account → Security.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => setEnrolling(true)}>
          Set up MFA
        </Button>
        <Button variant="secondary" className="flex-1" onClick={onFinish}>
          Skip for now
        </Button>
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

function extractError(err: unknown, fallback: string): string {
  // 422 validation errors carry an *array* of Pydantic items in
  // ``detail`` — apiErrorMessage flattens every shape to a string so
  // the wizard can never feed an object into JSX (React error #31).
  return apiErrorMessage(err, fallback);
}
