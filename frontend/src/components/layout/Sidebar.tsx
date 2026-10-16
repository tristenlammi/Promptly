import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Folder,
  FolderPlus,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";

import {
  NAV_ITEMS,
  OPT_IN_NAV_KEYS,
  type NavItem as NavItemConfig,
} from "./navItems";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import {
  hideConversationFromHistory,
  useArchiveConversation,
  useConversationsQuery,
  useFolderConversations,
  useUpdateConversation,
} from "@/hooks/useConversations";
import { useWorkspaceInvites } from "@/hooks/useWorkspaces";
import { BUCKET_ORDER, groupByBucket } from "@/utils/dateGroups";
import { cn } from "@/utils/cn";
import { ThemeToggle, useThemeSync } from "@/components/shared/ThemeToggle";
import { FeedbackModal } from "@/components/feedback/FeedbackModal";
import { Skeleton } from "@/components/shared/Skeleton";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { ShareInvitesPanel } from "@/components/chat/ShareInvitesPanel";
import { InboxPanel } from "./InboxPanel";
import { useInbox } from "@/hooks/useInbox";
import { logout } from "@/lib/session";
import type { ConversationSummary } from "@/api/types";
import { Bell, Inbox } from "lucide-react";

import { ConversationSearchBox } from "./ConversationSearchBox";
import { ConversationRowContextMenu } from "./ConversationRowContextMenu";
import { InstallAppButton } from "./InstallAppButton";
import { NewChatButton } from "./NewChatButton";
import { FolderEditModal } from "./FolderEditModal";
import { useChatFoldersQuery, useDeleteFolder } from "@/hooks/useChatFolders";
import { useFolderUiStore } from "@/store/folderUiStore";
import { confirm } from "@/components/shared/ConfirmDialog";
import type { ChatFolder } from "@/api/folders";

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
  // Opt-in surfaces ship hidden and appear only once enabled here.
  const enabledNav = useAuthStore((s) => s.user?.settings?.enabled_nav);
  const isMobile = useIsMobile();
  const {
    isLoading: convLoading,
    hasNextPage: moreChats,
    fetchNextPage: loadMoreChats,
    isFetchingNextPage: loadingMoreChats,
  } = useConversationsQuery(); // drives store
  const [searchActive, setSearchActive] = useState(false);
  // Folder create/edit modal. ``folderModal`` = null (closed), "new", or the
  // folder being edited.
  const [folderModal, setFolderModal] = useState<"new" | ChatFolder | null>(
    null
  );

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
  // Chat folders (0148). Folders live above Pinned; their chats show only
  // inside the folder, so they're excluded from the pinned/date buckets
  // (same principle as workspace chats). ``foldered`` maps folder id → its
  // chats (pinned first, then recency).
  const { data: folders = [] } = useChatFoldersQuery();
  const foldered = useMemo(() => {
    const byFolder = new Map<string, ConversationSummary[]>();
    for (const c of personalConversations) {
      if (!c.folder_id) continue;
      const list = byFolder.get(c.folder_id) ?? [];
      list.push(c);
      byFolder.set(c.folder_id, list);
    }
    for (const list of byFolder.values()) {
      list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      });
    }
    return byFolder;
  }, [personalConversations]);

  // Ungrouped personal chats (not in any folder) drive Pinned + date buckets.
  const ungrouped = useMemo(
    () => personalConversations.filter((c) => !c.folder_id),
    [personalConversations]
  );
  const pinned = useMemo(
    () => ungrouped.filter((c) => c.pinned),
    [ungrouped]
  );
  const unpinned = useMemo(
    () => ungrouped.filter((c) => !c.pinned),
    [ungrouped]
  );
  const groups = useMemo(() => groupByBucket(unpinned), [unpinned]);

  // Stage-3 prep: drive nav rendering from the shared ``NAV_ITEMS``
  // config so the future Promptly Drive PWA layout can filter the
  // same list to ``section === "drive"`` without touching markup.
  const hiddenSet = useMemo(
    () => new Set(hiddenNav ?? []),
    [hiddenNav]
  );
  const enabledSet = useMemo(
    () => new Set(enabledNav ?? []),
    [enabledNav]
  );
  const visibleNavItems: NavItemConfig[] = NAV_ITEMS.filter((it) => {
    if (it.desktopOnly && isMobile) return false;
    if (it.adminOnly && !isAdmin) return false;
    if (it.optionalKey) {
      // Opt-in surfaces: shown only when explicitly enabled.
      // Opt-out surfaces: shown unless the user hid them.
      if (OPT_IN_NAV_KEYS.has(it.optionalKey))
        return enabledSet.has(it.optionalKey);
      if (hiddenSet.has(it.optionalKey)) return false;
    }
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
          surfaces (Chat / Files) reduces visual clutter. The
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
        {/* Folders (0148) — always at the very top, above Pinned. Each is
            collapsed by default; the header row toggles it. The + on the row
            starts a new chat inside the folder. */}
        <div className="mb-1 mt-1 flex items-center justify-between gap-1 px-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <Folder className="h-3 w-3" /> Folders
          </span>
          <button
            type="button"
            onClick={() => setFolderModal("new")}
            className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--text)]"
            title="New folder"
            aria-label="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
        {folders.length === 0 ? (
          <button
            type="button"
            onClick={() => setFolderModal("new")}
            className="mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <FolderPlus className="h-3.5 w-3.5" /> New folder
          </button>
        ) : (
          folders.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              chats={foldered.get(f.id) ?? []}
              activeId={activeId}
              onEdit={() => setFolderModal(f)}
            />
          ))
        )}

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

        {moreChats && (
          <LoadMoreChats
            loading={loadingMoreChats}
            onLoad={() => void loadMoreChats()}
          />
        )}

        {convLoading && personalConversations.length === 0 && (
          <ChatListSkeleton />
        )}

        {!convLoading && personalConversations.length === 0 && folders.length === 0 && (
          <div className="mt-6 px-2 text-xs text-[var(--text-muted)]">
            No personal chats yet. Start a new chat or open a workspace.
          </div>
        )}
      </div>

      {/* Footer */}
      <UserFooter />

      <FolderEditModal
        open={folderModal !== null}
        folder={folderModal === "new" ? null : folderModal}
        onClose={() => setFolderModal(null)}
      />
    </aside>
  );
}

/** Loads the next page of chats when it scrolls into view — older chats
 *  used to be unreachable past the first 50 (R-047). Also a plain button,
 *  for keyboards and for when the observer can't fire. */
function LoadMoreChats({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    const el = ref.current;
    if (!el || loading || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadRef.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loading]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onLoad}
      disabled={loading}
      className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-70"
    >
      {loading ? "Loading…" : "Load older chats"}
    </button>
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
    <div className="mb-1 mt-3 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-text)]">
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
        className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
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
        // Informational, not a warning — temporary chats are a feature the
        // user chose, and amber read as "something's wrong".
        "bg-[var(--hover-strong)] text-[var(--text-muted)]"
      )}
      title={`Temporary chat — auto-deletes in ${label}`}
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
    // The "Chat archived / Undo" toast fires from the hook's onSuccess —
    // this row unmounts when the store drops it, and TanStack skips
    // per-call callbacks for unmounted components.
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
            <Pin className="h-3 w-3 shrink-0 fill-current text-[var(--accent-text)]" />
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
                  conv.pinned ? "fill-current text-[var(--accent-text)]" : ""
                )}
              />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleArchive();
              }}
              // Neutral, not amber: archive is a safe, reversible "put away",
              // and warning colours made users treat it like a delete.
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover-strong)] hover:text-[var(--text)]"
              title="Archive (restore anytime from the Archive page)"
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
          currentFolderId={conv.folder_id ?? null}
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

/**
 * A collapsible chat-folder row (0148). Collapsed by default; the header
 * toggles expansion. The + starts a new chat inside the folder (which also
 * expands it); the ⋯ menu edits or deletes the folder. Deleting lifts the
 * chats back to top-level (server SET NULL), never deletes them.
 */
function FolderRow({
  folder,
  chats,
  activeId,
  onEdit,
}: {
  folder: ChatFolder;
  chats: ConversationSummary[];
  activeId: string | undefined;
  onEdit: () => void;
}) {
  const navigate = useNavigate();
  const expanded = useFolderUiStore((s) => !!s.expanded[folder.id]);
  const folderQuery = useFolderConversations(folder.id, expanded);
  // This folder's chats from the server, plus any the store just learned
  // about (a chat moved in, a new chat here). Moving a chat refreshes every
  // conversation query, folders included, so one moved out drops off too.
  const folderChats = useMemo(() => {
    const byId = new Map<string, ConversationSummary>();
    for (const c of folderQuery.data?.pages.flat() ?? []) byId.set(c.id, c);
    for (const c of chats) byId.set(c.id, c);
    return [...byId.values()]
      .filter((c) => c.folder_id === folder.id && !c.archived_at)
      .sort((a, b) =>
        a.pinned !== b.pinned
          ? a.pinned
            ? -1
            : 1
          : b.updated_at.localeCompare(a.updated_at)
      );
  }, [folderQuery.data, chats, folder.id]);
  const toggle = useFolderUiStore((s) => s.toggle);
  const expand = useFolderUiStore((s) => s.expand);
  const del = useDeleteFolder();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const newChatInFolder = () => {
    expand(folder.id);
    navigate(`/chat?folder=${folder.id}`);
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    const ok = await confirm({
      title: `Delete "${folder.name}"?`,
      message:
        "The folder is removed, but its chats aren't — they move back to your main chat list.",
      confirmLabel: "Delete folder",
      danger: true,
    });
    if (ok) del.mutate(folder.id);
  };

  return (
    <div className="mb-0.5">
      <div
        className={cn(
          "group relative flex items-center gap-1 rounded-md px-1.5 py-1.5 text-sm transition",
          "text-[var(--text)] hover:bg-[var(--hover)]"
        )}
      >
        <button
          type="button"
          onClick={() => toggle(folder.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={expanded}
          title={expanded ? "Collapse folder" : "Expand folder"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
          <span className="truncate font-medium">{folder.name}</span>
          {/* The server's count — the loaded chats are only a page. */}
          {(folder.chat_count ?? folderChats.length) > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
              {folder.chat_count ?? folderChats.length}
            </span>
          )}
        </button>

        {/* Always-visible + (core action) */}
        <button
          type="button"
          onClick={newChatInFolder}
          className="shrink-0 rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--text)]"
          title="New chat in this folder"
          aria-label="New chat in this folder"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {/* ⋯ folder actions (edit / delete). Always visible so it works on
            touch without a hover. */}
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--text)]"
            title="Folder options"
            aria-label="Folder options"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 min-w-[150px] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text)] transition hover:bg-[var(--accent)]/[0.08]"
              >
                <Pencil className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                Edit folder
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleDelete()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--danger)] transition hover:bg-[var(--danger-bg)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete folder
              </button>
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div className="ml-3 border-l border-[var(--border)] pl-1.5">
          {folderChats.length === 0 && folderQuery.isLoading ? (
            <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">Loading…</div>
          ) : folderChats.length === 0 ? (
            <button
              type="button"
              onClick={newChatInFolder}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Plus className="h-3 w-3" /> New chat
            </button>
          ) : (
            folderChats.map((c) => (
              <ConversationRow key={c.id} conv={c} activeId={activeId} />
            ))
          )}
          {folderQuery.hasNextPage && (
            <LoadMoreChats
              loading={folderQuery.isFetchingNextPage}
              onLoad={() => void folderQuery.fetchNextPage()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function UserFooter() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  // Invites live in the account menu — an account-level collaboration
  // action, not a content surface. Pending ones badge the menu button.
  const [invitesOpen, setInvitesOpen] = useState(false);
  const { data: workspaceInvites } = useWorkspaceInvites();
  const inviteCount = workspaceInvites?.length ?? 0;
  // The durable notification inbox (mentions / assignments / invites /
  // automation results) keeps its own button: the unread badge is the
  // "things need your attention" cue and shouldn't hide in a menu.
  const [inboxOpen, setInboxOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { data: inbox } = useInbox();
  const unreadCount = inbox?.unread_count ?? 0;
  // The theme listener lives with the toggle, which is now inside a menu
  // that's usually closed — keep following the OS setting regardless.
  useThemeSync();

  // One account menu instead of seven footer rows (V6): the footer is
  // just you + the inbox, and everything account-ish opens from you.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !buttonRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const go = (to: string) => {
    setMenuOpen(false);
    navigate(to);
  };
  // Ends the session and leaves nothing of this user behind in the
  // browser — cached data, drafts, push notifications (R-030).
  const onLogout = () => void logout();

  const itemClass =
    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text)] transition hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none";

  return (
    <div className="relative border-t border-[var(--border)] p-3 pb-safe">
      <InstallAppButton />
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          className="absolute bottom-full left-3 right-3 z-30 mb-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl"
        >
          <button role="menuitem" className={itemClass} onClick={() => go("/account")}>
            <ShieldCheck className="h-4 w-4 text-[var(--text-muted)]" />
            Account
          </button>
          {isAdmin && (
            <button role="menuitem" className={itemClass} onClick={() => go("/admin")}>
              <Settings className="h-4 w-4 text-[var(--text-muted)]" />
              Admin
            </button>
          )}
          <button role="menuitem" className={itemClass} onClick={() => go("/archive")}>
            <Archive className="h-4 w-4 text-[var(--text-muted)]" />
            Archived chats
          </button>
          {inviteCount > 0 && (
            <button
              role="menuitem"
              className={itemClass}
              onClick={() => {
                setMenuOpen(false);
                setInvitesOpen(true);
              }}
            >
              <Inbox className="h-4 w-4 text-[var(--text-muted)]" />
              Workspace invites
              <span className="ml-auto inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white">
                {inviteCount}
              </span>
            </button>
          )}
          <button
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setMenuOpen(false);
              setFeedbackOpen(true);
            }}
          >
            <MessageSquare className="h-4 w-4 text-[var(--text-muted)]" />
            Send feedback
          </button>
          <div className="my-1 flex items-center justify-between border-y border-[var(--border)] px-2 py-1.5">
            <span className="text-sm text-[var(--text)]">Theme</span>
            <ThemeToggle />
          </div>
          <button role="menuitem" className={itemClass} onClick={onLogout}>
            <LogOut className="h-4 w-4 text-[var(--text-muted)]" />
            Log out
          </button>
          <div
            className="px-2 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-[var(--text-muted)]"
            title={`Promptly v${__APP_VERSION__}`}
          >
            Promptly v{__APP_VERSION__}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Account menu"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition hover:bg-[var(--hover)]"
        >
          <span className="relative shrink-0">
            <UserAvatar
              name={user?.username ?? "?"}
              userId={user?.id}
              avatarUrl={user?.avatar_url}
              color={user?.avatar_color}
              size={32}
              initialsCount={2}
            />
            {inviteCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg)]"
                title={`${inviteCount} pending workspace invite${inviteCount === 1 ? "" : "s"}`}
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">
                {user?.username ?? "Guest"}
              </span>
              {isAdmin && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-text)] ring-1 ring-[var(--accent)]/40"
                  title="Administrator"
                >
                  Admin
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-[var(--text-muted)]">
              {user?.email ?? ""}
            </span>
          </span>
          <ChevronUp
            className={cn(
              "h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform",
              !menuOpen && "rotate-180",
            )}
          />
        </button>
        <button
          onClick={() => setInboxOpen(true)}
          className="relative shrink-0 rounded-md p-2 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          title="Notifications"
          aria-label="Open notification inbox"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white">
              {unreadCount}
            </span>
          )}
        </button>
      </div>
      <ShareInvitesPanel
        open={invitesOpen}
        onClose={() => setInvitesOpen(false)}
      />
      <InboxPanel open={inboxOpen} onClose={() => setInboxOpen(false)} />
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}
