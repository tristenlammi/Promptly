import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { OrganizationProfile } from "@clerk/clerk-react";
import { BarChart3, Plug, ScrollText, Settings, Settings2, Terminal, Trash2, UserPlus, Users, Users2 } from "lucide-react";

import { AnalyticsPanel } from "@/components/admin/AnalyticsPanel";
import { AppSettingsPanel } from "@/components/admin/AppSettingsPanel";
import { AuditLogPanel } from "@/components/admin/AuditLogPanel";
import { ConsolePanel } from "@/components/admin/ConsolePanel";
import { DeletionPanel } from "@/components/admin/DeletionPanel";
import { GroupsPanel } from "@/components/admin/GroupsPanel";
import { McpConnectorsPanel } from "@/components/admin/McpConnectorsPanel";
import { ModelsPanel } from "@/components/admin/ModelsPanel";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { TopNav } from "@/components/layout/TopNav";
import { isClerkAuth } from "@/auth/authMode";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

type TabId =
  | "users"
  | "members"
  | "groups"
  | "analytics"
  | "console"
  | "audit"
  | "settings"
  | "models"
  | "connectors"
  | "deletion";

// The org-admin "Members" tab — invite teammates, roles, seats — powered by
// Clerk's <OrganizationProfile/> (only meaningful in Clerk mode with an org).
const MEMBERS_TAB: TabDef = {
  id: "members",
  label: "Members",
  icon: <UserPlus className="h-3.5 w-3.5" />,
  subtitle: "Invite your team, manage roles, and add seats.",
};

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
      "Connect LLM providers and pick which models are available in Chat and Study.",
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: <Plug className="h-3.5 w-3.5" />,
    subtitle:
      "Connect remote MCP servers so the AI can use their tools in chat.",
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
  {
    id: "deletion",
    label: "Data & deletion",
    icon: <Trash2 className="h-3.5 w-3.5" />,
    subtitle: "Accounts and orgs pending deletion — restore or purge now.",
  },
];

export function AdminPage() {
  // Drive the active tab from ``?tab=...`` so deep links land on the
  // right surface (e.g. the ``/models`` legacy route now redirects to
  // ``/admin?tab=models``) and the back button steps through tabs the
  // user actually visited.
  // Platform admin (operator) sees every tab; a tenant/org admin sees only the
  // org-safe subset. Same page, scoped surface.
  const isPlatformAdmin = useAuthStore(
    (s) => s.user?.is_platform_admin ?? s.user?.role === "admin"
  );
  const hasOrg = useAuthStore((s) => !!s.user?.org_id);
  const visibleTabs = useMemo(() => {
    const pick = (id: TabId) => TABS.find((t) => t.id === id);
    const push = (id: TabId, out: TabDef[]) => {
      const t = pick(id);
      if (t) out.push(t);
    };
    // Everyone (INCLUDING the platform admin) manages only their OWN org's
    // resources here — Models, Members, Groups, Connectors, Analytics.
    const tabs: TabDef[] = [];
    push("models", tabs);
    if (isClerkAuth && hasOrg) tabs.push(MEMBERS_TAB);
    push("groups", tabs);
    push("connectors", tabs);
    push("analytics", tabs);
    // The platform admin (operator) additionally gets the fleet-level surfaces.
    // NOT the all-tenant Users tab — user management lives in Clerk.
    if (isPlatformAdmin) {
      push("console", tabs);
      push("audit", tabs);
      push("settings", tabs);
      push("deletion", tabs);
    }
    return tabs;
  }, [isPlatformAdmin, hasOrg]);

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
      <TopNav title={isPlatformAdmin ? "Admin" : "Settings"} subtitle={active.subtitle} />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6">
          <Tabs tabs={visibleTabs} current={tab} onChange={setTab} />
          <div className="mt-5">
            {tab === "users" && <UsersPanel />}
            {tab === "members" && isClerkAuth && (
              // Clerk's org member management — invite by email, roles, and
              // seats (enforced against the org's plan). Membership syncs back
              // to our shadow users via webhooks.
              <div className="flex justify-center">
                <OrganizationProfile routing="hash" />
              </div>
            )}
            {tab === "groups" && <GroupsPanel />}
            {tab === "models" && <ModelsPanel />}
            {tab === "connectors" && <McpConnectorsPanel />}
            {tab === "analytics" && <AnalyticsPanel />}
            {tab === "console" && <ConsolePanel />}
            {tab === "audit" && <AuditLogPanel />}
            {tab === "settings" && <AppSettingsPanel />}
            {tab === "deletion" && <DeletionPanel />}
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
