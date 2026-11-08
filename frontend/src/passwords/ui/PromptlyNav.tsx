// Promptly's navigation, drawn by the vault page itself. The vault is its own
// document with a stricter CSP and none of the main app's code (security
// isolation), so it can't mount the main sidebar. When the vault is opened
// inside Promptly (a browser tab, the installed Promptly window) this gives it
// the same way around: a compact rail like the main sidebar's collapsed one on
// a big screen, and the main app's phone menu (a button and a slide-in drawer)
// on a phone. Every entry is a plain same-origin link: leaving the page ends
// the vault's session in this tab, as any navigation away does. Never shown in
// the installed Passwords app, the extension or the desktop app.
import {
  Archive,
  Blocks,
  CalendarDays,
  FolderOpen,
  KeyRound,
  LayoutGrid,
  Mail,
  MapPin,
  Menu,
  MessageCircle,
  MessageSquarePlus,
  Navigation,
  Settings,
  Sun,
  Trash2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

type Link = { href: string; label: string; icon: LucideIcon; img?: string; current?: boolean };

/** What the main sidebar shows (components/layout/navItems.ts NAV_ITEMS). */
const NAV: { href: string; label: string; icon: LucideIcon; optional?: string; automations?: boolean }[] = [
  { href: "/today", label: "Today", icon: Sun, optional: "today" },
  { href: "/places", label: "Places", icon: MapPin, optional: "places" },
  { href: "/workspaces", label: "Workspaces", icon: LayoutGrid, optional: "workspaces" },
  { href: "/tasks", label: "Automations", icon: Workflow, optional: "tasks", automations: true },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/apps", label: "Apps", icon: Blocks },
];

/** Apps built into Promptly that can be pinned (items/navApps.ts BUILT_IN_APPS). */
const BUILT_IN: Record<string, Link> = {
  rooms: { href: "/rooms", label: "Rooms", icon: MessageCircle, img: "/item-icons/rooms-192.png" },
  calendar: { href: "/calendar", label: "Calendar", icon: CalendarDays, img: "/item-icons/calendar-192.png" },
  maps: { href: "/maps", label: "Maps", icon: Navigation, img: "/item-icons/maps-192.png" },
  mail: { href: "/mail", label: "Mail", icon: Mail, img: "/item-icons/mail-192.png" },
  passwords: { href: "/passwords", label: "Passwords", icon: KeyRound, img: "/item-icons/passwords-192.png", current: true },
};

type Me = {
  role?: string;
  can_use_automations?: boolean;
  settings?: { hidden_nav?: string[]; nav_apps?: string[]; nav_app_icons?: string };
};

/** The person's sidebar choices (hidden pages, pinned apps), read with the
 *  vault page's own sign-in. Until they arrive (or if they can't), the usual
 *  pages show. */
function useSidebar(auth: () => string | null | Promise<string | null>) {
  const [me, setMe] = useState<Me | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const token = await auth();
        if (!token) return;
        const headers = { Authorization: `Bearer ${token}` };
        const r = await fetch("/api/auth/me", { credentials: "same-origin", headers });
        if (!r.ok || !live) return;
        const user = (await r.json()) as Me;
        if (!live) return;
        setMe(user);
        // Pinned Item Store apps: their names come from the launcher.
        if ((user.settings?.nav_apps ?? []).some((id) => !BUILT_IN[id])) {
          const l = await fetch("/api/items/launcher", { credentials: "same-origin", headers });
          if (!l.ok || !live) return;
          const body = (await l.json()) as { apps?: { kind: string; name: string }[] };
          setNames(Object.fromEntries((body.apps ?? []).map((a) => [a.kind, a.name])));
        }
      } catch {
        /* offline: the usual pages */
      }
    })();
    return () => {
      live = false;
    };
  }, [auth]);

  const hidden = new Set(me?.settings?.hidden_nav ?? []);
  const canAutomate = me ? me.role === "admin" || me.can_use_automations === true : false;
  const pages: Link[] = NAV.filter((n) => !(n.optional && hidden.has(n.optional)) && (!n.automations || canAutomate)).map(({ href, label, icon }) => ({
    href,
    label,
    icon,
  }));
  const apps: Link[] = (me?.settings?.nav_apps ?? []).flatMap((id): Link[] => {
    if (BUILT_IN[id]) return [BUILT_IN[id]];
    return names[id] ? [{ href: `/apps/${id}`, label: names[id], icon: Blocks, img: `/item-icons/${id}-192.png` }] : [];
  });
  const more: Link[] = [
    { href: "/archive", label: "Archive", icon: Archive },
    { href: "/trash", label: "Trash", icon: Trash2 },
    ...(me?.role === "admin" ? [{ href: "/admin", label: "Settings", icon: Settings }] : []),
  ];
  return { pages, apps, more, colourIcons: me?.settings?.nav_app_icons === "color" };
}

type NavCtx = { open: () => void; claim: () => () => void };
const PromptlyNavContext = createContext<NavCtx | null>(null);

/** The vault page inside Promptly: its navigation around the vault. */
export function PromptlyFrame({ auth, children }: { auth: () => string | null | Promise<string | null>; children: ReactNode }) {
  const nav = useSidebar(auth);
  const [drawer, setDrawer] = useState(false);
  // The vault's phone header shows the menu button when it's on screen;
  // otherwise (unlock, setup) it floats in the corner.
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const open = useCallback(() => setDrawer(true), []);

  return (
    <PromptlyNavContext.Provider value={{ open, claim }}>
      <div className="flex min-h-[100dvh]">
        <Rail nav={nav} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {claims === 0 && (
        <div className="fixed left-2 top-2 z-30 md:hidden" style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}>
          <MenuButton onClick={open} floating />
        </div>
      )}
      {drawer && <Drawer nav={nav} onClose={() => setDrawer(false)} />}
    </PromptlyNavContext.Provider>
  );
}

/** Where the vault's phone header puts Promptly's menu button. Nothing
 *  outside Promptly (installed app, extension, desktop app). */
export function PromptlyMenuSlot() {
  const ctx = useContext(PromptlyNavContext);
  const claim = ctx?.claim;
  useEffect(() => claim?.(), [claim]);
  if (!ctx) return null;
  return <MenuButton onClick={ctx.open} />;
}

/** Promptly's mark rather than a second ☰: the vault's own menu is right
 *  beside it on a phone. */
function MenuButton({ onClick, floating = false }: { onClick: () => void; floating?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation menu"
      title="Promptly menu"
      className={`inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] ${
        floating ? "border border-[var(--border)] bg-[var(--surface)] pr-2 shadow-sm" : ""
      }`}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white" aria-hidden>
        <span className="text-sm font-bold">P</span>
      </span>
      {floating && <Menu className="h-4 w-4" aria-hidden />}
    </button>
  );
}

const iconLink = (current?: boolean) =>
  `inline-flex h-9 w-9 items-center justify-center rounded-md transition ${
    current ? "bg-[var(--accent)]/10 text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
  }`;

function Glyph({ link, colour }: { link: Link; colour: boolean }) {
  const Icon = link.icon;
  if (link.img && (colour || Icon === Blocks)) return <img src={link.img} alt="" className="h-4 w-4 rounded-[4px]" draggable={false} />;
  return <Icon className="h-4 w-4" />;
}

/** Big screens: like the main sidebar collapsed to its rail. */
function Rail({ nav }: { nav: ReturnType<typeof useSidebar> }) {
  const row = (l: Link) => (
    <a key={l.href} href={l.href} title={l.label} aria-label={l.label} aria-current={l.current ? "page" : undefined} className={iconLink(l.current)}>
      <Glyph link={l} colour={nav.colourIcons} />
    </a>
  );
  return (
    <nav
      aria-label="Promptly"
      className="sticky top-0 hidden h-[100dvh] w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] py-3 md:flex"
    >
      <a href="/chat" title="Promptly" aria-label="Promptly home" className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
        <span className="text-sm font-bold" aria-hidden>
          P
        </span>
      </a>
      <a
        href="/chat"
        title="New chat"
        aria-label="New chat"
        className="mb-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-white hover:opacity-90"
      >
        <MessageSquarePlus className="h-4 w-4" />
      </a>
      {nav.pages.map(row)}
      {nav.apps.map(row)}
      {nav.more.map(row)}
    </nav>
  );
}

/** Phones: the main app's slide-in menu. */
function Drawer({ nav, onClose }: { nav: ReturnType<typeof useSidebar>; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const row = (l: Link) => (
    <a
      key={l.href}
      href={l.href}
      aria-current={l.current ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition ${
        l.current ? "bg-[var(--accent)]/10 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
      }`}
    >
      <Glyph link={l} colour={nav.colourIcons} />
      <span>{l.label}</span>
    </a>
  );
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal
        aria-label="Navigation menu"
        className="absolute bottom-0 left-0 top-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-xl"
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <a href="/chat" className="flex items-center gap-2 text-[var(--text)]">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
              <span className="text-sm font-bold" aria-hidden>
                P
              </span>
            </span>
            <span className="text-sm font-semibold tracking-tight">Promptly</span>
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-3">
          <a
            href="/chat"
            className="flex w-full items-center justify-center gap-2 rounded-input bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New chat
          </a>
        </div>
        <nav aria-label="Promptly" className="mt-4 flex flex-col gap-0.5 px-2">
          {nav.pages.map(row)}
          {nav.apps.map(row)}
          <div className="my-2 border-t border-[var(--border)]" />
          {nav.more.map(row)}
        </nav>
      </div>
    </div>
  );
}
