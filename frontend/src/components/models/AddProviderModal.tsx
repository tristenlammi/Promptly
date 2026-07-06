import { useState, type FormEvent } from "react";

import { Modal } from "@/components/shared/Modal";
import { Button } from "@/components/shared/Button";
import { useCreateProvider } from "@/hooks/useProviders";
import type { ProviderType } from "@/api/types";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Per-type metadata driving the add-provider form. ``defaultName`` /
 * ``baseUrlHint`` / ``apiKeyPlaceholder`` land in the form when a tile
 * is selected; ``keyless`` toggles whether the API-key field is
 * required and labels it accordingly.
 */
export interface ProviderSpec {
  value: ProviderType;
  label: string;
  defaultName: string;
  baseUrlHint: string;
  apiKeyPlaceholder: string;
  keyless?: boolean;
  hint?: string;
  /** Official console page where the user can create/copy an API key —
   *  rendered as a "Get your key" link under the key field. */
  keyUrl?: string;
}

export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    value: "openrouter",
    label: "OpenRouter",
    defaultName: "OpenRouter",
    baseUrlHint: "https://openrouter.ai/api/v1",
    apiKeyPlaceholder: "sk-or-...",
    hint: "One key, 300+ models — easiest start",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    value: "openai",
    label: "OpenAI",
    defaultName: "OpenAI",
    baseUrlHint: "https://api.openai.com/v1",
    apiKeyPlaceholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    defaultName: "Anthropic",
    baseUrlHint: "https://api.anthropic.com/v1",
    apiKeyPlaceholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    value: "gemini",
    label: "Google Gemini",
    defaultName: "Gemini",
    baseUrlHint: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyPlaceholder: "AIza...",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    defaultName: "Ollama",
    baseUrlHint: "http://localhost:11434/v1",
    apiKeyPlaceholder: "Not required",
    keyless: true,
    hint: "No API key required",
    keyUrl: "https://ollama.com",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    defaultName: "DeepSeek",
    baseUrlHint: "https://api.deepseek.com",
    apiKeyPlaceholder: "sk-...",
    hint: "Text + reasoning (V4)",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    value: "openai_compatible",
    label: "OpenAI-compatible",
    defaultName: "Custom",
    baseUrlHint: "https://…/v1",
    apiKeyPlaceholder: "Bearer token",
    hint: "vLLM, LocalAI, LM Studio, …",
  },
];

export function specFor(type: ProviderType): ProviderSpec {
  return PROVIDER_SPECS.find((s) => s.value === type) ?? PROVIDER_SPECS[0];
}

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddProviderModal({ open, onClose }: AddProviderModalProps) {
  const create = useCreateProvider();
  const [type, setType] = useState<ProviderType>("openrouter");
  const [name, setName] = useState(specFor("openrouter").defaultName);
  // Track whether the admin has typed a custom name so switching
  // provider types doesn't clobber it; only auto-fill when the field
  // still holds the previous type's default.
  const [nameTouched, setNameTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const spec = specFor(type);

  const reset = () => {
    setType("openrouter");
    setName(specFor("openrouter").defaultName);
    setNameTouched(false);
    setBaseUrl("");
    setApiKey("");
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleTypeChange = (next: ProviderType) => {
    setType(next);
    // Auto-fill a sensible display name when the user hasn't edited it
    // themselves. We wipe the api-key field on type change so a key
    // pasted for one provider isn't accidentally submitted for another.
    if (!nameTouched) setName(specFor(next).defaultName);
    setApiKey("");
    setError(null);
  };

  const onSubmit = async (e: FormEvent) => {
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
      handleClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to create provider"));
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add model provider"
      description="API keys are encrypted at rest with Fernet before being stored."
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={(e) => onSubmit(e as unknown as FormEvent)}
            loading={create.isPending}
          >
            Add provider
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Provider type">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PROVIDER_SPECS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleTypeChange(opt.value)}
                className={`rounded-card border px-3 py-2 text-left text-xs transition ${
                  type === opt.value
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)]/40"
                }`}
              >
                <div className="font-medium">{opt.label}</div>
                {opt.hint && <div className="mt-0.5 text-[10px]">{opt.hint}</div>}
              </button>
            ))}
          </div>
        </Field>

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

        <Field
          label={spec.keyless ? "API key (optional)" : "API key"}
          hint={
            spec.keyless ? (
              <>
                Ollama runs models locally on your machine — no key needed.
                New to it?{" "}
                <ExternalHint href={spec.keyUrl!}>
                  Get Ollama + pull a model
                </ExternalHint>
                .
              </>
            ) : spec.keyUrl ? (
              <>
                Don't have a key yet?{" "}
                <ExternalHint href={spec.keyUrl}>
                  Create one in the {spec.label} console
                </ExternalHint>
                .
              </>
            ) : undefined
          }
        >
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            type="password"
            placeholder={spec.apiKeyPlaceholder}
            required={!spec.keyless}
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

        {/* Native submit button (kept for Enter-to-submit inside inputs). */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      {children}
      {hint && <div className="mt-1 text-[11px] text-[var(--text-muted)]">{hint}</div>}
    </label>
  );
}

/** Small external link used in field hints (key-console pointers). */
function ExternalHint({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {children}
    </a>
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
