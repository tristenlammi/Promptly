import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  BarChart3,
  Bell,
  Bookmark,
  Brain,
  LayoutGrid,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Volume2,
} from "lucide-react";

import { ChatPreferencesPanel } from "@/components/account/ChatPreferencesPanel";
import { FeatureVisibilityPanel } from "@/components/account/FeatureVisibilityPanel";
import { MemoryPanel } from "@/components/account/MemoryPanel";
import { NotificationsPanel } from "@/components/account/NotificationsPanel";
import { PersonalContextPanel } from "@/components/account/PersonalContextPanel";
import { SavedPromptsPanel } from "@/components/account/SavedPromptsPanel";
import { UsagePanel } from "@/components/account/UsagePanel";
import { VoicePanel } from "@/components/account/VoicePanel";
import { MfaSettingsPanel } from "@/components/mfa/MfaSettingsPanel";
import { TopNav } from "@/components/layout/TopNav";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

/** User-facing account settings. Lives at /account/security and is
 * accessible to every authenticated user (admin or otherwise). The
 * admin-only "App settings" panel for org-wide MFA enforcement and
 * SMTP config lives separately on the admin page.
 *
 * The page kept its security-focused name and route for backwards
 * compatibility, but now houses the broader account-preferences surface.
 * A section rail (sticky on desktop, a scrollable chip strip on mobile)
 * lets users jump straight to a group instead of scrolling the whole
 * stack — and the shared TopNav restores the mobile nav hamburger that
 * the old bespoke header was missing.
 */
interface Section {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  node: ReactNode;
}

export function AccountSecurityPage() {
  const user = useAuthStore((s) => s.user);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<string>("about");

  const sections: Section[] = [
    { id: "about", label: "About you", icon: UserRound, node: <PersonalContextPanel /> },
    { id: "chat", label: "Chat defaults", icon: SlidersHorizontal, node: <ChatPreferencesPanel /> },
    { id: "memory", label: "Memory", icon: Brain, node: <MemoryPanel /> },
    { id: "interface", label: "Interface", icon: LayoutGrid, node: <FeatureVisibilityPanel /> },
    { id: "voice", label: "Voice", icon: Volume2, node: <VoicePanel /> },
    { id: "usage", label: "Usage & cost", icon: BarChart3, node: <UsagePanel /> },
    { id: "prompts", label: "Saved prompts", icon: Bookmark, node: <SavedPromptsPanel /> },
    { id: "notifications", label: "Notifications", icon: Bell, node: <NotificationsPanel /> },
    {
      id: "security",
      label: "Security & MFA",
      icon: ShieldCheck,
      node: <MfaSettingsPanel defaultEmail={user?.email} />,
    },
  ];

  // Scroll-spy: highlight the rail entry for whichever section is near
  // the top of the scroll viewport. The -70% bottom rootMargin biases
  // selection toward the section that's just entered the upper third.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0])
          setActive(visible[0].target.id.replace(/^section-/, ""));
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    root.querySelectorAll("[data-section]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // Sections array is stable in shape; re-running on user change is fine.
  }, [user?.email]);

  const jump = (id: string) => {
    scrollRef.current
      ?.querySelector(`#section-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <TopNav
        title="Account"
        subtitle="Personalisation, chat defaults, notifications, and security"
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {/* Mobile: horizontal chip strip pinned under the top bar. */}
        <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 px-3 py-2 backdrop-blur md:hidden">
          <div className="promptly-scroll flex gap-1.5 overflow-x-auto">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => jump(s.id)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                  active === s.id
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                )}
              >
                <s.icon className="h-3.5 w-3.5" />
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-5xl gap-6 px-4 py-5 md:px-6">
          {/* Desktop: sticky vertical rail. */}
          <nav className="hidden w-48 shrink-0 md:block">
            <div className="sticky top-4 space-y-0.5">
              {sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jump(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition",
                    active === s.id
                      ? "bg-[var(--accent)]/10 font-medium text-[var(--accent)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
                  )}
                >
                  <s.icon className="h-4 w-4 shrink-0" />
                  {s.label}
                </button>
              ))}
            </div>
          </nav>

          <div className="min-w-0 flex-1 space-y-6">
            {sections.map((s) => (
              <section
                key={s.id}
                id={`section-${s.id}`}
                data-section
                className="scroll-mt-16 md:scroll-mt-4"
              >
                {s.node}
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
