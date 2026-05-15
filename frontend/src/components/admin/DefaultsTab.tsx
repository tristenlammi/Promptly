import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Eye } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useAppSettings, useUpdateAppSettings } from "@/hooks/useAdminUsers";
import { useAvailableModels } from "@/hooks/useProviders";
import { cn } from "@/utils/cn";
import type { AppSettings, AvailableModel } from "@/api/types";
import type { AppSettingsPatch } from "@/api/admin";
import { useModelStore } from "@/store/modelStore";

import { EmbeddingConfigCard } from "./CustomModelsPanel";
import { SettingsCard } from "./SettingsCard";

/**
 * Admin → Models → Defaults.
 *
 * Houses the three workspace-wide "which model does Promptly reach
 * for when it needs role X?" knobs:
 *
 *   1. **Default chat model** — the model a brand-new conversation
 *      starts with when the user has *no* personal default on their
 *      Account page. Personal defaults take precedence; this is a
 *      workspace-level fallback that makes onboarding smoother
 *      (otherwise the catalog's first-alphabetical entry wins,
 *      which is arbitrary).
 *   2. **Vision relay** — model used to caption images for chat
 *      models that can't see them. Filtered to vision-capable
 *      catalog entries.
 *   3. **Embedding model** — model used to chunk + embed files in
 *      Custom Models' knowledge libraries. Has its own modal
 *      because of the local-vs-API mode toggle + dimension picker;
 *      reused verbatim from where it lived inside the Custom
 *      Models panel.
 *
 * Why one tab instead of three locations: each setting answers the
 * same kind of question ("which model fulfils role X?"), so grouping
 * them collapses three pickers' worth of cognitive load into one
 * page. Admins land here once during install and rarely again.
 */
export function DefaultsTab() {
  const { data, isLoading, isError } = useAppSettings();
  const update = useUpdateAppSettings();

  if (isLoading) {
    return (
      <div className="text-sm text-[var(--text-muted)]">Loading defaults…</div>
    );
  }
  if (isError || !data) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Couldn't load workspace defaults. Refresh and try again.
      </div>
    );
  }

  const submit = (patch: AppSettingsPatch) => update.mutateAsync(patch);

  return (
    <div className="space-y-4">
      <header className="mb-2">
        <h2 className="text-sm font-semibold">Default models</h2>
        <p className="text-xs text-[var(--text-muted)]">
          Workspace-wide picks for the model roles Promptly needs to fill
          when a user hasn't customised one. None of these override a
          user's personal default on their Account page.
        </p>
      </header>

      <DefaultChatModelCard
        settings={data}
        onSubmit={submit}
        busy={update.isPending}
      />
      <VisionRelayDefaultCard
        settings={data}
        onSubmit={submit}
        busy={update.isPending}
      />
      <EmbeddingConfigCard />
    </div>
  );
}

// --------------------------------------------------------------------
// Shared types
// --------------------------------------------------------------------

interface CardProps {
  settings: AppSettings;
  onSubmit: (patch: AppSettingsPatch) => Promise<unknown>;
  busy: boolean;
}

// --------------------------------------------------------------------
// Default chat model
// --------------------------------------------------------------------

function DefaultChatModelCard({ settings, onSubmit, busy }: CardProps) {
  // Sentinel for the "no admin default" option. The picker encodes
  // real selections as ``<provider_id>::<model_id>`` so the two
  // halves move together (the backend rejects single-half PATCHes).
  const OFF = "";

  const initialKey =
    settings.default_chat_configured &&
    settings.default_chat_provider_id &&
    settings.default_chat_model_id
      ? `${settings.default_chat_provider_id}::${settings.default_chat_model_id}`
      : OFF;

  const [value, setValue] = useState(initialKey);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { data: models, isLoading: modelsLoading } = useAvailableModels();

  useEffect(() => {
    setValue(initialKey);
  }, [initialKey]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  // No filter: any model can serve as the default chat starter.
  const eligible: AvailableModel[] = models ?? [];

  const grouped = useMemo(() => {
    const byProvider = new Map<string, AvailableModel[]>();
    for (const m of eligible) {
      const existing = byProvider.get(m.provider_name) ?? [];
      existing.push(m);
      byProvider.set(m.provider_name, existing);
    }
    return Array.from(byProvider.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [eligible]);

  const dirty = value !== initialKey;

  const handleSave = async () => {
    setError(null);
    try {
      if (value === OFF) {
        await onSubmit({
          default_chat_provider_id: null,
          default_chat_model_id: null,
        });
        useModelStore.getState().setAdminDefault(null, null);
      } else {
        const [provider_id, ...rest] = value.split("::");
        const model_id = rest.join("::");
        if (!provider_id || !model_id) {
          setError("Pick a model from the list, or choose Off.");
          return;
        }
        await onSubmit({
          default_chat_provider_id: provider_id,
          default_chat_model_id: model_id,
        });
        // Push the change straight into the local modelStore so the
        // admin's own picker reflects the new fallback without
        // waiting for a re-bootstrap.
        useModelStore.getState().setAdminDefault(provider_id, model_id);
      }
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsCard
      title="Default chat model"
      icon={<Bot className="h-4 w-4" />}
      footer={
        <>
          {error && (
            <span className="mr-auto text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          {savedAt && !error && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setValue(initialKey);
                setError(null);
              }}
              disabled={busy}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || busy}
            loading={busy}
          >
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Workspace-wide fallback model used when a user opens a fresh chat
        and hasn't set their own default under{" "}
        <span className="font-medium">Account → Chat preferences</span>.
        Users who have picked a personal default are unaffected.
      </p>
      <ul className="mb-4 space-y-1 text-xs text-[var(--text-muted)]">
        <li>
          <strong>Who sees this:</strong> new users on their first chat,
          and existing users who haven't customised their Account default.
        </li>
        <li>
          <strong>Doesn't override:</strong> personal defaults, existing
          conversations, or explicit picker choices.
        </li>
        <li>
          <strong>Off:</strong> picker falls back to the first available
          model in the catalog (historical behaviour).
        </li>
      </ul>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs font-medium text-[var(--text-muted)]">
          Fallback model
        </span>
        <select
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setSavedAt(null);
          }}
          disabled={busy || modelsLoading}
          className={cn(
            "rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <option value={OFF}>Off — use the catalog's first available model</option>
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
        {modelsLoading && (
          <span className="text-xs text-[var(--text-muted)]">
            Loading models…
          </span>
        )}
        {!modelsLoading && eligible.length === 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            No models in the catalog yet. Connect a provider on the
            Connections tab first.
          </span>
        )}
      </label>
    </SettingsCard>
  );
}

// --------------------------------------------------------------------
// Vision relay — same shape as the chat-default card, filtered to
// vision-capable models only.
// --------------------------------------------------------------------

function VisionRelayDefaultCard({ settings, onSubmit, busy }: CardProps) {
  const OFF = "";

  const initialKey =
    settings.vision_relay_configured &&
    settings.vision_relay_provider_id &&
    settings.vision_relay_model_id
      ? `${settings.vision_relay_provider_id}::${settings.vision_relay_model_id}`
      : OFF;

  const [value, setValue] = useState(initialKey);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { data: models, isLoading: modelsLoading } = useAvailableModels();

  useEffect(() => {
    setValue(initialKey);
  }, [initialKey]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  // Only vision-capable models — Custom Models that wrap a vision base
  // are intentionally included since admins might have a tuned wrapper
  // they prefer for relay duties.
  const visionModels: AvailableModel[] = (models ?? []).filter(
    (m) => m.supports_vision === true,
  );

  const grouped = useMemo(() => {
    const byProvider = new Map<string, AvailableModel[]>();
    for (const m of visionModels) {
      const existing = byProvider.get(m.provider_name) ?? [];
      existing.push(m);
      byProvider.set(m.provider_name, existing);
    }
    return Array.from(byProvider.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [visionModels]);

  const dirty = value !== initialKey;

  const handleSave = async () => {
    setError(null);
    try {
      if (value === OFF) {
        await onSubmit({
          vision_relay_provider_id: null,
          vision_relay_model_id: null,
        });
        useModelStore.getState().setVisionRelay(null, null);
      } else {
        const [provider_id, ...rest] = value.split("::");
        const model_id = rest.join("::");
        if (!provider_id || !model_id) {
          setError("Pick a vision model from the list to enable the relay.");
          return;
        }
        await onSubmit({
          vision_relay_provider_id: provider_id,
          vision_relay_model_id: model_id,
        });
        // Sync the local mirror so the admin's own composer reflects
        // the change without waiting for a page reload — same pattern
        // the default-chat-model card uses.
        useModelStore.getState().setVisionRelay(provider_id, model_id);
      }
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsCard
      title="Vision relay"
      icon={<Eye className="h-4 w-4" />}
      footer={
        <>
          {error && (
            <span className="mr-auto text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          {savedAt && !error && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setValue(initialKey);
                setError(null);
              }}
              disabled={busy}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || busy}
            loading={busy}
          >
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        When a user attaches an image to a chat whose active model can't
        read images natively, Promptly routes each image through this
        vision-capable model to produce a text caption first, then splices
        the caption into the prompt so the chat model can respond as if it
        had seen the image. A pair of chips in the chat shows what
        happened.
      </p>
      <ul className="mb-4 space-y-1 text-xs text-[var(--text-muted)]">
        <li>
          <strong>Best for:</strong> photos, whiteboards, UI mockups,
          "what's in this image" questions.
        </li>
        <li>
          <strong>Worse than native vision for:</strong> code screenshots,
          dense tables, exact-text extraction (receipts, forms).
        </li>
        <li>
          <strong>Cost &amp; latency:</strong> one extra request per image
          (~1-3s, sub-cent on Gemini Flash / GPT-4o-mini).
        </li>
        <li>
          <strong>Privacy:</strong> images leave Promptly via this provider
          — pick a local model (e.g. llava on Ollama) for strict-privacy
          installs.
        </li>
      </ul>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs font-medium text-[var(--text-muted)]">
          Relay model
        </span>
        <select
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setSavedAt(null);
          }}
          disabled={busy || modelsLoading}
          className={cn(
            "rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <option value={OFF}>
            Off — silently drop images on non-vision models
          </option>
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
        {modelsLoading && (
          <span className="text-xs text-[var(--text-muted)]">
            Loading vision-capable models…
          </span>
        )}
        {!modelsLoading && visionModels.length === 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            No vision-capable models in the catalog yet. Add a provider
            with a vision model (Gemini, GPT-4o, llava, …) to enable the
            relay.
          </span>
        )}
      </label>
    </SettingsCard>
  );
}
