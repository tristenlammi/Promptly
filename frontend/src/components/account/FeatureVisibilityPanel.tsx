import { useState } from "react";
import { LayoutGrid, Loader2 } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { useAuthStore } from "@/store/authStore";
import {
  OPTIONAL_NAV_KEYS,
  OPT_IN_NAV_KEYS,
  type OptionalNavKey,
} from "@/components/layout/navItems";
import { cn } from "@/utils/cn";

/** Per-user interface curation (Phase 2 — feature visibility).
 *
 * Lets each user hide optional top-level surfaces (Workspaces, Tasks)
 * from their sidebar so they can keep their nav as clean or as
 * full as they like. Hiding a section is purely cosmetic — it never
 * disables the underlying feature or its routes, and the section can be
 * re-enabled here at any time. Persists to ``users.settings.hidden_nav``
 * via the shared ``PATCH /auth/me/preferences`` endpoint.
 */
export function FeatureVisibilityPanel() {
  const user = useAuthStore((s) => s.user);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  const hidden = new Set<string>(user?.settings?.hidden_nav ?? []);
  const enabled = new Set<string>(user?.settings?.enabled_nav ?? []);
  const [busy, setBusy] = useState<OptionalNavKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A surface is "on" when: opt-in and enabled, OR opt-out and not hidden.
  const isOn = (key: OptionalNavKey) =>
    OPT_IN_NAV_KEYS.has(key) ? enabled.has(key) : !hidden.has(key);

  const setVisible = async (key: OptionalNavKey, visible: boolean) => {
    setError(null);
    setBusy(key);
    // Opt-in surfaces toggle the ``enabled_nav`` allowlist; opt-out surfaces
    // toggle the ``hidden_nav`` denylist. Kept separate so a fresh install
    // can start opt-in surfaces hidden without a per-key default table.
    const optIn = OPT_IN_NAV_KEYS.has(key);
    const field = optIn ? "enabled_nav" : "hidden_nav";
    const previous = (user?.settings?.[field] ?? []) as string[];
    const next = optIn
      ? visible
        ? [...new Set([...previous, key])]
        : previous.filter((k) => k !== key)
      : visible
        ? previous.filter((k) => k !== key)
        : [...new Set([...previous, key])];
    patchSettings({ [field]: next });
    try {
      const fresh = await authApi.updatePreferences({ [field]: next });
      setUser(fresh);
    } catch (err) {
      patchSettings({ [field]: previous });
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
            <LayoutGrid className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Sidebar features</h3>
        </div>
        {busy && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving
          </span>
        )}
      </header>

      <div className="space-y-5 px-4 py-4">
        {OPTIONAL_NAV_KEYS.map(({ key, label, description }, i) => (
          <div key={key}>
            {i > 0 && <div className="mb-5 border-t border-[var(--border)]" />}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{label}</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {description}
                </p>
              </div>
              <Toggle
                checked={isOn(key)}
                onChange={(v) => void setVisible(key, v)}
                disabled={busy === key}
              />
            </div>
          </div>
        ))}

        {error && (
          <div
            role="alert"
            className="rounded-input border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            Failed to save: {error}
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
          Turning a feature off just hides it from your sidebar to keep
          things tidy — nothing is deleted, and you can switch it back on
          here whenever you like. Chat and Files are always available.
        </p>
      </div>
    </section>
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
