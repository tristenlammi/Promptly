import { Check, Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Sheet, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { money } from "./logic";
import type { BudgetData, Category } from "./types";

export type H = ItemHandle<BudgetData>;

export function useMoney(item: H) {
  const cur = item.data.settings.currency || "AUD";
  return useMemo(() => (cents: number, opts?: { sign?: boolean; whole?: boolean }) => money(cents, cur, opts), [cur]);
}

/** A signed amount: money in is green, out is the normal text colour. */
export function Amount({ cents, fmt, className, muted }: { cents: number; fmt: (c: number, o?: { sign?: boolean }) => string; className?: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap font-semibold tabular-nums",
        cents > 0 ? "text-[var(--success)]" : muted ? "text-[var(--text-muted)]" : "text-[var(--text)]",
        className,
      )}
    >
      {fmt(cents, { sign: true })}
    </span>
  );
}

export function CatBadge({ cat, size = 36, transfer }: { cat?: Category | null; size?: number; transfer?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_12%,var(--surface-2))]"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {transfer ? "↔️" : cat?.emoji || (cat ? cat.name[0] : "❔")}
    </span>
  );
}

export function Pill({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "warn" | "bad" | "good" | "accent"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold",
        tone === "neutral" && "bg-[var(--surface-2)] text-[var(--text-muted)]",
        tone === "warn" && "bg-[color-mix(in_srgb,var(--warning,#d9902f)_18%,transparent)] text-[var(--warning,#b7791f)]",
        tone === "bad" && "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)]",
        tone === "good" && "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]",
        tone === "accent" && "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Pick a category: grouped, searchable, one tap. */
export function CategoryPicker({
  data,
  open,
  onClose,
  onPick,
  value,
  title = "Category",
  kinds = ["expense", "income"],
  footer,
  header,
  allowNone,
}: {
  data: BudgetData;
  open: boolean;
  onClose: () => void;
  onPick: (id: string | null) => void;
  value?: string | null;
  title?: string;
  kinds?: ("expense" | "income")[];
  footer?: ReactNode;
  /** Above the search box (e.g. "Always for this payee"), so it's seen before picking. */
  header?: ReactNode;
  allowNone?: boolean;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.groups
      .map((g) => ({
        g,
        cats: data.categories.filter(
          (c) => c.group_id === g.id && !c.hidden && kinds.includes(c.kind) && (!needle || c.name.toLowerCase().includes(needle)),
        ),
      }))
      .filter((x) => x.cats.length);
  }, [data, q, kinds]);
  return (
    <Sheet open={open} onClose={onClose} title={title} footer={footer} size="md">
      <div className="sticky top-0 z-10 -mx-5 bg-[var(--bg)] px-5 pb-2">
        {header && <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">{header}</div>}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a category" className="pl-9" aria-label="Find a category" />
        </div>
      </div>
      <div className="flex flex-col gap-4 pb-2">
        {allowNone && !q && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex min-h-[44px] items-center gap-3 rounded-xl px-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            <CatBadge size={32} /> Uncategorised
          </button>
        )}
        {groups.map(({ g, cats }) => (
          <div key={g.id}>
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{g.name}</p>
            <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {cats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick(c.id)}
                  className={cn(
                    "flex min-h-[44px] items-center gap-3 rounded-xl px-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                    value === c.id && "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]",
                  )}
                >
                  <CatBadge cat={c} size={32} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {value === c.id && <Check className="h-4 w-4 text-[var(--item-accent)]" />}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="py-6 text-center text-sm text-[var(--text-muted)]">No category matches “{q}”.</p>}
      </div>
    </Sheet>
  );
}

export function Bar({ value, over, thin }: { value: number; over?: boolean; thin?: boolean }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className={cn(thin ? "h-1" : "h-2", "w-full overflow-hidden rounded-full bg-[var(--surface-2)]")} role="presentation">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${v * 100}%`, background: over ? "var(--danger)" : v > 0.9 && v < 1 ? "var(--warning, #d9902f)" : "var(--item-accent)" }}
      />
    </div>
  );
}

/** The rendered width of an element (0 until measured) — for layouts that
 *  depend on the room the tab really has (the AI panel takes a third of a
 *  desktop window, so the viewport width alone says little). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    ro.current = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}
