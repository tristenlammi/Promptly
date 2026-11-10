import { Search, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { NotifyLevel, RoomUser, Space } from "@/api/rooms";
import { Avatar, Segmented } from "@/items/ui";
import { cn } from "@/utils/cn";

import { EMOJI_GROUPS } from "../emoji";
import { emojiMatches } from "../emojiNames";
import { initials } from "../format";

export function UserAvatar({ user, size = 36, className }: { user: RoomUser | undefined | null; size?: number; className?: string }) {
  const name = user?.username ?? "?";
  if (!user?.avatar_url && user?.color) {
    return (
      <span
        aria-hidden
        className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
        style={{ width: size, height: size, background: user.color, fontSize: size * 0.38 }}
      >
        {initials(name)}
      </span>
    );
  }
  return <Avatar name={name} src={user?.avatar_url} size={size} className={className} />;
}

export function PromptlyAvatar({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full text-white"
      style={{ width: size, height: size, background: "linear-gradient(135deg, var(--accent-strong), var(--accent))" }}
    >
      <Sparkles style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

export function SpaceIcon({ space, size = 48, className }: { space: Pick<Space, "name" | "emoji" | "color">; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 select-none items-center justify-center font-semibold text-white", className)}
      style={{
        width: size,
        height: size,
        background: space.color || "var(--accent)",
        fontSize: space.emoji ? size * 0.5 : size * 0.36,
        borderRadius: size * 0.3,
      }}
    >
      {space.emoji || initials(space.name)}
    </span>
  );
}

/** A red pill with a count (mentions / unread). */
export function CountBadge({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--danger)] px-1 text-xs font-bold leading-none text-white",
        className,
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function NotifyControl({
  value,
  onChange,
  allowInherit,
  inheritLabel,
}: {
  value: NotifyLevel | null;
  onChange: (v: NotifyLevel | null) => void;
  allowInherit?: boolean;
  inheritLabel?: string;
}) {
  type V = NotifyLevel | "inherit";
  const opts: { value: V; label: string }[] = [
    ...(allowInherit ? [{ value: "inherit" as V, label: inheritLabel ?? "Default" }] : []),
    { value: "all", label: "All" },
    { value: "mentions", label: "Mentions" },
    { value: "none", label: "None" },
  ];
  return (
    <Segmented<V>
      className="w-full"
      value={value ?? (allowInherit ? "inherit" : "all")}
      onChange={(v) => onChange(v === "inherit" ? null : v)}
      options={opts}
    />
  );
}

const RECENT_EMOJI_KEY = "promptly:rooms:recent-emoji";
const RECENT_EMOJI_MAX = 16;

function readRecentEmoji(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_EMOJI_MAX) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(e: string) {
  try {
    const next = [e, ...readRecentEmoji().filter((x) => x !== e)].slice(0, RECENT_EMOJI_MAX);
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
  } catch {
    /* no storage: no recents */
  }
}

/** The emoji picker: a search box, the ones you used lately, then the lot. */
export function EmojiGrid({ onPick, className }: { onPick: (e: string) => void; className?: string }) {
  const [q, setQ] = useState("");
  // Read once per opening, so the row doesn't reshuffle under your finger.
  const [recent] = useState(readRecentEmoji);
  const pick = (e: string) => {
    rememberEmoji(e);
    onPick(e);
  };
  const query = q.trim();
  const groups = query
    ? [{ name: "Results", emoji: [...new Set(EMOJI_GROUPS.flatMap((g) => g.emoji))].filter((e) => emojiMatches(e, query)) }]
    : [...(recent.length ? [{ name: "Recent", emoji: recent }] : []), ...EMOJI_GROUPS];
  const cell =
    "flex h-10 w-10 items-center justify-center rounded-lg text-xl hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:h-9 md:w-9";
  return (
    <div className={cn("flex max-h-80 flex-col", className)}>
      <label className="relative m-2 mb-1 block shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Enter picks the first match.
            if (e.key === "Enter" && query && groups[0]?.emoji[0]) {
              e.preventDefault();
              pick(groups[0].emoji[0]);
            }
          }}
          placeholder="Search emoji"
          aria-label="Search emoji"
          autoComplete="off"
          className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] pl-8 pr-3 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none md:h-9"
        />
      </label>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2 pt-1">
        {groups.map((g) => (
          <div key={g.name}>
            <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{g.name}</p>
            {g.emoji.length === 0 ? (
              <p className="px-1 py-3 text-sm text-[var(--text-muted)]">Nothing matches "{query}". Try another word.</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-0.5">
                {g.emoji.map((e) => (
                  <button key={e} type="button" aria-label={e} onClick={() => pick(e)} className={cell}>
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small floating panel next to an element; closes on outside click / Escape. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  width = 320,
  className,
  align = "end",
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  className?: string;
  /** Line the panel up with the anchor's right edge ("end") or left edge ("start"). */
  align?: "start" | "end";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(vw - width - 8, align === "start" ? r.left : r.right - width));
    if (r.top > vh / 2) setPos({ left, bottom: vh - r.top + 6 });
    else setPos({ left, top: r.bottom + 6 });
  }, [open, anchor, width, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width, zIndex: 80 }}
      className={cn(
        "overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export function SrOnly({ children, live }: { children: ReactNode; live?: "polite" | "assertive" }) {
  return (
    <span className="sr-only" aria-live={live}>
      {children}
    </span>
  );
}
