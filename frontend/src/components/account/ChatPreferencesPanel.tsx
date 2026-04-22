import { useEffect, useState } from "react";
import { Check, Cpu, Globe, Loader2, Wrench } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { useAuthStore } from "@/store/authStore";
import { useAvailableModels } from "@/hooks/useProviders";
import { useModelStore } from "@/store/modelStore";
import type { AvailableModel, WebSearchMode } from "@/api/types";
import { cn } from "@/utils/cn";

/** Self-service panel for the per-account chat defaults.
 *
 * Mirrors the in-chat Tools / Web pickers so the user can review and
 * change their defaults without opening a conversation first. Both
 * surfaces write to the same backend setting (``users.settings`` via
 * ``PATCH /auth/me/preferences``); whichever one the user touches
 * last wins, and the other re-renders from the cached user.
 */
export function ChatPreferencesPanel() {
  const user = useAuthStore((s) => s.user);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  // Local mirror so the toggle visually flips immediately, even before
  // the PATCH round-trips. We re-sync from the cached user whenever it
  // changes (e.g. another tab updating the same preference).
  const [tools, setTools] = useState<boolean>(
    user?.settings?.default_tools_enabled ?? true
  );
  const [webMode, setWebMode] = useState<WebSearchMode>(
    user?.settings?.default_web_search_mode ?? "auto"
  );
  const [busy, setBusy] = useState<"tools" | "web" | "model" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pull the available-model list so the picker has something to
  // render. The query is shared with the chat header's selector via
  // TanStack's cache, so opening the account page mid-session is
  // free.
  const { data: availableModels, isLoading: modelsLoading } =
    useAvailableModels();
  const setStoreDefault = useModelStore((s) => s.setDefault);
  const defaultModelId =
    typeof user?.settings?.default_model_id === "string"
      ? user.settings.default_model_id
      : null;
  const defaultProviderId =
    typeof user?.settings?.default_provider_id === "string"
      ? user.settings.default_provider_id
      : null;

  useEffect(() => {
    if (!user?.settings) return;
    setTools(user.settings.default_tools_enabled ?? true);
    setWebMode(user.settings.default_web_search_mode ?? "auto");
  }, [user?.settings]);

  // Generic persistence helper. Keyed on the preference + busy slot so
  // the spinner only attaches to the row the user just touched. On
  // failure we roll local state back to the cached value (or to the
  // baseline default if nothing was cached).
  async function persist<
    K extends "default_tools_enabled" | "default_web_search_mode",
  >(
    key: K,
    value: K extends "default_tools_enabled" ? boolean : WebSearchMode,
    busyKey: "tools" | "web"
  ) {
    setError(null);
    setBusy(busyKey);
    const previous = user?.settings?.[key];
    patchSettings({ [key]: value });
    try {
      const fresh = await authApi.updatePreferences({
        [key]: value,
      } as Record<K, typeof value>);
      setUser(fresh);
    } catch (err) {
      patchSettings({ [key]: previous as never });
      if (busyKey === "tools") {
        setTools(typeof previous === "boolean" ? previous : true);
      } else {
        setWebMode((previous as WebSearchMode | undefined) ?? "auto");
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const handleToolsChange = (next: boolean) => {
    setTools(next);
    void persist("default_tools_enabled", next, "tools");
  };

  const handleWebModeChange = (next: WebSearchMode) => {
    setWebMode(next);
    void persist("default_web_search_mode", next, "web");
  };

  // Default-model persistence. Sent as a *pair* so the server never
  // ends up with half-set state (e.g. provider id of model A, model
  // id of model B). Empty strings clear both — the merge layer in
  // ``auth/router.py`` strips ``""`` keys out of ``user.settings``.
  // We optimistically push to the model store first so a brand-new
  // chat opened in another tab picks up the change instantly.
  const handleDefaultModelChange = async (model: AvailableModel | null) => {
    setError(null);
    setBusy("model");
    const previousProvider = user?.settings?.default_provider_id;
    const previousModel = user?.settings?.default_model_id;
    const nextProvider = model?.provider_id ?? "";
    const nextModel = model?.model_id ?? "";
    patchSettings({
      default_provider_id: model?.provider_id,
      default_model_id: model?.model_id,
    });
    setStoreDefault(model?.provider_id ?? null, model?.model_id ?? null);
    try {
      const fresh = await authApi.updatePreferences({
        default_provider_id: nextProvider,
        default_model_id: nextModel,
      });
      setUser(fresh);
    } catch (err) {
      patchSettings({
        default_provider_id: previousProvider as string | undefined,
        default_model_id: previousModel as string | undefined,
      });
      setStoreDefault(
        typeof previousProvider === "string" ? previousProvider : null,
        typeof previousModel === "string" ? previousModel : null
      );
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <Wrench className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Chat defaults</h3>
        </div>
        {busy && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving
          </span>
        )}
      </header>

      <div className="space-y-5 px-4 py-4">
        <DefaultModelRow
          available={availableModels ?? []}
          loading={modelsLoading}
          selectedProviderId={defaultProviderId}
          selectedModelId={defaultModelId}
          onChange={handleDefaultModelChange}
          disabled={busy === "model"}
        />
        <div className="border-t border-[var(--border)]" />
        <ToggleRow
          icon={<Wrench className="h-4 w-4 text-[var(--accent)]" />}
          title="Tools"
          description={
            <>
              Lets the assistant call server-side tools mid-reply — for
              example, generating a downloadable PDF and attaching it to
              its message. Off-by-default would mean the model has to
              refuse those requests until you opt in for the turn.
            </>
          }
          checked={tools}
          onChange={handleToolsChange}
          disabled={busy === "tools"}
        />
        <div className="border-t border-[var(--border)]" />
        <WebSearchModeRow
          mode={webMode}
          onChange={handleWebModeChange}
          disabled={busy === "web"}
        />

        {error && (
          <div
            role="alert"
            className="rounded-input border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            Failed to save preference: {error}
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          These defaults seed every new chat. Toggling the same controls
          inside a conversation updates this preference too.
        </p>
      </div>
    </section>
  );
}

interface ToggleRowProps {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
  disabled,
}: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/10">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{description}</p>
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

const WEB_MODE_OPTIONS: {
  value: WebSearchMode;
  label: string;
  description: string;
}[] = [
  {
    value: "off",
    label: "Off",
    description: "Never search. The model relies entirely on its training.",
  },
  {
    value: "auto",
    label: "Auto",
    description:
      "The model decides per turn — current events, prices, docs, etc. trigger a search.",
  },
  {
    value: "always",
    label: "Always",
    description:
      "Force a search before every reply. Best for research-heavy conversations.",
  },
];

function WebSearchModeRow({
  mode,
  onChange,
  disabled,
}: {
  mode: WebSearchMode;
  onChange: (mode: WebSearchMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/10">
          <Globe className="h-4 w-4 text-[var(--accent)]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Web search</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Three-mode picker. <span className="font-medium">Auto</span> is
            recommended — the model only searches when a question really needs
            current info, so you don't pay for searches you don't need.
          </p>
          <div
            role="radiogroup"
            aria-label="Default web search behaviour"
            className="mt-3 grid gap-1.5"
          >
            {WEB_MODE_OPTIONS.map((opt) => {
              const selected = opt.value === mode;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onChange(opt.value)}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    selected
                      ? "border-[var(--accent)] bg-[var(--accent)]/[0.08]"
                      : "border-[var(--border)] hover:border-[var(--accent)]/50"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center",
                      selected ? "text-[var(--accent)]" : "text-transparent"
                    )}
                    aria-hidden
                  >
                    <Check className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block font-semibold",
                        selected ? "text-[var(--accent)]" : "text-[var(--text)]"
                      )}
                    >
                      {opt.label}
                    </span>
                    <span className="mt-0.5 block text-[var(--text-muted)]">
                      {opt.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function DefaultModelRow({
  available,
  loading,
  selectedProviderId,
  selectedModelId,
  onChange,
  disabled,
}: {
  available: AvailableModel[];
  loading: boolean;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  onChange: (model: AvailableModel | null) => void;
  disabled?: boolean;
}) {
  // Resolve the configured default against the live list. ``null``
  // when the user hasn't picked one yet OR when their pick is no
  // longer installed (e.g. the admin removed the provider). The copy
  // below makes that distinction visible so the user knows whether
  // to set or re-pick.
  const currentValue =
    selectedProviderId && selectedModelId
      ? `${selectedProviderId}::${selectedModelId}`
      : "";
  const currentResolves =
    !!available.find(
      (m) =>
        m.provider_id === selectedProviderId && m.model_id === selectedModelId
    ) || !currentValue;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/10">
          <Cpu className="h-4 w-4 text-[var(--accent)]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Default model</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Every new chat starts on this model. Switching the model
            inside a conversation only affects that conversation —
            new chats always come back here.
          </p>
          <div className="mt-3">
            <select
              value={currentValue}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) {
                  onChange(null);
                  return;
                }
                const [provider_id, model_id] = v.split("::");
                const found = available.find(
                  (m) =>
                    m.provider_id === provider_id && m.model_id === model_id
                );
                if (found) onChange(found);
              }}
              disabled={disabled || loading}
              className={cn(
                "w-full max-w-md rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
                "border-[var(--border)] text-[var(--text)]",
                "focus:border-[var(--accent)] focus:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
            >
              <option value="">
                {loading ? "Loading models…" : "No default — use first available"}
              </option>
              {available.map((m) => (
                <option
                  key={`${m.provider_id}::${m.model_id}`}
                  value={`${m.provider_id}::${m.model_id}`}
                >
                  {m.display_name} · {m.provider_name}
                </option>
              ))}
            </select>
            {!currentResolves && (
              <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                Your saved default is no longer available. New chats will
                fall back to the first model in the list until you pick a
                new default.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        "relative mt-1 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition",
        checked ? "bg-[var(--accent)]" : "bg-black/15 dark:bg-white/15",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
