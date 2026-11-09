// Promptly's sidebar, drawn by the vault page itself. The vault is its own
// document with a stricter CSP and none of the main app's stores, API client
// or router (security isolation), so it can't mount the main sidebar
// (components/layout/Sidebar.tsx). It draws the same one from the same parts
// instead: the page list, pinned apps and their icons (navItems.ts,
// items/builtInApps.ts, items/itemIcons.ts) and every row, header and footer
// piece (sidebarParts.tsx), fed by the same APIs with the vault page's own
// sign-in. Only the wiring differs: every entry is a plain same-origin link
// (leaving the page ends the vault's session in this tab, as any navigation
// away does), and what only the main app can do (search, the inbox, invites,
// feedback, a new folder, signing out) is a link that asks the main app to
// do it on arrival (AppLayout, Sidebar).
//
// Expanded unless the person collapsed the main sidebar (the same account
// setting, so collapsing here collapses it everywhere); on a phone, the main
// app's slide-in drawer. Only web builds import this file (main.tsx), and
// only when the vault is opened inside Promptly: never in the installed
// Passwords app, the extension or the desktop app.
import { Archive, FolderPlus, Inbox, LogOut, MessageSquare, MessageSquarePlus, Monitor, Moon, Plus, Settings, ShieldCheck, Sun, Trash2, ChevronDown, Clock, Ghost, type LucideIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CONVERSATION_PAGE_SIZE as PAGE, conversationCursor } from "../../api/chatPaging";
import type { ConversationSummary } from "../../api/types";
import { RAIL_MORE_ITEMS, visibleNavItems } from "../../components/layout/navItems";
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
} from "../../components/layout/sidebarParts";
import { BUILT_IN_APPS, type NavApp } from "../../items/builtInApps";
import { itemIcon } from "../../items/itemIcons";
import { BUCKET_ORDER, groupByBucket } from "../../utils/dateGroups";
import { cn } from "../../utils/cn";
import { PromptlyMenuButton, PromptlyNavContext } from "./PromptlyMenu";

type Auth = () => string | null | Promise<string | null>;

type Me = {
  id?: string;
  username?: string;
  email?: string | null;
  role?: string;
  avatar_url?: string | null;
  avatar_color?: string | null;
  can_use_automations?: boolean;
  settings?: {
    hidden_nav?: string[];
    enabled_nav?: string[];
    nav_apps?: string[];
    nav_app_icons?: "line" | "color";
    sidebar_collapsed?: boolean;
  };
};

type Chat = ConversationSummary;
type ChatFolder = { id: string; name: string; chat_count?: number };

/** A page or pinned app, as a link. */
type Entry = { href: string; label: string; icon: ReactNode };

/** The page this sidebar sits on: its pinned-app row shows as current. */
const HERE = "/passwords";

/** Phones get the slide-in drawer (Tailwind's ``md``, as the vault's own layout). */
const PHONE = "(max-width: 767px)";

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const on = (e: MediaQueryListEvent) => setPhone(e.matches);
    setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

// ---- Things the main app keeps in this browser (same origin) ----

/** Folders the person opened in the sidebar (store/folderUiStore.ts, zustand persist). */
const FOLDERS_KEY = "promptly.chat-folders-ui";

function readExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    const v = raw ? (JSON.parse(raw) as { state?: { expanded?: Record<string, boolean> } }) : null;
    return v?.state?.expanded ?? {};
  } catch {
    return {};
  }
}

function writeExpanded(expanded: Record<string, boolean>): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify({ state: { expanded }, version: 0 }));
  } catch {
    /* storage blocked: only this page forgets */
  }
}

type Theme = "light" | "dark" | "system";
/** The colour theme (store/themeStore.ts, zustand persist). Until one is
 *  chosen this page follows the system (main.tsx), so that's what shows. */
const THEME_KEY = "promptly.theme";

function readTheme(): Theme {
  try {
    const t = (JSON.parse(localStorage.getItem(THEME_KEY) ?? "null") as { state?: { theme?: Theme } } | null)?.state?.theme;
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify({ state: { theme }, version: 0 }));
  } catch {
    /* storage blocked: this page only */
  }
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Signing out runs in the main app (it also stops this device's
 *  notifications and clears the person's data from the browser). This tab
 *  asks for it, so a link from anywhere else can't sign anyone out
 *  (Sidebar.tsx takeSignOutRequest). */
const SIGN_OUT_KEY = "promptly:sign-out";

function signOut(): void {
  try {
    sessionStorage.setItem(SIGN_OUT_KEY, String(Date.now()));
  } catch {
    /* no storage: the main app won't act on the link */
  }
  location.href = "/chat?sidebar=signout";
}

// ---- Data ----

function useApi(auth: Auth) {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const token = await auth();
      if (!token) throw new Error("signed out");
      const r = await fetch(`/api${path}`, {
        ...init,
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as T;
    },
    [auth],
  );
}

type Api = ReturnType<typeof useApi>;

const chatsPath = (folder: string, after?: Chat) =>
  `/chat/conversations?limit=${PAGE}&scope=personal&folder=${encodeURIComponent(folder)}${after ? `&cursor=${encodeURIComponent(conversationCursor(after))}` : ""}`;

/** Everything the sidebar shows, read once when the page opens. Until it
 *  arrives (or if it can't), the usual pages show. */
function usePromptlySidebar(auth: Auth, isPhone: boolean) {
  const api = useApi(auth);
  const [me, setMe] = useState<Me | null>(null);
  const [launcher, setLauncher] = useState<{ kind: string; name: string; icon?: string | null }[]>([]);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsState, setChatsState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unread, setUnread] = useState(0);
  const [invites, setInvites] = useState(0);

  useEffect(() => {
    let live = true;
    const quietly = <T,>(p: Promise<T>, then: (v: T) => void) =>
      p.then((v) => live && then(v)).catch(() => {
        /* that part stays empty */
      });
    quietly(api<Me>("/auth/me"), (user) => {
      setMe(user);
      if ((user.settings?.nav_apps ?? []).some((id) => !BUILT_IN_APPS.some((a) => a.id === id))) {
        quietly(api<{ apps?: { kind: string; name: string; icon?: string | null }[] }>("/items/launcher"), (body) => setLauncher(body.apps ?? []));
      }
    });
    api<Chat[]>(chatsPath("none"))
      .then((page) => {
        if (!live) return;
        setChats(page);
        setMore(page.length >= PAGE);
        setChatsState("ready");
      })
      .catch(() => live && setChatsState("error"));
    quietly(api<ChatFolder[]>("/chat/folders"), setFolders);
    quietly(api<{ unread_count?: number }>("/notifications/inbox?limit=1"), (b) => setUnread(b.unread_count ?? 0));
    quietly(api<unknown[]>("/workspace-share-invites"), (rows) => setInvites(Array.isArray(rows) ? rows.length : 0));
    return () => {
      live = false;
    };
  }, [api]);

  const loadMore = useCallback(async () => {
    const last = chats[chats.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<Chat[]>(chatsPath("none", last));
      setChats((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.filter((c) => !seen.has(c.id))];
      });
      setMore(page.length >= PAGE);
    } catch {
      /* the button stays for another try */
    } finally {
      setLoadingMore(false);
    }
  }, [api, chats, loadingMore]);

  /** Collapse or expand: the same account setting the main sidebar saves. */
  const setCollapsed = useCallback(
    (next: boolean) => {
      const patch = (v: boolean) => setMe((m) => (m ? { ...m, settings: { ...m.settings, sidebar_collapsed: v } } : m));
      patch(next);
      api<Me>("/auth/me/preferences", { method: "PATCH", body: JSON.stringify({ sidebar_collapsed: next }) }).catch(() => patch(!next));
    },
    [api],
  );

  const settings = me?.settings;
  const isAdmin = me?.role === "admin";
  // The main sidebar's own choice of pages (useCanUseAutomations: admins, or
  // people allowed automations).
  const pages = visibleNavItems({
    hidden: settings?.hidden_nav,
    enabled: settings?.enabled_nav,
    isAdmin,
    canAutomate: isAdmin || me?.can_use_automations === true,
    isMobile: isPhone,
  });
  // Pinned apps, resolved as items/navApps.ts useNavApps does.
  const apps = useMemo(() => {
    const all = new Map<string, NavApp>(BUILT_IN_APPS.map((a) => [a.id, a]));
    for (const a of launcher) all.set(a.kind, { id: a.kind, name: a.name, icon: `/item-icons/${a.kind}-192.png`, glyph: itemIcon(a.icon), to: `/apps/${a.kind}` });
    return (settings?.nav_apps ?? []).map((id) => all.get(id)).filter((a): a is NavApp => Boolean(a));
  }, [settings?.nav_apps, launcher]);

  return {
    api,
    me,
    pages,
    apps,
    iconStyle: settings?.nav_app_icons ?? "line",
    isAdmin,
    collapsed: settings?.sidebar_collapsed === true,
    setCollapsed,
    folders,
    chats,
    chatsState,
    more,
    loadingMore,
    loadMore,
    unread,
    invites,
  };
}

type SidebarData = ReturnType<typeof usePromptlySidebar>;

// ---- The frame ----

/** The vault page inside Promptly: Promptly's sidebar beside the vault. */
export function PromptlyFrame({ auth, children }: { auth: Auth; children: ReactNode }) {
  const isPhone = useIsPhone();
  const data = usePromptlySidebar(auth, isPhone);
  const [drawer, setDrawer] = useState(false);
  // The vault's phone header shows the menu button when it's on screen;
  // otherwise (unlock, setup) it floats in the corner.
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const open = useCallback(() => setDrawer(true), []);
  const close = useCallback(() => setDrawer(false), []);
  const controls = useMemo(() => ({ open, claim }), [open, claim]);
  // Back to a big screen: the drawer isn't there to close.
  useEffect(() => {
    if (!isPhone) setDrawer(false);
  }, [isPhone]);

  return (
    <PromptlyNavContext.Provider value={controls}>
      <div className="flex h-[100dvh] overflow-hidden">
        {!isPhone && (
          <div className="h-full shrink-0">
            <PromptlySidebar data={data} collapsed={data.collapsed} onToggle={() => data.setCollapsed(!data.collapsed)} />
          </div>
        )}
        <div className="h-full min-w-0 flex-1 overflow-y-auto">{children}</div>
      </div>
      {isPhone && claims === 0 && (
        <div className="fixed left-2 z-30" style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}>
          <PromptlyMenuButton onClick={open} floating />
        </div>
      )}
      {isPhone && <Drawer data={data} open={drawer} onClose={close} />}
    </PromptlyNavContext.Provider>
  );
}

/** Phones: the main app's slide-in menu (AppLayout), holding the whole
 *  sidebar. Inert while it's closed, so its links aren't in the tab order. */
function Drawer({ data, open, onClose }: { data: SidebarData; open: boolean; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (open) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
    if (!open) return;
    el.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal
        aria-label="Navigation menu"
        aria-hidden={!open}
        className={cn("fixed inset-y-0 left-0 z-50 shadow-xl transition-transform duration-200 ease-out", open ? "translate-x-0" : "-translate-x-full")}
      >
        <PromptlySidebar data={data} collapsed={false} onToggle={onClose} />
      </div>
    </>
  );
}

// ---- The sidebar (Sidebar.tsx) ----

function PromptlySidebar({ data, collapsed, onToggle }: { data: SidebarData; collapsed: boolean; onToggle: () => void }) {
  const icon = (Icon: LucideIcon) => <Icon className="h-4 w-4" />;
  const pages: Entry[] = data.pages.map((p) => ({ href: p.to, label: p.label, icon: icon(p.icon) }));
  const apps: Entry[] = data.apps.map((a) => ({ href: a.to, label: a.name, icon: <AppIcon app={a} style={data.iconStyle} /> }));

  if (collapsed) {
    const more: Entry[] = RAIL_MORE_ITEMS.filter((it) => !it.adminOnly || data.isAdmin).map((it) => ({ href: it.to, label: it.label, icon: icon(it.icon) }));
    return (
      <aside aria-label="Promptly" className={RAIL_CLASS}>
        <ExpandSidebarButton onToggle={onToggle} />
        <div className="mb-3">
          <NewChat compact />
        </div>
        <nav aria-label="Promptly" className="flex flex-col items-center gap-1">
          {[...pages, ...apps, ...more].map((l) => (
            <a
              key={l.href}
              href={l.href}
              title={l.label}
              aria-label={l.label}
              aria-current={l.href === HERE ? "page" : undefined}
              className={railIconClass(l.href === HERE)}
            >
              {l.icon}
            </a>
          ))}
        </nav>
      </aside>
    );
  }

  return (
    <aside aria-label="Promptly" className={SIDEBAR_CLASS}>
      <SidebarHeader onToggle={onToggle} />

      <div className="px-3">
        <NewChat />
        {/* Promptly's search runs in the main app: this opens it there. Its
            Ctrl K isn't shown here, since on this page Ctrl K searches the vault. */}
        <a href="/chat?search=1" className={SEARCH_BOX_CLASS}>
          <SearchBoxContent shortcut={false} />
        </a>
      </div>

      <nav aria-label="Promptly" className="mt-4 flex flex-col gap-0.5 px-2">
        {[...pages, ...apps].map((l) => (
          <a key={l.href} href={l.href} aria-current={l.href === HERE ? "page" : undefined} className={navRowClass(l.href === HERE)}>
            <NavRowContent icon={l.icon} label={l.label} />
          </a>
        ))}
      </nav>

      <ChatList data={data} />
      <UserFooter data={data} />
    </aside>
  );
}

/** Split button: a new chat, or (from the caret) a temporary one
 *  (NewChatButton.tsx, which navigates with the main app's router). */
function NewChat({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const caret = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className={
        compact
          ? "inline-flex h-4 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          : "inline-flex w-9 items-center justify-center border-l border-white/20 bg-[var(--accent)] text-white transition hover:opacity-90"
      }
      aria-label="More chat types"
      aria-expanded={open}
      title="More chat types"
    >
      <ChevronDown className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4", "transition-transform", open && "rotate-180")} />
    </button>
  );

  return (
    <div ref={ref} className="relative">
      {compact ? (
        <div className="flex flex-col items-center gap-0.5">
          <a
            href="/chat"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-white hover:opacity-90"
            aria-label="New chat"
            title="New chat"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </a>
          {caret}
        </div>
      ) : (
        <div className="flex w-full items-stretch gap-px overflow-hidden rounded-input">
          <a
            href="/chat"
            className="flex flex-1 items-center justify-center gap-2 bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New chat
          </a>
          {caret}
        </div>
      )}
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-30 w-64 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-lg",
            compact ? "left-full top-0 ml-3" : "left-0 mt-2",
          )}
        >
          <MenuLink href="/chat?temporary=ephemeral" icon={<Ghost className="h-4 w-4" />} title="Temporary chat" subtitle="Disappears when you leave." />
          <div className="border-t border-[var(--border)]" />
          <MenuLink
            href="/chat?temporary=one_hour"
            icon={<Clock className="h-4 w-4" />}
            title="Temporary (1 hour)"
            subtitle="Auto-deletes 1h after your last message."
          />
        </div>
      )}
    </div>
  );
}

function MenuLink({ href, icon, title, subtitle }: { href: string; icon: ReactNode; title: string; subtitle: string }) {
  return (
    <a href={href} role="menuitem" className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-[var(--hover)]">
      <span className="mt-0.5 text-[var(--accent-text)]">{icon}</span>
      <span className="flex flex-col">
        <span className="text-sm font-medium text-[var(--text)]">{title}</span>
        <span className="text-xs text-[var(--text-muted)]">{subtitle}</span>
      </span>
    </a>
  );
}

/** Folders, Pinned, then the date groups, as the main sidebar lists them. */
function ChatList({ data }: { data: SidebarData }) {
  const [expanded, setExpanded] = useState(readExpanded);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = { ...readExpanded(), ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      writeExpanded(next);
      return next;
    });

  // Workspace chats live in their workspace; archived ones on the Archive page.
  const personal = useMemo(() => data.chats.filter((c) => !c.workspace_id && !c.archived_at && !c.folder_id), [data.chats]);
  const pinned = personal.filter((c) => c.pinned);
  const groups = useMemo(() => groupByBucket(personal.filter((c) => !c.pinned)), [personal]);

  return (
    <div className={CHAT_LIST_CLASS}>
      <div className="mb-1 mt-1 flex items-center justify-between gap-1 px-2">
        <FoldersLabel />
        <a href="/chat?sidebar=newfolder" className={FOLDER_ACTION_CLASS} title="New folder" aria-label="New folder">
          <FolderPlus className="h-3.5 w-3.5" />
        </a>
      </div>
      {data.folders.length === 0 ? (
        <a href="/chat?sidebar=newfolder" className={cn("mb-1", SMALL_ACTION_ROW_CLASS)}>
          <FolderPlus className="h-3.5 w-3.5" /> New folder
        </a>
      ) : (
        data.folders.map((f) => <FolderRow key={f.id} folder={f} api={data.api} expanded={!!expanded[f.id]} onToggle={() => toggle(f.id)} />)
      )}

      {pinned.length > 0 && <PinnedHeader />}
      {pinned.map((c) => (
        <ChatRow key={c.id} chat={c} />
      ))}

      {BUCKET_ORDER.map((b) => {
        const items = groups.get(b);
        if (!items?.length) return null;
        return (
          <div key={b} className="mt-2">
            <SectionHeader>{b}</SectionHeader>
            {items.map((c) => (
              <ChatRow key={c.id} chat={c} />
            ))}
          </div>
        );
      })}

      {data.more && <LoadMoreChats loading={data.loadingMore} onLoad={() => void data.loadMore()} />}

      {data.chatsState === "loading" && <ChatListSkeleton />}
      {data.chatsState === "error" && <ChatListNote>Couldn't load your chats. They're all there in Promptly.</ChatListNote>}
      {data.chatsState === "ready" && personal.length === 0 && data.folders.length === 0 && <ChatListNote>{NO_CHATS_TEXT}</ChatListNote>}
    </div>
  );
}

function ChatRow({ chat }: { chat: Chat }) {
  return (
    <a href={`/chat/${chat.id}`} className={chatRowClass(false)}>
      <ChatRowContent chat={chat} />
    </a>
  );
}

/** A chat folder: closed until opened, its chats loaded when it is. */
function FolderRow({ folder, api, expanded, onToggle }: { folder: ChatFolder; api: Api; expanded: boolean; onToggle: () => void }) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loaded = chats !== null;
  useEffect(() => {
    if (!expanded || loaded) return;
    let live = true;
    api<Chat[]>(chatsPath(folder.id))
      .then((page) => {
        if (!live) return;
        setChats(page);
        setMore(page.length >= PAGE);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, expanded, loaded, folder.id]);

  const loadMore = async () => {
    const last = chats?.[chats.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<Chat[]>(chatsPath(folder.id, last));
      setChats((prev) => [...(prev ?? []), ...page.filter((c) => !(prev ?? []).some((p) => p.id === c.id))]);
      setMore(page.length >= PAGE);
    } catch {
      /* the button stays for another try */
    } finally {
      setLoadingMore(false);
    }
  };

  const list = (chats ?? []).filter((c) => !c.archived_at).sort(byPinnedThenRecent);
  const newHere = `/chat?folder=${encodeURIComponent(folder.id)}`;
  return (
    <div className="mb-0.5">
      <div className={FOLDER_ROW_CLASS}>
        <button type="button" onClick={onToggle} className={FOLDER_TOGGLE_CLASS} aria-expanded={expanded} title={expanded ? "Collapse folder" : "Expand folder"}>
          <FolderToggleContent name={folder.name} count={folder.chat_count ?? list.length} expanded={expanded} />
        </button>
        <a href={newHere} className={FOLDER_ACTION_CLASS} title="New chat in this folder" aria-label="New chat in this folder">
          <Plus className="h-3.5 w-3.5" />
        </a>
      </div>
      {expanded && (
        <div className={FOLDER_CHATS_CLASS}>
          {!loaded && !failed ? (
            <div className={FOLDER_NOTE_CLASS}>Loading…</div>
          ) : failed ? (
            <div className={FOLDER_NOTE_CLASS}>Couldn't load this folder.</div>
          ) : list.length === 0 ? (
            <a href={newHere} className={SMALL_ACTION_ROW_CLASS}>
              <Plus className="h-3 w-3" /> New chat
            </a>
          ) : (
            list.map((c) => <ChatRow key={c.id} chat={c} />)
          )}
          {more && <LoadMoreChats loading={loadingMore} onLoad={() => void loadMore()} />}
        </div>
      )}
    </div>
  );
}

// ---- The footer: you, your account menu, the inbox ----

function UserFooter({ data }: { data: SidebarData }) {
  const { me, isAdmin, invites, unread } = data;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // This menu, not the phone drawer around it.
        e.preventDefault();
        setOpen(false);
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
  }, [open]);

  const item = ACCOUNT_MENU_ITEM_CLASS;
  const muted = ACCOUNT_MENU_ICON_CLASS;
  return (
    <div className={FOOTER_CLASS}>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Account" className={ACCOUNT_MENU_CLASS}>
          <a role="menuitem" className={item} href="/account">
            <ShieldCheck className={muted} />
            Account
          </a>
          {isAdmin && (
            <a role="menuitem" className={item} href="/admin">
              <Settings className={muted} />
              Admin
            </a>
          )}
          <a role="menuitem" className={item} href="/archive">
            <Archive className={muted} />
            Archived chats
          </a>
          <a role="menuitem" className={item} href="/trash">
            <Trash2 className={muted} />
            Trash
          </a>
          {invites > 0 && (
            <a role="menuitem" className={item} href="/chat?sidebar=invites">
              <Inbox className={muted} />
              Workspace invites
              <InviteCount count={invites} />
            </a>
          )}
          <a role="menuitem" className={item} href="/chat?sidebar=feedback">
            <MessageSquare className={muted} />
            Send feedback
          </a>
          <div role="group" aria-labelledby="promptly-theme-label" className={THEME_ROW_CLASS}>
            <span id="promptly-theme-label" className="text-sm text-[var(--text)]">
              Theme
            </span>
            <ThemeToggle />
          </div>
          <button type="button" role="menuitem" className={item} onClick={signOut}>
            <LogOut className={muted} />
            Log out
          </button>
          <AppVersionLine />
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className={ACCOUNT_BUTTON_CLASS}
        >
          <AccountButtonContent user={me} isAdmin={isAdmin} inviteCount={invites} open={open} fallbackName="" />
        </button>
        <a href="/chat?sidebar=inbox" className={INBOX_BUTTON_CLASS} title="Notifications" aria-label="Open notification inbox">
          <InboxButtonContent unread={unread} />
        </a>
      </div>
    </div>
  );
}

const THEMES: { value: Theme; icon: LucideIcon; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
];

/** Light, dark or the system's, shared with the main app (ThemeToggle.tsx,
 *  whose store this page can't run). Inside the account menu, so its choices
 *  are menu radio items. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <div className="inline-flex items-center gap-0.5 rounded-input border border-[var(--border)] p-0.5">
      {THEMES.map((o) => {
        const Icon = o.icon;
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => {
              setTheme(o.value);
              saveTheme(o.value);
            }}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-full transition",
              active ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
