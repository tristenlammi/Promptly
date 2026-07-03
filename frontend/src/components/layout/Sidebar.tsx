import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  Clock,
  LogOut,
  MoreHorizontal,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Star,
} from "lucide-react";

import { NAV_ITEMS, type NavItem as NavItemConfig } from "./navItems";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import {
  hideConversationFromHistory,
  useArchiveConversation,
  useConversationsQuery,
  useUpdateConversation,
} from "@/hooks/useConversations";
import { useWorkspaceInvites } from "@/hooks/useWorkspaces";
import { BUCKET_ORDER, groupByBucket } from "@/utils/dateGroups";
import { cn } from "@/utils/cn";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { Skeleton } from "@/components/shared/Skeleton";
import { ShareInvitesPanel } from "@/components/chat/ShareInvitesPanel";
import { authApi } from "@/api/auth";
import type { ConversationSummary } from "@/api/types";
import { Inbox } from "lucide-react";

import { ConversationSearchBox } from "./ConversationSearchBox";
import { ConversationRowContextMenu } from "./ConversationRowContextMenu";
import { InstallAppButton } from "./InstallAppButton";
import { NewChatButton } from "./NewChatButton";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { id: activeId } = useParams<{ id?: string }>();
  const conversations = useChatStore((s) => s.conversations);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  // Per-user feature visibility (Phase 2): optional nav surfaces the
  // user chose to hide from their sidebar. Purely cosmetic.
  const hiddenNav = useAuthStore((s) => s.user?.settings?.hidden_nav);
  // Study is desktop/tablet only — the chat/whiteboard split and the
  // interactive exercises are too cramped below the md breakpoint (<768px).
  const isMobile = useIsMobile();
  const { isLoading: convLoading } = useConversationsQuery(); // drives store
  const [searchActive, setSearchActive] = useState(false);

  // Workspace-scoped chats live exclusively inside their workspace's
  // detail page now — surfacing them again in the global sidebar
  // creates duplicate entries (one here, one under "Conversations"
  // in the workspace) and clutters the date buckets with chats that
  // belong to a shared workspace, not the user's personal stream.
  // Filter them out at the source so pinned/unpinned/search all
  // honour the same rule.
  const personalConversations = useMemo(
    // Archived chats live on the Archive page; the backend already
    // excludes them from this list, but filter defensively so an
    // optimistic store update can't flash an archived row.
    () => conversations.filter((c) => !c.workspace_id && !c.archived_at),
    [conversations]
  );
  const pinned = useMemo(
    () => personalConversations.filter((c) => c.pinned),
    [personalConversations]
  );
  const unpinned = useMemo(
    () => personalConversations.filter((c) => !c.pinned),
    [personalConversations]
  );
  const groups = useMemo(() => groupByBucket(unpinned), [unpinned]);

  // Stage-3 prep: drive nav rendering from the shared ``NAV_ITEMS``
  // config so the future Promptly Drive PWA layout can filter the
  // same list to ``section === "drive"`` without touching markup.
  const hiddenSet = useMemo(
    () => new Set(hiddenNav ?? []),
    [hiddenNav]
  );
  const visibleNavItems: NavItemConfig[] = NAV_ITEMS.filter((it) => {
    if (it.desktopOnly && isMobile) return false;
    if (it.adminOnly && !isAdmin) return false;
    if (it.optionalKey && hiddenSet.has(it.optionalKey)) return false;
    return true;
  });

  if (collapsed) {
    return (
      <aside
        className={cn(
          "flex h-full w-14 shrink-0 flex-col items-center border-r py-3",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
      >
        <button
          onClick={onToggle}
          className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <div className="mb-3">
          <NewChatButton compact />
        </div>
        <nav className="flex flex-col items-center gap-1">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <SideIcon
                key={item.to}
                to={item.to}
                icon={<Icon className="h-4 w-4" />}
                label={item.label}
              />
            );
          })}
          <SideIcon
            to="/archive"
            icon={<Archive className="h-4 w-4" />}
            label="Archive"
          />
          {isAdmin && (
            <SideIcon to="/admin" icon={<Settings className="h-4 w-4" />} label="Settings" />
          )}
        </nav>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "flex h-full w-72 shrink-0 flex-col border-r",
        "border-[var(--border)] bg-[var(--surface)]"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <span className="text-sm font-bold">P</span>
          </div>
          <span className="text-sm font-semibold tracking-tight">Promptly</span>
        </div>
        <button
          onClick={onToggle}
          className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {/* New chat — split button: main click starts a normal chat,
          chevron opens a popover with two temporary chat options
          (ephemeral / 1-hour). See NewChatButton for the popover UI. */}
      <div className="px-3">
        <NewChatButton />
      </div>

      {/* Nav — Models management lives inside Settings now (admin-only
          tab); keeping the top-level nav focused on the day-to-day
          surfaces (Chat / Study / Files) reduces visual clutter. The
          list itself is driven by the shared ``NAV_ITEMS`` config
          so stage-3's Drive-only PWA can filter by ``section``. */}
      <nav className="mt-4 flex flex-col gap-0.5 px-2">
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavItem
              key={item.to}
              to={item.to}
              icon={<Icon className="h-4 w-4" />}
              label={item.label}
              end={item.exact}
            />
          );
        })}
      </nav>

      {/* Search across all conversations. Activates a panel that
          replaces the conversation list while a query is in play; an
          empty box collapses straight back to the normal sidebar. */}
      <div className="mt-3">
        <ConversationSearchBox onActive={setSearchActive} />
      </div>

      {/* Conversation list — hidden while a search is active so the
          results panel above can take the full vertical space. */}
      <div
        className={cn(
          "promptly-scroll mt-1 flex-1 overflow-y-auto px-2 pb-2",
          searchActive && "hidden"
        )}
      >
        {pinned.length > 0 && (
          <SectionHeader>
            <Pin className="h-3 w-3 fill-current" /> Pinned
          </SectionHeader>
        )}
        {pinned.map((c) => (
          <ConversationRow key={c.id} conv={c} activeId={activeId} />
        ))}

        {BUCKET_ORDER.map((bucket) => {
          const items = groups.get(bucket);
          if (!items || items.length === 0) return null;
          return (
            <div key={bucket} className="mt-2">
              <SectionHeader>{bucket}</SectionHeader>
              {items.map((c) => (
                <ConversationRow key={c.id} conv={c} activeId={activeId} />
              ))}
            </div>
          );
        })}

        {convLoading && personalConversations.length === 0 && (
          <ChatListSkeleton />
        )}

        {!convLoading && personalConversations.length === 0 && (
          <div className="mt-6 px-2 text-xs text-[var(--text-muted)]">
            No personal chats yet. Start a new chat or open a workspace.
          </div>
        )}
      </div>

      {/* Footer */}
      <UserFooter />
    </aside>
  );
}

/** Placeholder list shown while the first conversations load — mocks a
 *  couple of date-bucketed groups so the sidebar doesn't flash empty. */
function ChatListSkeleton() {
  return (
    <div className="mt-2 space-y-4" aria-hidden>
      {[4, 3].map((count, gi) => (
        <div key={gi} className="space-y-1.5">
          <Skeleton className="ml-2 h-3 w-16" />
          {Array.from({ length: count }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 mt-3 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">
      {children}
    </div>
  );
}

/**
 * Phase Z1 — clock pill rendered next to the title of a 1-hour
 * temporary chat in the sidebar. Reads ``expires_at`` from the
 * conversation row and re-renders once a minute so the displayed
 * countdown drifts at most ~30 s. Cheap to leave running for every
 * temporary chat in the list because we only schedule a single
 * shared interval per badge.
 */
function TemporaryCountdownBadge({ expiresAt }: { expiresAt: string | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (!expiresAt) {
    return (
      <Clock
        className="h-3 w-3 shrink-0 text-amber-500"
        aria-label="Temporary chat"
      />
    );
  }
  const deltaMs = new Date(expiresAt).getTime() - Date.now();
  let label: string;
  if (deltaMs <= 0) {
    label = "0m";
  } else {
    const mins = Math.max(1, Math.round(deltaMs / 60_000));
    label = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1 py-px",
        "text-[9px] font-semibold tabular-nums",
        "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      )}
      title={`Auto-deletes in ${label}`}
    >
      <Clock className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition",
          isActive
            ? "bg-[var(--accent)]/10 text-[var(--text)] font-medium"
            : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function SideIcon({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      title={label}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-md transition",
          isActive
            ? "bg-[var(--accent)]/10 text-[var(--text)]"
            : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        )
      }
    >
      {icon}
    </NavLink>
  );
}

function ConversationRow({
  conv,
  activeId,
}: {
  conv: ConversationSummary;
  activeId: string | undefined;
}) {
  const navigate = useNavigate();
  const update = useUpdateConversation();
  const archive = useArchiveConversation();
  const isMobile = useIsMobile();
  const isActive = activeId === conv.id;
  const title = conv.title?.trim() || "New chat";
  // Position is in *viewport* coordinates because the menu is rendered
  // through a portal with ``position: fixed``.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(
    null
  );

  // Long-press → context menu on touch devices. We can't rely on the
  // browser's native ``contextmenu`` event firing consistently after
  // a long press on iOS Safari / mobile Chrome, so we instrument it
  // ourselves with a 500 ms threshold and cancel on any pointer
  // movement to avoid hijacking taps and scrolls.
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const onTouchStart = (e: React.TouchEvent) => {
    longPressFired.current = false;
    const t = e.touches[0];
    if (!t) return;
    const x = t.clientX;
    const y = t.clientY;
    cancelLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      setMenuPos({ x, y });
    }, 500);
  };
  const onTouchEndOrCancel = () => cancelLongPress();
  const onTouchMove = () => cancelLongPress();

  // Archive is reversible, so it fires immediately (no confirm dialog) —
  // permanent deletion lives on the Archive page. The row clears from the
  // sidebar via the mutation's store update.
  const handleArchive = () => {
    archive.mutate(conv.id, {
      onSuccess: () => {
        if (isActive) navigate("/chat");
      },
      onError: async (err) => {
        // A chat we can see but don't own (e.g. one shared to us before
        // per-chat sharing was retired) returns 404/403 from archive.
        // Fall back to hiding it from our own history so the row clears.
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        if (status === 404 || status === 403) {
          try {
            await hideConversationFromHistory(conv.id);
            if (isActive) navigate("/chat");
          } catch {
            /* best-effort — nothing more we can do here */
          }
        }
      },
    });
  };

  return (
    <>
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition",
          isActive
            ? "bg-[var(--hover-strong)] text-[var(--text)]"
            : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEndOrCancel}
        onTouchCancel={onTouchEndOrCancel}
        onTouchMove={onTouchMove}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            // Long-press synthesises a click on touch end — swallow
            // it so opening the menu doesn't also yank the user
            // into the chat.
            if (longPressFired.current) {
              longPressFired.current = false;
              return;
            }
            navigate(`/chat/${conv.id}`);
          }}
        >
          {conv.starred && <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500" />}
          {/* Persistent pinned indicator — a small filled pin glyph in
              the accent colour. Survives the active-row highlight since
              the icon colour is independent of the row's text colour.
              The temporary-chat badge takes precedence in the rare
              overlap so we don't stack two leading glyphs. */}
          {conv.pinned && conv.temporary_mode !== "one_hour" && (
            <Pin className="h-3 w-3 shrink-0 fill-current text-[var(--accent)]" />
          )}
          {conv.temporary_mode === "one_hour" && (
            <TemporaryCountdownBadge expiresAt={conv.expires_at ?? null} />
          )}
          <span className="truncate">{title}</span>
        </button>
        {isMobile ? (
          // Touch: a single always-visible ⋯ opens the full action menu
          // (pin / delete / move / export). Hover quick-actions don't
          // exist on touch, and a 500ms long-press is undiscoverable.
          <button
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenuPos({ x: r.left, y: r.bottom + 4 });
            }}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover-strong)]"
            aria-label="Conversation actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        ) : (
          // Desktop: hover-revealed quick actions, plus right-click for
          // the full menu.
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation();
                update.mutate({
                  id: conv.id,
                  payload: { pinned: !conv.pinned },
                });
              }}
              className="rounded p-1 hover:bg-[var(--hover-strong)]"
              title={conv.pinned ? "Unpin" : "Pin"}
              aria-label={conv.pinned ? "Unpin conversation" : "Pin conversation"}
            >
              <Pin
                className={cn(
                  "h-3 w-3",
                  conv.pinned ? "fill-current text-[var(--accent)]" : ""
                )}
              />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleArchive();
              }}
              className="rounded p-1 text-amber-600 hover:bg-amber-500/10 dark:text-amber-500"
              title="Archive"
              aria-label="Archive conversation"
            >
              <Archive className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {menuPos && (
        <ConversationRowContextMenu
          conversationId={conv.id}
          currentWorkspaceId={conv.workspace_id ?? null}
          pinned={!!conv.pinned}
          onTogglePin={() =>
            update.mutate({ id: conv.id, payload: { pinned: !conv.pinned } })
          }
          onArchive={handleArchive}
          position={menuPos}
          onClose={() => setMenuPos(null)}
        />
      )}
    </>
  );
}

function UserFooter() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  // The admin gets the admin surface.
  const canManageOrg = isAdmin;
  // Invites live here (account area) rather than the primary nav — they're
  // an account-level collaboration action, not a content surface. Always
  // rendered so the pending-count badge has a stable home.
  const [invitesOpen, setInvitesOpen] = useState(false);
  const { data: workspaceInvites } = useWorkspaceInvites();
  const inviteCount = workspaceInvites?.length ?? 0;

  const onLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore — clearing local state is the point.
    }
    clear();
    navigate("/login");
  };

  const initials = (user?.username ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="border-t border-[var(--border)] p-3 pb-safe">
      <InstallAppButton />
      {/* Archived chats — sits above Account/Settings so it reads as a
          chat surface (where your put-away conversations live) rather
          than an account control. */}
      <button
        onClick={() => navigate("/archive")}
        className="mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        title="Archived chats"
        aria-label="Open archived chats"
      >
        <Archive className="h-4 w-4" />
        <span className="font-medium">Archive</span>
      </button>
      {/* Workspace invites — pending collaboration invites the user can
          accept or decline. Click opens a modal listing them. */}
      <button
        onClick={() => setInvitesOpen(true)}
        className="relative mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        title="Workspace invites"
        aria-label="Open workspace invites"
      >
        <Inbox className="h-4 w-4" />
        <span className="font-medium">Invites</span>
        {inviteCount > 0 && (
          <span className="ml-auto inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white">
            {inviteCount}
          </span>
        )}
      </button>
      {/* Per-user account settings — every authenticated user gets one.
          Hosts chat-default preferences plus MFA / trusted devices. The
          route still ends in /security for backwards compatibility but
          the page hosts the broader account surface now. */}
      <button
        onClick={() => navigate("/account/security")}
        className="mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        title="Account"
        aria-label="Open account settings"
      >
        <ShieldCheck className="h-4 w-4" />
        <span className="font-medium">Account</span>
      </button>
      {/* Admin surface. Org admins get the tenant-scoped view (Models, etc.);
          the platform admin gets every tab. Members don't see it. */}
      {canManageOrg && (
        <button
          onClick={() => navigate("/admin")}
          className="mb-2 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          title={isAdmin ? "Platform admin" : "Organization admin"}
          aria-label="Open admin"
        >
          <Settings className="h-4 w-4" />
          <span className="font-medium">Admin</span>
        </button>
      )}
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)]/20 text-xs font-semibold text-[var(--text)]">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {user?.username ?? "Guest"}
            </span>
            {isAdmin && (
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)] ring-1 ring-[var(--accent)]/40"
                title="Administrator"
              >
                Admin
              </span>
            )}
          </div>
          <div className="truncate text-xs text-[var(--text-muted)]">
            {user?.email ?? ""}
          </div>
        </div>
        <button
          onClick={onLogout}
          className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          title="Log out"
          aria-label="Log out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-[var(--text-muted)]">Theme</span>
        <ThemeToggle />
      </div>
      <ShareInvitesPanel
        open={invitesOpen}
        onClose={() => setInvitesOpen(false)}
      />
    </div>
  );
}
