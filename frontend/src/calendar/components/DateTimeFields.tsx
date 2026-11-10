import { CalendarDays, Clock } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { combine, fmt, parseYmd, ymd } from "../dates";
import { MiniMonth } from "./MiniMonth";
import { Popover } from "./ui";

// Promptly's own date and time pickers for the event editor (a mouse gets
// these; a phone keeps its built-in wheels, which are better under a thumb).

const box =
  "flex h-11 w-full items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-left text-base text-[var(--text)] outline-none transition hover:border-[color-mix(in_srgb,var(--item-accent)_45%,var(--border))] focus-visible:border-[var(--item-accent)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)] md:h-10 md:text-sm";

/** A point that lands the calendar's popover just under ``el``, left edges in line. */
const under = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return new DOMRect(r.left - 8, r.bottom + 12, 0, 0);
};

/** A button that opens a small card under it; Escape closes the card, not the editor behind. */
function Picker({
  label,
  icon,
  text,
  width,
  className,
  children,
}: {
  label: string;
  icon: ReactNode;
  text: string;
  width: number;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const closedAt = useRef(0);
  const btn = useRef<HTMLButtonElement>(null);
  const close = (refocus = false) => {
    closedAt.current = Date.now();
    setAnchor(null);
    if (refocus) btn.current?.focus();
  };
  useEffect(() => {
    if (!anchor) return;
    // Ahead of the sheet's own Escape (which would close the whole editor).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [anchor]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`${label}: ${text}`}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => {
          // The press that closed it doesn't open it again.
          if (Date.now() - closedAt.current < 250) return;
          setAnchor(under(e.currentTarget));
        }}
        className={cn(box, className)}
      >
        <span className="shrink-0 text-[var(--text-muted)]">{icon}</span>
        <span className="min-w-0 flex-1 truncate tabular-nums">{text}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => close()} width={width} z={80}>
          {children(() => close(true))}
        </Popover>
      )}
    </>
  );
}

/** A day, as ``YYYY-MM-DD``. */
export function DateField({ value, onChange, label, native, min }: { value: string; onChange: (v: string) => void; label: string; native: boolean; min?: string }) {
  if (native) return <TextInput type="date" value={value} min={min} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label={label} required />;
  const day = parseYmd(value);
  return (
    <Picker label={label} icon={<CalendarDays className="h-4 w-4" />} text={fmt(day, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} width={272}>
      {(close) => (
        <div className="p-3">
          <MiniMonth
            selected={day}
            onPick={(d) => {
              onChange(ymd(d));
              close();
            }}
          />
        </div>
      )}
    </Picker>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "9", "9:30", "930pm", "21.15" → ``HH:MM`` (null when it isn't a time). */
function parseTime(text: string): string | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?:[:.]?(\d{2}))?\s*([ap])?\.?m?\.?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "p" ? 12 : 0);
  }
  return h > 23 || min > 59 ? null : `${pad(h)}:${pad(min)}`;
}

const timeText = (hm: string) => fmt(combine("2024-01-01", hm), { hour: "numeric", minute: "2-digit" });

/** A time of day, as ``HH:MM``: pick a quarter hour, or type any time. */
export function TimeField({ value, onChange, label, native }: { value: string; onChange: (v: string) => void; label: string; native: boolean }) {
  if (native) return <TextInput type="time" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label={label} className="!w-[7.5rem]" />;
  return (
    <Picker label={label} icon={<Clock className="h-4 w-4" />} text={timeText(value)} width={176} className="w-[8.5rem]">
      {(close) => (
        <TimeList
          value={value}
          onPick={(v) => {
            onChange(v);
            close();
          }}
        />
      )}
    </Picker>
  );
}

function TimeList({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const times = useMemo(() => Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`), []);
  // Open on the chosen time (or the quarter hour before it).
  const near = times[Math.min(95, Math.floor((Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))) / 15))];
  useLayoutEffect(() => {
    const el = list.current;
    const row = el?.querySelector<HTMLElement>("[data-near]");
    if (el && row) el.scrollTop = row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2;
  }, []);
  return (
    <div className="flex flex-col gap-1.5 p-2">
      <TextInput
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const t = parseTime(text);
          if (t) onPick(t);
          else setBad(true);
        }}
        placeholder="Type a time"
        aria-label="Type a time"
        aria-invalid={bad}
        className={cn("!h-9 !text-sm", bad && "!border-[var(--danger)]")}
      />
      {bad && <p className="px-1 text-xs text-[var(--danger)]">Try something like 9:30 or 2pm.</p>}
      <div ref={list} role="listbox" aria-label="Times" className="promptly-scroll relative max-h-56 overflow-y-auto">
        {times.map((t) => (
          <button
            key={t}
            type="button"
            role="option"
            aria-selected={t === value}
            data-near={t === near ? "" : undefined}
            onClick={() => onPick(t)}
            className={cn(
              "flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm tabular-nums hover:bg-[var(--hover)]",
              t === value ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] font-semibold text-[var(--text)]" : "text-[var(--text)]",
            )}
          >
            {timeText(t)}
          </button>
        ))}
      </div>
    </div>
  );
}
