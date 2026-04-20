import { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  BookOpen,
  Clock,
  FolderOpen,
  LogOut,
  MessagesSquare,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";

import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import {
  useConversationsQuery,
  useDeleteConversation,
  useShareInvites,
  useUpdateConversation,
} from "@/hooks/useConversations";
import { BUCKET_ORDER, groupByBucket } from "@/utils/dateGroups";
import { cn } from "@/utils/cn";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { ShareInvitesPanel } from "@/components/chat/ShareInvitesPanel";
import { authApi } from "@/api/auth";
import type { ConversationSummary } from "@/api/types";
import { Inbox, Users } from "lucide-react";

import { ConversationSearchBox } from "./ConversationSearchBox";
import { DeleteChatModal } from "./DeleteChatModal";
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
  useConversationsQuery(); // drives store
  const [searchActive, setSearchActive] = useState(false);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const { data: invites } = useShareInvites();
  const inviteCount = invites?.length ?? 0;

  const pinned = useMemo(
    () => conversations.filter((c) => c.pinned),
    [conversations]
  );
  const unpinned = useMemo(
    () => conversations.filter((c) => !c.pinned),
    [conversations]
  );
  const groups = useMemo(() => groupByBucket(unpinned), [unpinned]);

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
          className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <div className="mb-3">
          <NewChatButton compact />
        </div>
        <nav className="flex flex-col items-center gap-1">
          <SideIcon to="/chat" icon={<MessagesSquare className="h-4 w-4" />} label="Chat" />
          <SideIcon to="/study" icon={<BookOpen className="h-4 w-4" />} label="Study" />
          <SideIcon to="/files" icon={<FolderOpen className="h-4 w-4" />} label="Files" />
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
          surfaces (Chat / Study / Files) reduces visual clutter. */}
      <nav className="mt-4 flex flex-col gap-0.5 px-2">
        <NavItem to="/chat" icon={<MessagesSquare className="h-4 w-4" />} label="Chat" end />
        <NavItem to="/study" icon={<BookOpen className="h-4 w-4" />} label="Study" />
        <NavItem to="/files" icon={<FolderOpen className="h-4 w-4" />} label="Files" />
        {/* Phase 4b: invites entry. Always rendered so the badge has a
            stable place to sit; click opens a modal listing pending
            invites the caller can accept or decline. */}
        <button
          type="button"
          onClick={() => setInvitesOpen(true)}
          className={cn(
            "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition",
            "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          )}
          title="Conversation invites"
        >
          <Inbox className="h-4 w-4" />
          <span>Invites</span>
          {inviteCount > 0 && (
            <span className="ml-auto inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white">
              {inviteCount}
            </span>
          )}
        </button>
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
          "mt-1 flex-1 overflow-y-auto px-2 pb-2",
          searchActive && "hidden"
        )}
      >
        {pinned.length > 0 && (
          <SectionHeader>
            <Pin className="h-3 w-3" /> Pinned
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

        {conversations.length === 0 && (
          <div className="mt-6 px-2 text-xs text-[var(--text-muted)]">
            No conversations yet. Start a new chat to get going.
          </div>
        )}
      </div>

      {/* Footer */}
      <UserFooter />

      <ShareInvitesPanel
        open={invitesOpen}
        onClose={() => setInvitesOpen(false)}
      />
    </aside>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 mt-3 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
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
  const remove = useDeleteConversation();
  const isActive = activeId === conv.id;
  const title = conv.title?.trim() || "New chat";
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleDelete = () =>
    new Promise<void>((resolve, reject) => {
      remove.mutate(conv.id, {
        onSuccess: () => {
          if (isActive) navigate("/chat");
          setConfirmOpen(false);
          resolve();
        },
        onError: (err) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      });
    });

  return (
    <>
      <div
        className={cn(
          "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition",
          isActive
            ? "bg-black/[0.05] text-[var(--text)] dark:bg-white/[0.06]"
            : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        )}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => navigate(`/chat/${conv.id}`)}
        >
          {conv.starred && <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500" />}
          {conv.temporary_mode === "one_hour" && (
            <TemporaryCountdownBadge expiresAt={conv.expires_at ?? null} />
          )}
          <span className="truncate">{title}</span>
          {conv.role === "collaborator" && (
            <span
              className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--accent)]"
              title="Shared with you"
            >
              <Users className="inline h-2.5 w-2.5" />
            </span>
          )}
        </button>
        {/* Pin / delete are owner-only — collaborators on a shared
            chat shouldn't be able to mutate state out from under the
            owner. The backend enforces both, this just hides the
            affordances cleanly. */}
        {conv.role !== "collaborator" && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation();
                update.mutate({ id: conv.id, payload: { pinned: !conv.pinned } });
              }}
              className="rounded p-1 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
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
                setConfirmOpen(true);
              }}
              className="rounded p-1 text-red-500 hover:bg-red-500/10"
              title="Delete"
              aria-label="Delete conversation"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      <DeleteChatModal
        open={confirmOpen}
        conversationTitle={title}
        onConfirm={handleDelete}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}

function UserFooter() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";

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
      {/* Admin-only settings entry, sits just above the identity row. */}
      {isAdmin && (
        <button
          onClick={() => navigate("/admin")}
          className="mb-2 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          title="Admin settings"
          aria-label="Open admin settings"
        >
          <Settings className="h-4 w-4" />
          <span className="font-medium">Settings</span>
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
    </div>
  );
}
