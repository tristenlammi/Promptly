// The pieces of Promptly's sidebar that both drawings of it share: the main
// sidebar (Sidebar.tsx) and the Passwords page's own copy
// (passwords/ui/PromptlyNav.tsx). That page runs none of the main app's
// stores, API client or router, so everything here is presentation only:
// props in, markup out. Keep it that way (passwords/tests/bundle-check.mjs
// fails if the vault page reaches the main app's code).
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Search,
  Star,
} from "lucide-react";

import { Skeleton } from "@/components/shared/Skeleton";
import { UserAvatar } from "@/components/shared/UserAvatar";
import type { NavApp } from "@/items/builtInApps";
import { badgeLabel } from "@/lib/countBadge";
import { cn } from "@/utils/cn";

import { CountBadge } from "./CountBadge";

// ---- The frame ----

/** The expanded sidebar's column. */
export const SIDEBAR_CLASS = "flex h-full w-72 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]";
/** The collapsed sidebar's icon rail. */
export const RAIL_CLASS = "flex h-full w-14 shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--surface)] py-3";

/** Promptly's mark and name, with the button that collapses the sidebar. */
export function SidebarHeader({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 pb-3 pt-4">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent-strong)] text-white">
          <span className="text-sm font-bold">P</span>
        </div>
        <span className="text-sm font-semibold tracking-tight">Promptly</span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        aria-label="Collapse sidebar"
        title="Collapse sidebar"
      >
        <PanelLeftClose className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The collapsed rail's first button. */
export function ExpandSidebarButton({ onToggle }: { onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
      aria-label="Expand sidebar"
      title="Expand sidebar"
    >
      <PanelLeftOpen className="h-4 w-4" />
    </button>
  );
}

/** The search box under New chat (a button, or a link on the Passwords page). */
export const SEARCH_BOX_CLASS =
  "mt-2 flex h-8 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--hover)] px-2.5 text-left text-xs text-[var(--text-muted)] transition hover:text-[var(--text)]";

export function SearchBoxContent({ shortcut = true }: { shortcut?: boolean }) {
  return (
    <>
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search</span>
      {shortcut && <kbd className="hidden shrink-0 font-sans text-[10px] opacity-70 md:inline">Ctrl K</kbd>}
    </>
  );
}

// ---- Page and app rows ----

const ROW_IDLE = "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]";
const ROW_CURRENT = "bg-[var(--accent)]/10 text-[var(--text)]";

/** A page or pinned app in the expanded sidebar. */
export function navRowClass(current: boolean): string {
  return cn("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition", current ? `${ROW_CURRENT} font-medium` : ROW_IDLE);
}

/** A page or pinned app in the collapsed rail (``relative`` for its count). */
export function railIconClass(current: boolean): string {
  return cn("relative inline-flex h-9 w-9 items-center justify-center rounded-md transition", current ? ROW_CURRENT : ROW_IDLE);
}

/** A row's count badge: which app's words, and the number (0 shows none). */
export type RowCount = { app: string; n: number };

/** What's inside a page or app row: its icon and name, and its count badge
 *  (Tasks due, unread Mail and Rooms, new on Porch) at the end of the row.
 *  In the collapsed ``rail`` only the icon shows, with the count on its
 *  corner; give the link ``rowName`` as its label there. */
export function NavRowContent({ icon, label, count, rail = false }: { icon: ReactNode; label: string; count?: RowCount; rail?: boolean }) {
  if (rail) {
    return (
      <>
        {icon}
        {count && <CountBadge app={count.app} n={count.n} corner />}
      </>
    );
  }
  return (
    <>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {count && <CountBadge app={count.app} n={count.n} />}
    </>
  );
}

/** A rail icon's name: "Rooms", or "Rooms, 3 unread" with a count. */
export function rowName(label: string, count?: RowCount): string {
  const said = count ? badgeLabel(count.app, count.n) : "";
  return said ? `${label}, ${said}` : label;
}

/** A pinned app's icon: a line icon like the rest of the sidebar, or, if the
 *  person chose colour, the app's own icon shrunk to fit. */
export function AppIcon({ app, style }: { app: Pick<NavApp, "icon" | "glyph">; style: "line" | "color" }) {
  if (style === "color") return <img src={app.icon} alt="" className="h-4 w-4 rounded-[4px]" draggable={false} />;
  const Glyph = app.glyph;
  return <Glyph className="h-4 w-4" />;
}

// ---- The chat list ----

/** The scrolling part under the pages: folders, pinned and dated chats. */
export const CHAT_LIST_CLASS = "promptly-scroll mt-3 flex-1 overflow-y-auto px-2 pb-2";

export function FoldersLabel() {
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      <Folder className="h-3 w-3" /> Folders
    </span>
  );
}

export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 mt-3 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-text)]">
      {children}
    </div>
  );
}

export function PinnedHeader() {
  return (
    <SectionHeader>
      <Pin className="h-3 w-3 fill-current" /> Pinned
    </SectionHeader>
  );
}

export const NO_CHATS_TEXT = "No personal chats yet. Start a new chat or open a workspace.";

export function ChatListNote({ children }: { children: ReactNode }) {
  return <div className="mt-6 px-2 text-xs text-[var(--text-muted)]">{children}</div>;
}

/** A chat row (``group`` so hover actions can show on it). */
export function chatRowClass(current: boolean): string {
  return cn(
    "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition",
    current ? "bg-[var(--hover-strong)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
  );
}

type ChatRowFields = {
  title: string | null;
  starred?: boolean;
  pinned?: boolean;
  temporary_mode?: string | null;
  expires_at?: string | null;
};

/** A chat row's marks and title. */
export function ChatRowContent({ chat }: { chat: ChatRowFields }) {
  return (
    <>
      {chat.starred && <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500" />}
      {/* Persistent pinned indicator in the accent colour; it survives the
          current-row highlight. The temporary-chat badge takes precedence so
          two leading glyphs never stack. */}
      {chat.pinned && chat.temporary_mode !== "one_hour" && <Pin className="h-3 w-3 shrink-0 fill-current text-[var(--accent-text)]" />}
      {chat.temporary_mode === "one_hour" && <TemporaryCountdownBadge expiresAt={chat.expires_at ?? null} />}
      <span className="truncate">{chat.title?.trim() || "New chat"}</span>
    </>
  );
}

/**
 * Phase Z1: the clock pill beside a 1-hour temporary chat's title. Re-renders
 * every 30 s, so the countdown drifts by at most that much.
 */
export function TemporaryCountdownBadge({ expiresAt }: { expiresAt: string | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (!expiresAt) {
    return <Clock className="h-3 w-3 shrink-0 text-[var(--text-muted)]" aria-label="Temporary chat" />;
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
        // Informational, not a warning: temporary chats are a feature the
        // user chose, and amber read as "something's wrong".
        "bg-[var(--hover-strong)] text-[var(--text-muted)]",
      )}
      title={`Temporary chat — auto-deletes in ${label}`}
    >
      <Clock className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

/** Loads the next page of chats when it scrolls into view: older chats used
 *  to be unreachable past the first 50 (R-047). Also a plain button, for
 *  keyboards and for when the observer can't fire. */
export function LoadMoreChats({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
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

/** Placeholder list while the first chats load: a couple of date groups, so
 *  the sidebar doesn't flash empty. */
export function ChatListSkeleton() {
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

// ---- Folders ----

export const FOLDER_ROW_CLASS = "group relative flex items-center gap-1 rounded-md px-1.5 py-1.5 text-sm text-[var(--text)] transition hover:bg-[var(--hover)]";
export const FOLDER_TOGGLE_CLASS = "flex min-w-0 flex-1 items-center gap-1.5 text-left";
/** The small square buttons on a folder row (+, ⋯) and the Folders heading. */
export const FOLDER_ACTION_CLASS =
  "inline-flex shrink-0 items-center justify-center rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--text)]";
/** An open folder's chats, indented under it. */
export const FOLDER_CHATS_CLASS = "ml-3 border-l border-[var(--border)] pl-1.5";
/** "Loading…" and the like inside an open folder. */
export const FOLDER_NOTE_CLASS = "px-2 py-1.5 text-xs text-[var(--text-muted)]";
/** The small "New chat" / "New folder" rows. */
export const SMALL_ACTION_ROW_CLASS =
  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]";

/** What's inside a folder's open/close button. ``count`` is the server's
 *  count: the loaded chats are only a page. */
export function FolderToggleContent({ name, count, expanded }: { name: string; count: number; expanded: boolean }) {
  return (
    <>
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      )}
      <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
      <span className="truncate font-medium">{name}</span>
      {count > 0 && <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{count}</span>}
    </>
  );
}

/** A folder's chats, newest first with pinned ones on top. */
export function byPinnedThenRecent(a: { pinned?: boolean; updated_at: string }, b: { pinned?: boolean; updated_at: string }): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return b.updated_at.localeCompare(a.updated_at);
}

// ---- The footer ----

export const FOOTER_CLASS = "relative border-t border-[var(--border)] p-3 pb-safe";
export const ACCOUNT_MENU_CLASS =
  "absolute bottom-full left-3 right-3 z-30 mb-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl";
export const ACCOUNT_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text)] transition hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none";
export const ACCOUNT_MENU_ICON_CLASS = "h-4 w-4 text-[var(--text-muted)]";
export const ACCOUNT_BUTTON_CLASS =
  "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition hover:bg-[var(--hover)]";
export const INBOX_BUTTON_CLASS =
  "relative inline-flex shrink-0 items-center justify-center rounded-md p-2 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]";
/** The theme row inside the account menu. */
export const THEME_ROW_CLASS = "my-1 flex items-center justify-between border-y border-[var(--border)] px-2 py-1.5";

const COUNT_PILL = "inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent-strong)] px-1 text-[10px] font-semibold text-white";

/** The account menu's "Workspace invites" count. */
export function InviteCount({ count }: { count: number }) {
  return <span className={cn("ml-auto", COUNT_PILL)}>{count}</span>;
}

type FooterUser = {
  id?: string;
  username?: string;
  email?: string | null;
  avatar_url?: string | null;
  avatar_color?: string | null;
};

/** You, in the footer: avatar, name, email, and the menu's caret. */
export function AccountButtonContent({
  user,
  isAdmin,
  inviteCount,
  open,
  fallbackName = "Guest",
}: {
  user: FooterUser | null | undefined;
  isAdmin: boolean;
  inviteCount: number;
  open: boolean;
  /** Shown before the person's details arrive. */
  fallbackName?: string;
}) {
  return (
    <>
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
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--accent-strong)] ring-2 ring-[var(--bg)]"
            title={`${inviteCount} pending workspace invite${inviteCount === 1 ? "" : "s"}`}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{user?.username ?? fallbackName}</span>
          {isAdmin && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-text)] ring-1 ring-[var(--accent)]/40"
              title="Administrator"
            >
              Admin
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{user?.email ?? ""}</span>
      </span>
      <ChevronUp className={cn("h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform", !open && "rotate-180")} />
    </>
  );
}

/** The notification bell and its unread count. */
export function InboxButtonContent({ unread }: { unread: number }) {
  return (
    <>
      <Bell className="h-4 w-4" />
      {unread > 0 && <span className={cn("absolute -right-0.5 -top-0.5", COUNT_PILL)}>{unread}</span>}
    </>
  );
}

/** The last line of the account menu. */
export function AppVersionLine() {
  return (
    <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-[var(--text-muted)]" title={`Promptly v${__APP_VERSION__}`}>
      Promptly v{__APP_VERSION__}
    </div>
  );
}
