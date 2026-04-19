import { useEffect, useState } from "react";
import { Check, Globe, Loader2, Wrench } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { useAuthStore } from "@/store/authStore";
import type { WebSearchMode } from "@/api/types";
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
  const [busy, setBusy] = useState<"tools" | "web" | null>(null);
  const [error, setError] = useState<string | null>(null);

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
