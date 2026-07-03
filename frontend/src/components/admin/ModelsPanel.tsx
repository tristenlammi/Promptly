import { useState } from "react";

import { ProviderConnections } from "@/components/models/ProviderConnections";
import { CustomModelsPanel } from "@/components/admin/CustomModelsPanel";
import { LocalModelsPanel } from "@/components/admin/LocalModelsPanel";
import { DefaultsTab } from "@/components/admin/DefaultsTab";
import { useAuthStore } from "@/store/authStore";

/**
 * The Models management surface.
 *
 * Split into tabs so the admin's primary config surface has room to
 * grow without blowing up into a single mega-list:
 *
 * - **Connections** — API providers (OpenRouter, direct OpenAI, …).
 * - **Defaults** — workspace-wide picks for the three model roles
 *   Promptly needs to fill: default chat model (fallback when a
 *   user has no personal default), vision relay (for non-vision
 *   chat models receiving images), and embedding model (for
 *   Custom Models' knowledge libraries). Centralising these keeps
 *   "which model fulfils role X?" questions in one place instead
 *   of scattered across settings + custom-models + (formerly) the
 *   app-settings page.
 * - **Custom Models** — admin-curated assistants (personality +
 *   base model + knowledge library).
 * - **Local Models** — Ollama-hosted models.
 *
 * Defaults sits right after Connections because the natural setup
 * flow is "wire up a provider, then tell Promptly which of its
 * models to use by default."
 *
 * Renders its own action row instead of reaching for ``TopNav``
 * because the parent ``AdminPage`` already owns the page header.
 */
type TabId = "connections" | "defaults" | "custom" | "local";

const TABS: { id: TabId; label: string; disabled?: boolean }[] = [
  { id: "connections", label: "Connections" },
  { id: "defaults", label: "Defaults" },
  { id: "custom", label: "Custom Models" },
  { id: "local", label: "Local Models" },
];

export function ModelsPanel() {
  const [tab, setTab] = useState<TabId>("connections");
  // Org admins get only Connections (their BYOK keys). Defaults / Custom /
  // Local are still global config — platform-admin only until org-scoped.
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === "admin");
  // Org admins get Connections (their BYOK keys) + Custom Models (their
  // assistants). Defaults / Local stay platform-only until org-scoped.
  const visibleTabs = isPlatformAdmin
    ? TABS
    : TABS.filter((t) => t.id === "connections" || t.id === "custom");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-1" role="tablist">
          {visibleTabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                disabled={t.disabled}
                className={[
                  "relative px-3 py-2 text-sm font-medium transition",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {t.label}
                {active && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--accent)]" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "connections" && <ProviderConnections />}
      {tab === "defaults" && <DefaultsTab />}
      {tab === "custom" && (
        <CustomModelsPanel onJumpToDefaults={() => setTab("defaults")} />
      )}
      {tab === "local" && <LocalModelsPanel />}
    </div>
  );
}

