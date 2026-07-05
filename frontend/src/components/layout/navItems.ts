import {
  BookOpen,
  FolderKanban,
  FolderOpen,
  ListTodo,
  MessagesSquare,
  Star,
  Trash2,
  Share2,
  Clock,
  Search,
  type LucideIcon,
} from "lucide-react";

/**
 * Stage-3 preparation: a single source of truth for every top-level
 * nav item. The main Sidebar still hand-rolls its own markup today —
 * we only *read* from this config in one place (the future Drive
 * layout variant), but keeping it here means there's exactly one
 * place to edit when a section is added, removed, or moved.
 *
 * ``section`` is what the stage-3 Drive PWA will filter on: the
 * Drive-only layout keeps ``section === "drive"`` items and drops
 * every chat / study / admin surface. Until then nothing consumes
 * this.
 */
export type NavSection = "chat" | "drive" | "study" | "admin";

/** Stable identifiers for the *optional* nav surfaces a user can hide
 *  from their sidebar (Phase 2 — per-user feature visibility). Chat and
 *  Files are core and intentionally absent. */
export type OptionalNavKey = "workspaces" | "study" | "tasks";

export const OPTIONAL_NAV_KEYS: { key: OptionalNavKey; label: string; description: string }[] = [
  {
    key: "workspaces",
    label: "Workspaces",
    description: "Group chats, files, and context into shared workspaces.",
  },
  // "tasks" (Automations) is intentionally not offered here — automations now
  // live only inside workspaces (a private workspace serves personal use), so
  // there's no standalone personal automations surface to toggle.
  {
    key: "study",
    label: "Study",
    description: "Interactive study mode with a whiteboard and exercises.",
  },
];

export interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  section: NavSection;
  /** Restrict matching to exact pathname (``NavLink`` ``end``). */
  exact?: boolean;
  /** Hide on mobile — mirrors the current Sidebar rule for Study. */
  desktopOnly?: boolean;
  /** Hide unless the viewer is an admin. */
  adminOnly?: boolean;
  /** When set, this item is *optional*: the user can hide it from their
   *  sidebar via Account → Features. Matches an ``OptionalNavKey``. */
  optionalKey?: OptionalNavKey;
}

export const NAV_ITEMS: NavItem[] = [
  {
    to: "/chat",
    icon: MessagesSquare,
    label: "Chat",
    section: "chat",
    exact: true,
  },
  {
    to: "/workspaces",
    icon: FolderKanban,
    label: "Workspaces",
    section: "chat",
    // Workspaces are a desktop surface by design (multi-pane layout,
    // drag-first navigator) — the route itself also renders a notice on
    // phones for direct links.
    desktopOnly: true,
    optionalKey: "workspaces",
  },
  {
    to: "/work",
    icon: ListTodo,
    label: "My work",
    section: "chat",
    // Card deep-links land inside desktop-gated workspaces, so the page
    // follows the same rule.
    desktopOnly: true,
    optionalKey: "workspaces",
  },
  {
    to: "/study",
    icon: BookOpen,
    label: "Study",
    section: "study",
    desktopOnly: true,
    optionalKey: "study",
  },
  {
    to: "/files",
    icon: FolderOpen,
    label: "Files",
    section: "drive",
    exact: true,
  },
];

/** Sub-nav surfaces inside the Drive section. These are not part of
 *  the top-level Sidebar today; the stage-3 Drive PWA will elevate
 *  them and drop ``NAV_ITEMS`` entries outside ``section === "drive"``. */
export const DRIVE_SUBNAV_ITEMS: NavItem[] = [
  {
    to: "/files",
    icon: FolderOpen,
    label: "My Drive",
    section: "drive",
    exact: true,
  },
  {
    to: "/files/recent",
    icon: Clock,
    label: "Recent",
    section: "drive",
  },
  {
    to: "/files/starred",
    icon: Star,
    label: "Starred",
    section: "drive",
  },
  {
    to: "/files/shared",
    icon: Share2,
    label: "Shared",
    section: "drive",
  },
  {
    to: "/files/trash",
    icon: Trash2,
    label: "Trash",
    section: "drive",
  },
  {
    to: "/files/search",
    icon: Search,
    label: "Search",
    section: "drive",
  },
];
