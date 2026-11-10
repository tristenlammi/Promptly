import { ArrowLeft, Globe2, Lock } from "lucide-react";
import { useContext, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { GroupLabel, PorchGroup, PorchUser } from "@/api/porch";
import { PromptlyMenuButton } from "@/components/layout/PromptlyNavDrawer";
import { Callout } from "@/components/shared/Callout";
import { Skeleton } from "@/components/shared/Skeleton";
import { defaultColorForUserId } from "@/components/shared/UserAvatar";
import { ItemButton, Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { PorchContext } from "../context";

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.2;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Someone's picture, or their initials on their colour (in white or near
 *  black, whichever reads better). Decorative: their name is always beside it. */
export function PorchAvatar({ user, size = 40, className }: { user: PorchUser | null | undefined; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (user?.avatar_url && !failed) {
    return (
      <img
        src={user.avatar_url}
        alt=""
        onError={() => setFailed(true)}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const bg = user?.color || defaultColorForUserId(user?.id);
  // White on the colour, unless that's under WCAG's 4.5:1.
  const light = (1.05 / (luminance(bg) + 0.05)) < 4.5;
  const name = user?.name ?? "?";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, size >= 40 ? 2 : 1)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold", className)}
      style={{ width: size, height: size, background: bg, color: light ? "#1A1A19" : "#FFFFFF", fontSize: Math.max(9, size * 0.4) }}
    >
      {initials || "?"}
    </span>
  );
}

/** A group's cover, else its emoji on a soft band of the accent. */
export function GroupTile({
  group,
  size = 44,
  className,
}: {
  group: Pick<PorchGroup, "name" | "emoji"> & { cover_url?: string | null };
  size?: number;
  className?: string;
}) {
  const radius = Math.round(size * 0.28);
  if (group.cover_url) {
    return <img src={group.cover_url} alt="" className={cn("shrink-0 object-cover", className)} style={{ width: size, height: size, borderRadius: radius }} />;
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center bg-[color-mix(in_srgb,var(--item-accent)_16%,var(--surface))] font-semibold text-[var(--text)]", className)}
      style={{ width: size, height: size, borderRadius: radius, fontSize: size * (group.emoji ? 0.5 : 0.4) }}
    >
      {group.emoji || group.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 🔒 Private / 🌏 Public, said in words too. */
export function VisibilityTag({ visibility, everyone, className }: { visibility: PorchGroup["visibility"]; everyone?: boolean; className?: string }) {
  const Icon = visibility === "private" ? Lock : Globe2;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-[var(--text-muted)]", className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {everyone ? "Everyone on this Promptly" : visibility === "private" ? "Private" : "Public"}
    </span>
  );
}

export function peopleCount(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** "in Family · The Lads" — only ever your own groups. */
export function groupsLine(groups: GroupLabel[]): string {
  return groups.map((g) => `${g.emoji ? `${g.emoji} ` : ""}${g.name}`).join(" · ");
}

const SHORT = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const LONG = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** "now", "5m", "2h", "3d", "12 Mar", "12 Mar 2025". */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(iso);
  return d.getFullYear() === new Date(now).getFullYear() ? SHORT.format(d) : LONG.format(d);
}

export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

/** A day ("2026-03-12") in words, without time-zone drift. */
export function dayWords(day: string, withYear = true): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString(undefined, withYear ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "long" });
}

/** The top bar of a page: back (phone, or when asked), the title, actions. */
export function PageHeader({
  title,
  back,
  actions,
  className,
}: {
  title: ReactNode;
  /** Where back goes; ``true`` = history back. */
  back?: string | true;
  actions?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  // Inside Promptly on a phone: a top-level page offers Promptly's menu.
  const { promptlyNav } = useContext(PorchContext);
  const menu = promptlyNav && !back;
  return (
    <header className={cn("flex h-14 shrink-0 items-center gap-1 px-2 md:px-0", className)}>
      {menu && <PromptlyMenuButton className="h-11 w-11 rounded-xl" />}
      {back && (
        <button
          type="button"
          aria-label="Back"
          onClick={() => (back === true ? (window.history.length > 1 ? navigate(-1) : navigate("/porch/")) : navigate(back))}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      )}
      <h1 className={cn("min-w-0 flex-1 truncate text-lg font-bold text-[var(--text)]", !back && !menu && "px-2 md:px-0")}>{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

/** One page's column: the feed width on desktop, room for the phone's bottom bar. */
export function Column({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  const { isPhone } = useContext(PorchContext);
  return (
    <div className={cn("mx-auto flex w-full flex-col", wide ? "max-w-3xl" : "max-w-[600px]", isPhone ? "px-0 pb-24" : "px-4 pb-10", className)}>{children}</div>
  );
}

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="px-4 py-10">
      <Callout tone="danger">
        <div className="flex flex-col items-start gap-3">
          <span>{what}</span>
          <ItemButton size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </ItemButton>
        </div>
      </Callout>
    </div>
  );
}

export function PostSkeleton() {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--border)] py-4 md:rounded-2xl md:border md:bg-[var(--surface)] md:px-4" aria-hidden>
      <div className="flex items-center gap-3 px-4 md:px-0">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="aspect-[4/5] w-full rounded-none md:rounded-xl" />
      <Skeleton className="mx-4 h-3.5 w-3/4 md:mx-0" />
    </div>
  );
}

/** Grey rows where a list is on its way (people, comments, notifications). */
export function RowsSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("flex flex-col gap-4 py-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3" aria-hidden>
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={cn("h-3.5", i % 2 ? "w-2/5" : "w-3/5")} />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Grey squares where a grid of photos or stories is on its way. */
export function TilesSkeleton({ tiles = 9, className }: { tiles?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("grid grid-cols-3 gap-0.5", className)}>
      {Array.from({ length: tiles }, (_, i) => (
        <Skeleton key={i} className="aspect-square w-full rounded-none" />
      ))}
    </div>
  );
}

export type MenuGroup = "share" | "manage" | "safety";
const MENU_GROUPS: { id: MenuGroup; title: string }[] = [
  { id: "share", title: "Share" },
  { id: "manage", title: "Manage" },
  { id: "safety", title: "Safety" },
];

export interface MenuAction {
  /** Which part of a longer menu it sits in (Share, Manage, Safety). */
  group?: MenuGroup;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  danger?: boolean;
  hint?: string;
}

/** A short list of actions ("…"): a bottom sheet on a phone, a small dialog on desktop. */
export function ActionSheet({ open, onClose, title, actions }: { open: boolean; onClose: () => void; title: string; actions: MenuAction[] }) {
  const row = (a: MenuAction) => {
    const Icon = a.icon;
    return (
            <li key={a.label}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  a.onClick();
                }}
                className={cn(
                  "flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
                  a.danger ? "text-[var(--danger)]" : "text-[var(--text)]",
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{a.label}</span>
                  {a.hint && <span className="text-xs text-[var(--text-muted)]">{a.hint}</span>}
                </span>
              </button>
            </li>
    );
  };
  // A longer menu comes in parts, each under its own small heading.
  const parts = [
    { id: "none", title: "", rows: actions.filter((a) => !a.group) },
    ...MENU_GROUPS.map((g) => ({ id: g.id as string, title: g.title, rows: actions.filter((a) => a.group === g.id) })),
  ].filter((p) => p.rows.length > 0);
  return (
    <Sheet open={open} onClose={onClose} title={title} size="sm">
      <div className="-mx-2 flex flex-col">
        {parts.map((p, i) => (
          <div key={p.id} role={p.title ? "group" : undefined} aria-label={p.title || undefined} className={cn(i > 0 && "mt-1.5 border-t border-[var(--border)] pt-1.5")}>
            {p.title && parts.length > 1 && (
              <p aria-hidden className="px-3 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {p.title}
              </p>
            )}
            <ul className="flex flex-col">{p.rows.map(row)}</ul>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/** A link to someone's Porch profile, by name. */
export function PersonLink({ user, className }: { user: PorchUser | null; className?: string }) {
  if (!user) return <span className={className}>Someone</span>;
  return (
    <Link to={`/porch/u/${user.id}`} className={cn("font-semibold text-[var(--text)] hover:underline", className)}>
      {user.name}
    </Link>
  );
}
