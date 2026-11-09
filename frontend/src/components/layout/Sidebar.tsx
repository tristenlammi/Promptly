import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { VoicePanel } from "@/rtc/ui/VoicePanel";
import {
  Archive,
  EyeOff,
  FolderPlus,
  Inbox,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { useUIStore } from "@/store/uiStore";

import { RAIL_MORE_ITEMS, visibleNavItems as pickNavItems } from "./navItems";
import {
  ACCOUNT_BUTTON_CLASS,
  ACCOUNT_MENU_CLASS,
  ACCOUNT_MENU_ICON_CLASS,
  ACCOUNT_MENU_ITEM_CLASS,
  AccountButtonContent,
  AppIcon,
  AppVersionLine,
  byPinnedThenRecent,
  CHAT_LIST_CLASS,
  ChatListNote,
  ChatListSkeleton,
  ChatRowContent,
  chatRowClass,
  ExpandSidebarButton,
  FOLDER_ACTION_CLASS,
  FOLDER_CHATS_CLASS,
  FOLDER_NOTE_CLASS,
  FOLDER_ROW_CLASS,
  FOLDER_TOGGLE_CLASS,
  FolderToggleContent,
  FoldersLabel,
  FOOTER_CLASS,
  INBOX_BUTTON_CLASS,
  InboxButtonContent,
  InviteCount,
  LoadMoreChats,
  NavRowContent,
  rowName,
  navRowClass,
  NO_CHATS_TEXT,
  PinnedHeader,
  RAIL_CLASS,
  railIconClass,
  SEARCH_BOX_CLASS,
  SearchBoxContent,
  SectionHeader,
  SIDEBAR_CLASS,
  SidebarHeader,
  SMALL_ACTION_ROW_CLASS,
  THEME_ROW_CLASS,
} from "./sidebarParts";
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
import { ShareInvitesPanel } from "@/components/chat/ShareInvitesPanel";
import { InboxPanel } from "./InboxPanel";
import { useInbox } from "@/hooks/useInbox";
import { logout } from "@/lib/session";
import type { ConversationSummary } from "@/api/types";

import { ConversationRowContextMenu } from "./ConversationRowContextMenu";
import { InstallAppButton } from "./InstallAppButton";
import { NewChatButton } from "./NewChatButton";
import { FolderEditModal } from "./FolderEditModal";
import { useChatFoldersQuery, useDeleteFolder } from "@/hooks/useChatFolders";
import { useFolderUiStore } from "@/store/folderUiStore";
import { useNavApps } from "@/items/navApps";
import { useNavBadges } from "@/hooks/useNavBadges";
import { useCanUseAutomations } from "@/hooks/useCanUseAutomations";
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
  const canAutomate = useCanUseAutomations();
  const isMobile = useIsMobile();
  // Apps the user pinned to their sidebar (from Apps → Edit).
  const { apps: navApps, iconStyle } = useNavApps();
  // Count badges on the pinned apps' rows (Tasks due, unread Mail and
  // Rooms, new on Porch).
  const navAppIds = useMemo(() => navApps.map((a) => a.id), [navApps]);
  const badges = useNavBadges(navAppIds);
  const { pathname } = useLocation();
  // While a pinned app is open, its own row lights up — not "Apps" too.
  const inNavApp = navApps.some((a) => pathname === a.to || pathname.startsWith(`${a.to}/`));
  // Calls: Rooms shows the voice panel in its own channel column.
  const voiceHere = !pathname.startsWith("/rooms");
  const {
    isLoading: convLoading,
    hasNextPage: moreChats,
    fetchNextPage: loadMoreChats,
    isFetchingNextPage: loadingMoreChats,
  } = useConversationsQuery(); // drives store
  const openSearch = useUIStore((s) => s.openSearchPalette);
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
    for (const list of byFolder.values()) list.sort(byPinnedThenRecent);
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
  const visibleNavItems = pickNavItems({ hidden: hiddenNav, enabled: enabledNav, isAdmin, canAutomate, isMobile });

  if (collapsed) {
    return (
      <aside className={RAIL_CLASS}>
        <ExpandSidebarButton onToggle={onToggle} />
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
                inactive={inNavApp && item.to === "/apps"}
              />
            );
          })}
          {navApps.map((app) => (
            <SideIcon
              key={app.id}
              to={app.to}
              icon={<AppIcon app={app} style={iconStyle} />}
              label={app.name}
              badge={{ app: app.id, n: badges[app.id] ?? 0 }}
            />
          ))}
          {RAIL_MORE_ITEMS.filter((it) => !it.adminOnly || isAdmin).map((item) => {
            const Icon = item.icon;
            return <SideIcon key={item.to} to={item.to} icon={<Icon className="h-4 w-4" />} label={item.label} />;
          })}
        </nav>
        {voiceHere && <VoicePanel variant="collapsed" />}
      </aside>
    );
  }

  return (
    <aside className={SIDEBAR_CLASS}>
      <SidebarHeader onToggle={onToggle} />

      {/* New chat — split button: main click starts a normal chat,
          chevron opens a popover with two temporary chat options
          (ephemeral / 1-hour). See NewChatButton for the popover UI. */}
      <div className="px-3">
        <NewChatButton />
        {/* The one search: chats, messages, mail, events, tasks and more (Ctrl+K). */}
        <button type="button" onClick={openSearch} aria-keyshortcuts="Control+K Meta+K" className={SEARCH_BOX_CLASS}>
          <SearchBoxContent />
        </button>
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
              inactive={inNavApp && item.to === "/apps"}
            />
          );
        })}
        {navApps.map((app) => (
          <NavItem
            key={app.id}
            to={app.to}
            icon={<AppIcon app={app} style={iconStyle} />}
            label={app.name}
            badge={{ app: app.id, n: badges[app.id] ?? 0 }}
          />
        ))}
      </nav>

      {/* Conversation list */}
      <div className={CHAT_LIST_CLASS}>
        {/* Folders (0148) — always at the very top, above Pinned. Each is
            collapsed by default; the header row toggles it. The + on the row
            starts a new chat inside the folder. */}
        <div className="mb-1 mt-1 flex items-center justify-between gap-1 px-2">
          <FoldersLabel />
          <button
            type="button"
            onClick={() => setFolderModal("new")}
            className={FOLDER_ACTION_CLASS}
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
            className={cn("mb-1", SMALL_ACTION_ROW_CLASS)}
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

        {pinned.length > 0 && <PinnedHeader />}
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
          <ChatListNote>{NO_CHATS_TEXT}</ChatListNote>
        )}
      </div>

      {/* Calls: you're in voice — Mute, Deafen, Disconnect wherever you are. */}
      {voiceHere && <VoicePanel variant="sidebar" />}
      {/* Footer */}
      <UserFooter onNewFolder={() => setFolderModal("new")} />

      <FolderEditModal
        open={folderModal !== null}
        folder={folderModal === "new" ? null : folderModal}
        onClose={() => setFolderModal(null)}
      />
    </aside>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
  inactive,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  end?: boolean;
  /** Never show as the current page (another row owns this path). */
  inactive?: boolean;
  /** A count badge at the end of the row (hidden at 0). */
  badge?: { app: string; n: number };
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => navRowClass(isActive && !inactive)}
    >
      <NavRowContent icon={icon} label={label} count={badge} />
    </NavLink>
  );
}

function SideIcon({
  to,
  icon,
  label,
  inactive,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  inactive?: boolean;
  /** A count badge on the icon's corner (hidden at 0). */
  badge?: { app: string; n: number };
}) {
  const name = rowName(label, badge);
  return (
    <NavLink
      to={to}
      title={name}
      aria-label={name}
      className={({ isActive }) => railIconClass(isActive && !inactive)}
    >
      <NavRowContent icon={icon} label={label} count={badge} rail />
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
        className={chatRowClass(isActive)}
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
          <ChatRowContent chat={conv} />
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
      .sort(byPinnedThenRecent);
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
      <div className={FOLDER_ROW_CLASS}>
        <button
          type="button"
          onClick={() => toggle(folder.id)}
          className={FOLDER_TOGGLE_CLASS}
          aria-expanded={expanded}
          title={expanded ? "Collapse folder" : "Expand folder"}
        >
          <FolderToggleContent name={folder.name} count={folder.chat_count ?? folderChats.length} expanded={expanded} />
        </button>

        {/* Always-visible + (core action) */}
        <button
          type="button"
          onClick={newChatInFolder}
          className={FOLDER_ACTION_CLASS}
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
        <div className={FOLDER_CHATS_CLASS}>
          {folderChats.length === 0 && folderQuery.isLoading ? (
            <div className={FOLDER_NOTE_CLASS}>Loading…</div>
          ) : folderChats.length === 0 ? (
            <button
              type="button"
              onClick={newChatInFolder}
              className={SMALL_ACTION_ROW_CLASS}
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

/** The Passwords page asked, from this tab, in the last minute, to sign out
 *  (passwords/ui/PromptlyNav.tsx). Used once. */
function takeSignOutRequest(): boolean {
  try {
    const at = Number(sessionStorage.getItem("promptly:sign-out"));
    sessionStorage.removeItem("promptly:sign-out");
    return at > 0 && Date.now() - at < 60_000;
  } catch {
    return false;
  }
}

function UserFooter({ onNewFolder }: { onNewFolder: () => void }) {
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

  // The Passwords page draws its own copy of this sidebar (it can't run this
  // app's code), so its inbox, invites, feedback, New folder and Log out link
  // here with ``?sidebar=…`` and this footer does it on arrival. Log out also needs the
  // note that page leaves in this tab, so a link from elsewhere can't sign
  // anyone out.
  const [params, setParams] = useSearchParams();
  const newFolderRef = useRef(onNewFolder);
  newFolderRef.current = onNewFolder;
  useEffect(() => {
    const what = params.get("sidebar");
    if (!what) return;
    const next = new URLSearchParams(params);
    next.delete("sidebar");
    setParams(next, { replace: true });
    if (what === "inbox") setInboxOpen(true);
    else if (what === "invites") setInvitesOpen(true);
    else if (what === "feedback") setFeedbackOpen(true);
    else if (what === "newfolder") newFolderRef.current();
    else if (what === "signout" && takeSignOutRequest()) void logout();
  }, [params, setParams]);

  const itemClass = ACCOUNT_MENU_ITEM_CLASS;
  const iconClass = ACCOUNT_MENU_ICON_CLASS;

  return (
    <div className={FOOTER_CLASS}>
      <InstallAppButton />
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          className={ACCOUNT_MENU_CLASS}
        >
          <button role="menuitem" className={itemClass} onClick={() => go("/account")}>
            <ShieldCheck className={iconClass} />
            Account
          </button>
          {isAdmin && (
            <button role="menuitem" className={itemClass} onClick={() => go("/admin")}>
              <Settings className={iconClass} />
              Admin
            </button>
          )}
          <button role="menuitem" className={itemClass} onClick={() => go("/archive")}>
            <Archive className={iconClass} />
            Archived chats
          </button>
          <button role="menuitem" className={itemClass} onClick={() => go("/trash")}>
            <Trash2 className={iconClass} />
            Trash
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
              <Inbox className={iconClass} />
              Workspace invites
              <InviteCount count={inviteCount} />
            </button>
          )}
          <button role="menuitem" className={itemClass} onClick={() => go("/account/privacy")}>
            <EyeOff className={iconClass} />
            What your admin can see
          </button>
          <button
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setMenuOpen(false);
              setFeedbackOpen(true);
            }}
          >
            <MessageSquare className={iconClass} />
            Send feedback
          </button>
          <div className={THEME_ROW_CLASS}>
            <span className="text-sm text-[var(--text)]">Theme</span>
            <ThemeToggle />
          </div>
          <button role="menuitem" className={itemClass} onClick={onLogout}>
            <LogOut className={iconClass} />
            Log out
          </button>
          <AppVersionLine />
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
          className={ACCOUNT_BUTTON_CLASS}
        >
          <AccountButtonContent user={user} isAdmin={isAdmin} inviteCount={inviteCount} open={menuOpen} />
        </button>
        <button
          onClick={() => setInboxOpen(true)}
          className={INBOX_BUTTON_CLASS}
          title="Notifications"
          aria-label="Open notification inbox"
        >
          <InboxButtonContent unread={unreadCount} />
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
