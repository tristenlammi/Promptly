import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3, Plug, ScrollText, Settings, Settings2, Terminal, Users, Users2 } from "lucide-react";

import { AnalyticsPanel } from "@/components/admin/AnalyticsPanel";
import { AppSettingsPanel } from "@/components/admin/AppSettingsPanel";
import { AuditLogPanel } from "@/components/admin/AuditLogPanel";
import { ConsolePanel } from "@/components/admin/ConsolePanel";
import { GroupsPanel } from "@/components/admin/GroupsPanel";
import { McpConnectorsPanel } from "@/components/admin/McpConnectorsPanel";
import { ModelsPanel } from "@/components/admin/ModelsPanel";
import { SearchProvidersPanel } from "@/components/admin/SearchProvidersPanel";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { TopNav } from "@/components/layout/TopNav";
import { cn } from "@/utils/cn";

type TabId =
  | "users"
  | "groups"
  | "analytics"
  | "console"
  | "audit"
  | "settings"
  | "models"
  | "connectors";

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  subtitle: string;
}

const TABS: TabDef[] = [
  {
    id: "users",
    label: "Users",
    icon: <Users className="h-3.5 w-3.5" />,
    subtitle: "Manage accounts, model access and per-user security state.",
  },
  {
    id: "groups",
    label: "Groups",
    icon: <Users2 className="h-3.5 w-3.5" />,
    subtitle:
      "Bundle users into teams to scope connector access by identity.",
  },
  {
    id: "models",
    label: "Models",
    icon: <Settings2 className="h-3.5 w-3.5" />,
    subtitle:
      "Connect LLM providers and pick which models are available in Chat.",
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: <Plug className="h-3.5 w-3.5" />,
    subtitle:
      "Web-search providers and remote MCP servers the AI can use in chat.",
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: <BarChart3 className="h-3.5 w-3.5" />,
    subtitle: "Usage, tokens and cost across every account.",
  },
  {
    id: "console",
    label: "Console",
    icon: <Terminal className="h-3.5 w-3.5" />,
    subtitle: "Live structured log tail and grouped server errors.",
  },
  {
    id: "audit",
    label: "Audit log",
    icon: <ScrollText className="h-3.5 w-3.5" />,
    subtitle: "Every authentication and admin event, with IP and timestamps.",
  },
  {
    id: "settings",
    label: "App settings",
    icon: <Settings className="h-3.5 w-3.5" />,
    subtitle: "MFA enforcement and SMTP server configuration.",
  },
];

export function AdminPage() {
  // Drive the active tab from ``?tab=...`` so deep links land on the
  // right surface (e.g. the ``/models`` legacy route now redirects to
  // ``/admin?tab=models``) and the back button steps through tabs the
  // user actually visited.
  // Single-tenant self-host: the admin manages the whole instance, so every
  // tab is shown (Users, Models, Groups, Connectors, Analytics, Console,
  // Audit, App settings).
  const visibleTabs = TABS;

  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabId = useMemo(() => {
    const raw = searchParams.get("tab");
    if (raw && visibleTabs.some((t) => t.id === raw)) {
      return raw as TabId;
    }
    return visibleTabs[0].id;
  }, [searchParams, visibleTabs]);
  const setTab = useCallback(
    (next: TabId) => {
      const params = new URLSearchParams(searchParams);
      if (next === "users") {
        params.delete("tab");
      } else {
        params.set("tab", next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams]
  );
  const active = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[0];

  return (
    <>
      <TopNav title="Admin" subtitle={active.subtitle} />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6">
          <Tabs tabs={visibleTabs} current={tab} onChange={setTab} />
          <div className="mt-5">
            {tab === "users" && <UsersPanel />}
            {tab === "groups" && <GroupsPanel />}
            {tab === "models" && <ModelsPanel />}
            {tab === "connectors" && (
              <div className="space-y-8">
                <section>
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    Web search
                  </h2>
                  <SearchProvidersPanel />
                </section>
                <section className="border-t border-[var(--border)] pt-6">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    MCP connectors
                  </h2>
                  <McpConnectorsPanel />
                </section>
              </div>
            )}
            {tab === "analytics" && <AnalyticsPanel />}
            {tab === "console" && <ConsolePanel />}
            {tab === "audit" && <AuditLogPanel />}
            {tab === "settings" && <AppSettingsPanel />}
          </div>
        </div>
      </div>
    </>
  );
}

function Tabs({
  tabs,
  current,
  onChange,
}: {
  tabs: TabDef[];
  current: TabId;
  onChange: (next: TabId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Admin sections"
      className="flex flex-wrap gap-1 border-b border-[var(--border)]"
    >
      {tabs.map((t) => {
        const isActive = t.id === current;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition",
              isActive
                ? "border-[var(--accent)] text-[var(--text)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
