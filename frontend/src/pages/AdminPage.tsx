import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3, ScrollText, Settings, Settings2, Terminal, Users } from "lucide-react";

import { AnalyticsPanel } from "@/components/admin/AnalyticsPanel";
import { AppSettingsPanel } from "@/components/admin/AppSettingsPanel";
import { AuditLogPanel } from "@/components/admin/AuditLogPanel";
import { ConsolePanel } from "@/components/admin/ConsolePanel";
import { ModelsPanel } from "@/components/admin/ModelsPanel";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { TopNav } from "@/components/layout/TopNav";
import { cn } from "@/utils/cn";

type TabId =
  | "users"
  | "analytics"
  | "console"
  | "audit"
  | "settings"
  | "models";

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
    id: "models",
    label: "Models",
    icon: <Settings2 className="h-3.5 w-3.5" />,
    subtitle:
      "Connect LLM providers and pick which models are available in Chat and Study.",
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

const VALID_TAB_IDS = new Set<TabId>(TABS.map((t) => t.id));

export function AdminPage() {
  // Drive the active tab from ``?tab=...`` so deep links land on the
  // right surface (e.g. the ``/models`` legacy route now redirects to
  // ``/admin?tab=models``) and the back button steps through tabs the
  // user actually visited.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabId = useMemo(() => {
    const raw = searchParams.get("tab");
    return raw && VALID_TAB_IDS.has(raw as TabId) ? (raw as TabId) : "users";
  }, [searchParams]);
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
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <>
      <TopNav title="Settings" subtitle={active.subtitle} />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6">
          <Tabs current={tab} onChange={setTab} />
          <div className="mt-5">
            {tab === "users" && <UsersPanel />}
            {tab === "models" && <ModelsPanel />}
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
  current,
  onChange,
}: {
  current: TabId;
  onChange: (next: TabId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Admin sections"
      className="flex flex-wrap gap-1 border-b border-[var(--border)]"
    >
      {TABS.map((t) => {
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
