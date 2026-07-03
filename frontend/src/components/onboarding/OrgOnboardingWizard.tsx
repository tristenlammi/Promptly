import { useEffect, useMemo, useState, type FormEvent } from "react";
import axios from "axios";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  GraduationCap,
  KeyRound,
  Loader2,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import {
  PROVIDER_SPECS,
  specFor,
} from "@/components/models/AddProviderModal";
import {
  useAvailableModels,
  useCreateProvider,
  useProviders,
} from "@/hooks/useProviders";
import { useUpdateOrgDefaults } from "@/hooks/useAdminUsers";
import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";
import type { AvailableModel, ProviderType } from "@/api/types";

type Step = 1 | 2 | 3;

/**
 * Post-signup onboarding for a new **org admin**. Three steps:
 *
 *   1. Connect a model provider (BYOK) — reuses {@link useCreateProvider}.
 *   2. Pick the org's default chat model (and, optionally, turn on Study).
 *      Study is OFF by default; when left off it's hidden from the admin's
 *      own nav so a fresh org isn't cluttered with a feature it isn't using.
 *   3. Confirmation → mark ``onboarding_completed`` and enter the app.
 *
 * Every step is skippable — the wizard guides, it doesn't trap. Skipping
 * still sets the completed flag so it never nags again. Gating (who sees
 * this, and when) lives in {@link OrgOnboardingGate}.
 */
export function OrgOnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>(1);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-4 py-10">
        <StepDots current={step} />
        {step === 1 && (
          <ProviderStep onNext={() => setStep(2)} onSkip={onDone} />
        )}
        {step === 2 && (
          <DefaultsStep
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && <DoneStep onFinish={onDone} />}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Shared UI
// --------------------------------------------------------------------
function StepDots({ current }: { current: Step }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-2">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={cn(
            "h-1.5 rounded-full transition-all",
            n === current
              ? "w-6 bg-[var(--accent)]"
              : n < current
                ? "w-1.5 bg-[var(--accent)]"
                : "w-1.5 bg-[var(--border)]"
          )}
        />
      ))}
    </div>
  );
}

function Card({
  icon,
  title,
  subtitle,
  children,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/12 text-[var(--accent)]">
          {icon}
        </div>
        <div>
          <h1 className="text-base font-semibold text-[var(--text)]">{title}</h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">{subtitle}</p>
        </div>
      </div>
      {children}
      <div className="mt-6 flex items-center gap-2">{footer}</div>
    </div>
  );
}

/** Grouped model picker shared by the chat / study selects. */
function ModelSelect({
  value,
  onChange,
  models,
  loading,
  offLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  models: AvailableModel[];
  loading: boolean;
  offLabel: string;
  disabled?: boolean;
}) {
  const grouped = useMemo(() => {
    const byProvider = new Map<string, AvailableModel[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider_name) ?? [];
      list.push(m);
      byProvider.set(m.provider_name, list);
    }
    return Array.from(byProvider.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  }, [models]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      className={cn(
        "w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]",
        "focus:border-[var(--accent)]/60 focus:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      <option value="">{offLabel}</option>
      {grouped.map(([providerName, entries]) => (
        <optgroup key={providerName} label={providerName}>
          {entries.map((m) => (
            <option
              key={`${m.provider_id}::${m.model_id}`}
              value={`${m.provider_id}::${m.model_id}`}
            >
              {m.display_name || m.model_id}
              {m.is_custom ? " (custom)" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function splitKey(key: string): { provider_id: string; model_id: string } | null {
  if (!key) return null;
  const [provider_id, ...rest] = key.split("::");
  const model_id = rest.join("::");
  if (!provider_id || !model_id) return null;
  return { provider_id, model_id };
}

// --------------------------------------------------------------------
// Step 1 — connect a provider (BYOK)
// --------------------------------------------------------------------
function ProviderStep({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}) {
  const create = useCreateProvider();
  const { data: providers } = useProviders();
  const [type, setType] = useState<ProviderType>("openrouter");
  const [name, setName] = useState(specFor("openrouter").defaultName);
  const [nameTouched, setNameTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const spec = specFor(type);
  // If the org already has a provider (e.g. added in a prior half-finished
  // run), let them move straight on.
  const hasProvider = (providers ?? []).length > 0;

  const handleType = (next: ProviderType) => {
    setType(next);
    if (!nameTouched) setName(specFor(next).defaultName);
    setApiKey("");
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedKey = apiKey.trim();
    if (!spec.keyless && !trimmedKey) {
      setError(`${spec.label} requires an API key.`);
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim() || spec.defaultName,
        type,
        base_url: baseUrl.trim() || null,
        api_key: trimmedKey || null,
        enabled: true,
      });
      onNext();
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(
          (err.response?.data as { detail?: string })?.detail ??
            err.message ??
            "Couldn't connect that provider."
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <Card
      icon={<KeyRound className="h-5 w-5" />}
      title="Connect your first model provider"
      subtitle="Bring your own key — it's encrypted at rest and shared across your organisation, so your team inherits it automatically."
      footer={
        <>
          <button
            type="button"
            onClick={onSkip}
            className="mr-auto text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Skip for now
          </button>
          {hasProvider && (
            <Button variant="ghost" size="sm" onClick={onNext}>
              Continue with existing
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={(e) => submit(e as unknown as FormEvent)}
            loading={create.isPending}
          >
            Connect &amp; continue
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Provider
          </span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PROVIDER_SPECS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleType(opt.value)}
                className={cn(
                  "rounded-card border px-3 py-2 text-left text-xs transition",
                  type === opt.value
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)]/40"
                )}
              >
                <div className="font-medium">{opt.label}</div>
                {opt.hint && <div className="mt-0.5 text-[10px]">{opt.hint}</div>}
              </button>
            ))}
          </div>
        </div>

        <Field label="Display name">
          <TextInput
            value={name}
            onChange={(v) => {
              setName(v);
              setNameTouched(true);
            }}
            placeholder={`My ${spec.defaultName}`}
          />
        </Field>

        <Field label={spec.keyless ? "API key (optional)" : "API key"}>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            type="password"
            placeholder={spec.apiKeyPlaceholder}
            disabled={spec.keyless}
          />
        </Field>

        <Field
          label="Base URL"
          hint={
            type === "openai_compatible"
              ? "Required for OpenAI-compatible providers (e.g. vLLM, LocalAI)."
              : "Optional — leave blank to use the provider's default."
          }
        >
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder={spec.baseUrlHint}
          />
        </Field>

        {error && (
          <div
            role="alert"
            className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </div>
        )}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Card>
  );
}

// --------------------------------------------------------------------
// Step 2 — pick the org's default models
// --------------------------------------------------------------------
function DefaultsStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const { data: models, isLoading } = useAvailableModels();
  const update = useUpdateOrgDefaults();
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);
  const hiddenNav = useAuthStore((s) => s.user?.settings?.hidden_nav);

  const [chatKey, setChatKey] = useState("");
  const [studyOn, setStudyOn] = useState(false);
  const [studyKey, setStudyKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const list = models ?? [];

  // Default the chat picker to the first available model so a one-click
  // "Continue" still lands the org on a sensible default.
  useEffect(() => {
    if (!chatKey && list.length > 0) {
      setChatKey(`${list[0].provider_id}::${list[0].model_id}`);
    }
  }, [list, chatKey]);

  const persistStudyNav = async (hide: boolean) => {
    // Study OFF by default → hide it from the admin's own nav so a fresh
    // org isn't cluttered with a feature it hasn't turned on. (Org-wide
    // enforcement arrives with the feature-toggle system.)
    const current = hiddenNav ?? [];
    const next = hide
      ? [...new Set([...current, "study"])]
      : current.filter((k) => k !== "study");
    if (
      current.length === next.length &&
      current.every((k) => next.includes(k))
    ) {
      return; // no change
    }
    patchSettings({ hidden_nav: next });
    const fresh = await authApi.updatePreferences({ hidden_nav: next });
    setUser(fresh);
  };

  const save = async () => {
    setError(null);
    const chat = splitKey(chatKey);
    const study = studyOn ? splitKey(studyKey) : null;
    if (studyOn && !study) {
      setError("Pick a teaching model for Study, or turn Study off.");
      return;
    }
    try {
      // Only send pairs the admin actually chose; the backend validates
      // provider ownership and paired-ness.
      const patch: Record<string, string | null> = {};
      if (chat) {
        patch.default_chat_provider_id = chat.provider_id;
        patch.default_chat_model_id = chat.model_id;
      }
      if (study) {
        patch.study_provider_id = study.provider_id;
        patch.study_model_id = study.model_id;
      }
      if (Object.keys(patch).length > 0) {
        await update.mutateAsync(patch);
      }
      await persistStudyNav(!studyOn);
      onNext();
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(
          (err.response?.data as { detail?: string })?.detail ??
            err.message ??
            "Couldn't save your defaults."
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const noModels = !isLoading && list.length === 0;

  return (
    <Card
      icon={<Sparkles className="h-5 w-5" />}
      title="Choose your default models"
      subtitle="What your team reaches for out of the box. Members can still pick their own — this is just the starting point."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            Back
          </Button>
          <button
            type="button"
            onClick={() => {
              // Skip: leave chat unset, keep Study off + hidden.
              persistStudyNav(true)
                .then(onNext)
                .catch(() => onNext());
            }}
            className="mr-auto text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Skip
          </button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={update.isPending}
            disabled={noModels}
          >
            Continue
          </Button>
        </>
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the models from your provider…
        </div>
      ) : noModels ? (
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          No models are available yet. Go back and connect a provider first.
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
              Default chat model
            </label>
            <ModelSelect
              value={chatKey}
              onChange={setChatKey}
              models={list}
              loading={isLoading}
              offLabel="Off — use the first available model"
            />
          </div>

          <div className="rounded-card border border-[var(--border)] p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={studyOn}
                onChange={(e) => setStudyOn(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
                  <GraduationCap className="h-3.5 w-3.5" />
                  Enable Study mode
                </span>
                <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                  Guided, spaced-repetition learning. Off by default — turn it
                  on to give your team the Study workspace and pick its teaching
                  model. You can always enable it later in Admin → Models.
                </span>
              </span>
            </label>
            {studyOn && (
              <div className="mt-3 pl-7">
                <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                  Teaching model
                </label>
                <ModelSelect
                  value={studyKey}
                  onChange={setStudyKey}
                  models={list}
                  loading={isLoading}
                  offLabel="Pick a teaching model…"
                />
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                  Favour a frontier reasoning model — quality here has an
                  outsized effect on how well the tutor teaches.
                </p>
              </div>
            )}
          </div>

          <p className="text-[11px] text-[var(--text-muted)]">
            Vision, deep-research and assessor models can be set later in
            <span className="font-medium"> Admin → Models → Defaults</span>.
          </p>

          {error && (
            <div
              role="alert"
              className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------
// Step 3 — done. Marking ``onboarding_completed`` is owned by the gate
// (``onFinish``) so every exit path — including the per-step "Skip" — flips
// the flag and the wizard never reappears.
// --------------------------------------------------------------------
function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <Card
      icon={<CheckCircle2 className="h-5 w-5" />}
      title="You're all set"
      subtitle="Your organisation is ready. Invite your team from Admin → Members whenever you like — they'll inherit your provider and defaults automatically."
      footer={
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          onClick={onFinish}
        >
          <Check className="mr-1 h-3.5 w-3.5" />
          Enter Promptly
        </Button>
      }
    >
      <ul className="space-y-2 text-sm text-[var(--text-muted)]">
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" />
          Provider connected
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" />
          Default models chosen
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" />
          Ready to invite your team
        </li>
      </ul>
    </Card>
  );
}

// --------------------------------------------------------------------
// Small form primitives (local — the wizard is self-contained)
// --------------------------------------------------------------------
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      {children}
      {hint && (
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">{hint}</div>
      )}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60 disabled:opacity-60"
    />
  );
}
