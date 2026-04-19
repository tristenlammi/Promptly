import { useState, type FormEvent } from "react";
import axios from "axios";

import { Modal } from "@/components/shared/Modal";
import { Button } from "@/components/shared/Button";
import { useCreateProvider } from "@/hooks/useProviders";
import type { ProviderType } from "@/api/types";

// Only OpenRouter is wired end-to-end today. The other types are listed for
// visibility but disabled so users don't hit a 400 from the backend. They'll
// be enabled as the ModelRouter gains per-provider adapters.
const PROVIDER_TYPES: Array<{
  value: ProviderType;
  label: string;
  enabled: boolean;
  hint?: string;
}> = [
  { value: "openrouter", label: "OpenRouter", enabled: true },
  { value: "openai", label: "OpenAI", enabled: false, hint: "Coming soon" },
  { value: "anthropic", label: "Anthropic", enabled: false, hint: "Coming soon" },
  { value: "ollama", label: "Ollama (local)", enabled: false, hint: "Coming soon" },
  {
    value: "openai_compatible",
    label: "OpenAI-compatible",
    enabled: false,
    hint: "Coming soon",
  },
];

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddProviderModal({ open, onClose }: AddProviderModalProps) {
  const create = useCreateProvider();
  const [name, setName] = useState("OpenRouter");
  const [type, setType] = useState<ProviderType>("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("OpenRouter");
    setType("openrouter");
    setBaseUrl("");
    setApiKey("");
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        name: name.trim() || type,
        type,
        base_url: baseUrl.trim() || null,
        api_key: apiKey,
        enabled: true,
      });
      handleClose();
    } catch (err) {
      if (axios.isAxiosError(err)) {
        setError(
          (err.response?.data as { detail?: string })?.detail ??
            err.message ??
            "Failed to create provider"
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
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
            {PROVIDER_TYPES.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={!opt.enabled}
                onClick={() => setType(opt.value)}
                className={`rounded-card border px-3 py-2 text-left text-xs transition ${
                  type === opt.value
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)]/40"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <div className="font-medium">{opt.label}</div>
                {opt.hint && <div className="mt-0.5 text-[10px]">{opt.hint}</div>}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Display name">
          <TextInput value={name} onChange={setName} placeholder="My OpenRouter" />
        </Field>

        <Field label="API key">
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            type="password"
            placeholder="sk-or-..."
            required
          />
        </Field>

        <Field
          label="Base URL"
          hint="Optional — leave blank to use the provider's default."
        >
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://openrouter.ai/api/v1"
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
  hint?: string;
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
      className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
    />
  );
}
