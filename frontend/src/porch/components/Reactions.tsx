import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { porchApi, REACTIONS, type PorchUser, type Reactions } from "@/api/porch";
import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { LoadError, PersonLink, PorchAvatar, shortAgo } from "./ui";

/**
 * A press that does one thing on a tap and another on a hold (or a right
 * click): tap = ❤️, hold = the other reactions. Keyboard users get the same
 * from a separate "More reactions" button.
 */
export function useLongPress(onLong: (at: { x: number; y: number }) => void, ms = 450) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    /** True right after a hold fired (so the click that follows is ignored). */
    consumed: () => {
      const f = fired.current;
      fired.current = false;
      return f;
    },
    handlers: {
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button !== 0) return;
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clear();
        timer.current = window.setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(10);
          onLong(start.current ?? { x: e.clientX, y: e.clientY });
        }, ms);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const s = start.current;
        if (s && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 10) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        clear();
        fired.current = true;
        onLong({ x: e.clientX, y: e.clientY });
      },
    },
  };
}

/** The six reactions in a row, floating near where it was asked for. */
export function ReactionPicker({
  open,
  at,
  current,
  onPick,
  onClose,
  label = "Reactions",
}: {
  open: boolean;
  at: { x: number; y: number } | null;
  current: string | null;
  onPick: (emoji: string | null) => void;
  onClose: () => void;
  label?: string;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => first.current?.focus(), 20);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", key, true);
      back.current?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const w = 6 * 48 + 16;
  const x = Math.max(8, Math.min(window.innerWidth - w - 8, (at?.x ?? window.innerWidth / 2) - w / 2));
  const y = Math.max(8, (at?.y ?? window.innerHeight / 2) - 72);
  return createPortal(
    <div className="fixed inset-0 z-[80]" onClick={onClose} role="presentation">
      <div
        role="menu"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"));
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            items[(i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]?.focus();
          }
        }}
        className="absolute flex gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow-lg)] animate-[fadeIn_120ms_ease-out]"
        style={{ left: x, top: y }}
      >
        {REACTIONS.map((e, i) => (
          <button
            key={e}
            ref={i === 0 ? first : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={current === e}
            aria-label={current === e ? `${e} (yours: tap to take it back)` : e}
            onClick={() => {
              onPick(current === e ? null : e);
              onClose();
            }}
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-full text-2xl transition hover:scale-110 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              current === e && "bg-[color-mix(in_srgb,var(--item-accent)_18%,transparent)]",
            )}
          >
            {e}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** "Mum, Sam and 3 others" — on your own post or comment only. */
export function whoWords(people: PorchUser[], count: number): string {
  const names = people.slice(0, 2).map((p) => p.name);
  const more = count - names.length;
  if (!names.length) return count === 1 ? "1 person" : `${count} people`;
  if (more <= 0) return names.length === 2 ? `${names[0]} and ${names[1]}` : names[0];
  return `${names.join(", ")} and ${more} ${more === 1 ? "other" : "others"}`;
}

/** The emoji people used (no numbers), or who reacted on your own. */
export function ReactionsLine({
  r,
  onWho,
  className,
  prefix,
}: {
  r: Reactions;
  /** Yours: open the list of who reacted. */
  onWho?: () => void;
  className?: string;
  prefix?: ReactNode;
}) {
  if (!r.emojis.length) return null;
  const emojis = (
    <span aria-hidden className="tracking-tight">
      {r.emojis.join("")}
    </span>
  );
  if (r.people && r.count && onWho) {
    return (
      <button
        type="button"
        onClick={onWho}
        className={cn("inline-flex min-h-[32px] items-center gap-1.5 text-left text-sm text-[var(--text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] rounded", className)}
      >
        {prefix}
        {emojis}
        <span>{whoWords(r.people, r.count)}</span>
        <span className="sr-only">reacted. See who.</span>
      </button>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      {prefix}
      {emojis}
      <span className="sr-only">Reactions: {r.emojis.join(" ")}</span>
    </span>
  );
}

/** Who reacted to your post or comment: only ever shown to you. */
export function WhoReactedSheet({ target, id, open, onClose }: { target: "post" | "comment"; id: string; open: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ["porch", "who", target, id], queryFn: () => porchApi.whoReacted(target, id), enabled: open, staleTime: 0 });
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => {
    if (open) setFilter(null);
  }, [open]);
  const rows = (q.data ?? []).filter((r) => !filter || r.emoji === filter);
  const used = Array.from(new Set((q.data ?? []).map((r) => r.emoji)));
  return (
    <Sheet open={open} onClose={onClose} title="Reactions" size="sm">
      <p className="mb-3 text-xs text-[var(--text-muted)]">Only you can see who reacted.</p>
      {used.length > 1 && (
        <div role="radiogroup" aria-label="Show" className="mb-3 flex flex-wrap gap-1.5">
          {[null, ...used].map((e) => (
            <button
              key={e ?? "all"}
              type="button"
              role="radio"
              aria-checked={filter === e}
              onClick={() => setFilter(e)}
              className={cn(
                "h-8 rounded-full border px-3 text-sm",
                filter === e ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]",
              )}
            >
              {e ?? "All"}
            </button>
          ))}
        </div>
      )}
      {q.isPending ? (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">Loading…</p>
      ) : q.isError ? (
        <LoadError what="Couldn't load the reactions." onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">No reactions any more.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {rows.map((r) => (
            <li key={r.user.id} className="flex min-h-[52px] items-center gap-3 rounded-xl px-2">
              <PorchAvatar user={r.user} size={36} />
              <span className="flex min-w-0 flex-1 flex-col">
                <PersonLink user={r.user} className="truncate text-sm" />
                {r.created_at && <span className="text-xs text-[var(--text-muted)]">{shortAgo(r.created_at)}</span>}
              </span>
              <span className="text-xl" aria-label={`reacted ${r.emoji}`}>
                {r.emoji}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
