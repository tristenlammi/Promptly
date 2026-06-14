import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Check, X } from "lucide-react";

import { cn } from "@/utils/cn";

// Width of the popover (matches the Tailwind w-60 we render it at). Used
// to right-align the portaled menu under the button.
const POPOVER_WIDTH = 240;

export interface DateRange {
  /** Inclusive lower bound as a UTC ISO instant, or null for open-ended. */
  start: string | null;
  /** Exclusive upper bound as a UTC ISO instant, or null for open-ended. */
  end: string | null;
  /** Human label for the active-filter chip, e.g. "Last 7 days". */
  label: string;
}

// --- local-day boundary helpers -------------------------------------
// Presets resolve to the user's *local* calendar day, then hand the
// equivalent UTC instants to the backend. So "Today" means the user's
// today regardless of where the server lives.

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function iso(d: Date): string {
  return d.toISOString();
}

// yyyy-mm-dd (local) → Date at local start-of-day. The native date input
// always yields a local calendar date in this format.
function parseLocalDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

interface Preset {
  key: string;
  label: string;
  build: () => DateRange;
}

const PRESETS: Preset[] = [
  {
    key: "today",
    label: "Today",
    build: () => {
      const s = startOfLocalDay(new Date());
      return { start: iso(s), end: iso(addDays(s, 1)), label: "Today" };
    },
  },
  {
    key: "yesterday",
    label: "Yesterday",
    build: () => {
      const s = addDays(startOfLocalDay(new Date()), -1);
      return { start: iso(s), end: iso(addDays(s, 1)), label: "Yesterday" };
    },
  },
  {
    key: "7d",
    label: "Last 7 days",
    build: () => {
      const today = startOfLocalDay(new Date());
      return {
        start: iso(addDays(today, -6)),
        end: iso(addDays(today, 1)),
        label: "Last 7 days",
      };
    },
  },
  {
    key: "30d",
    label: "Last 30 days",
    build: () => {
      const today = startOfLocalDay(new Date());
      return {
        start: iso(addDays(today, -29)),
        end: iso(addDays(today, 1)),
        label: "Last 30 days",
      };
    },
  },
  {
    key: "month",
    label: "This month",
    build: () => {
      const now = new Date();
      const s = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const today = startOfLocalDay(now);
      return { start: iso(s), end: iso(addDays(today, 1)), label: "This month" };
    },
  },
];

// Build a custom range + chip label from two optional local dates. ``to``
// is inclusive of the chosen day, so the exclusive upper bound is the
// start of the next day.
function buildCustomRange(
  fromValue: string,
  toValue: string
): DateRange | null {
  const from = fromValue ? parseLocalDateInput(fromValue) : null;
  const to = toValue ? parseLocalDateInput(toValue) : null;
  if (!from && !to) return null;
  const start = from ? iso(from) : null;
  const end = to ? iso(addDays(to, 1)) : null;
  let label: string;
  if (from && to) {
    label = `${SHORT_DATE.format(from)} – ${SHORT_DATE.format(to)}`;
  } else if (from) {
    label = `Since ${SHORT_DATE.format(from)}`;
  } else {
    label = `Before ${SHORT_DATE.format(to as Date)}`;
  }
  return { start, end, label };
}

interface Props {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  /** Notifies the parent when the popover opens/closes so it can yield
   *  the keyboard (e.g. not steal Escape) while the popover is up. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Compact date-range filter for the search palette. A calendar button
 * opens a popover with one-click presets plus a custom range built from
 * two native date inputs. All boundaries resolve to the user's local
 * calendar day, then hand UTC instants up to the caller.
 */
export function SearchDateFilter({ value, onChange, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  // Fixed viewport coords for the portaled popover (null until opened).
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // Anchor the popover to the button, right-aligned. We portal it to
  // <body> so the search palette's ``overflow-hidden`` (its rounded-corner
  // clip) can't cut the menu off — hence fixed viewport coords here.
  const positionFromButton = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setCoords({
      top: r.bottom + 4,
      left: Math.max(8, r.right - POPOVER_WIDTH),
    });
  };

  const openMenu = () => {
    positionFromButton();
    setOpen(true);
  };

  // Custom-range inputs. Presets leave these blank so reopening the
  // popover after picking a preset still shows the preset list cleanly.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Close on outside click / Escape while open; reposition on resize. The
  // outside-click check spans both the button and the portaled popover
  // (which lives outside ``rootRef`` in the DOM). Capture Escape so it
  // closes the popover without also closing the whole search palette.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        (rootRef.current && rootRef.current.contains(t)) ||
        (popRef.current && popRef.current.contains(t))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", positionFromButton);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", positionFromButton);
    };
  }, [open]);

  const active = value !== null;

  const clear = () => {
    setCustomFrom("");
    setCustomTo("");
    onChange(null);
  };

  const applyPreset = (preset: Preset) => {
    setCustomFrom("");
    setCustomTo("");
    onChange(preset.build());
    setOpen(false);
  };

  const applyCustom = (from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
    onChange(buildCustomRange(from, to));
  };

  // Which preset (if any) the active range matches — drives the check mark.
  const activePresetKey = (() => {
    if (!value) return null;
    for (const p of PRESETS) {
      const r = p.build();
      if (r.start === value.start && r.end === value.end) return p.key;
    }
    return null;
  })();

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-label="Filter by date"
        aria-expanded={open}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] transition",
          active
            ? "border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]"
            : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
        )}
      >
        <CalendarDays className="h-3.5 w-3.5" />
        {active ? (
          <>
            <span className="max-w-[120px] truncate">{value!.label}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear date filter"
              onClick={(e) => {
                e.stopPropagation();
                clear();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  clear();
                }
              }}
              className="-mr-0.5 ml-0.5 inline-flex rounded p-0.5 hover:bg-[var(--accent)]/20"
            >
              <X className="h-3 w-3" />
            </span>
          </>
        ) : (
          <span>Date</span>
        )}
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              width: POPOVER_WIDTH,
            }}
            className={cn(
              "z-[95] max-h-[70vh] overflow-y-auto rounded-lg border shadow-xl",
              "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
            )}
          >
          <div className="py-1">
            {PRESETS.map((p) => {
              const selected = activePresetKey === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition hover:bg-[var(--surface-2)]"
                >
                  <span>{p.label}</span>
                  {selected && (
                    <Check className="h-3.5 w-3.5 text-[var(--accent)]" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t border-[var(--border)] px-3 py-2">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Custom range
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                <span>From</span>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => applyCustom(e.target.value, customTo)}
                  className="rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[11px] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                <span>To</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => applyCustom(customFrom, e.target.value)}
                  className="rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[11px] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
            </div>
          </div>

          {active && (
            <div className="border-t border-[var(--border)] px-3 py-1.5">
              <button
                type="button"
                onClick={() => {
                  clear();
                  setOpen(false);
                }}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                Clear filter
              </button>
            </div>
          )}
          </div>,
          document.body
        )}
    </div>
  );
}
