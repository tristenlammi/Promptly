import { Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { NotifyLevel, RoomUser, Space } from "@/api/rooms";
import { Avatar, Segmented } from "@/items/ui";
import { cn } from "@/utils/cn";

import { EMOJI_GROUPS } from "../emoji";
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
      style={{ width: size, height: size, background: "linear-gradient(135deg, var(--item-accent), #D97757)" }}
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
        background: space.color || "var(--item-accent)",
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
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[11px] font-bold leading-none text-white",
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

export function EmojiGrid({ onPick, className }: { onPick: (e: string) => void; className?: string }) {
  return (
    <div className={cn("flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain p-2", className)}>
      {EMOJI_GROUPS.map((g) => (
        <div key={g.name}>
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{g.name}</p>
          <div className="grid grid-cols-8 gap-0.5">
            {g.emoji.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                onClick={() => onPick(e)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
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
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  className?: string;
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
    const left = Math.max(8, Math.min(vw - width - 8, r.right - width));
    if (r.top > vh / 2) setPos({ left, bottom: vh - r.top + 6 });
    else setPos({ left, top: r.bottom + 6 });
  }, [open, anchor, width]);

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
