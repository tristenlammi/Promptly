import { ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, ItemButton, Page, Section, addDays, todayISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { MOODS, moodColor } from "./constants";
import { EntryCard, EntryReader, ReaderSheet } from "./EntryViews";
import { avgMood, byDay, fmtFullDay, fmtMonth } from "./lib";
import { editor } from "./store";
import type { JournalData } from "./types";

function monthGrid(ym: string, weekStartsOn: 0 | 1): (string | null)[] {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${ym}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function CalendarView({ item, isPhone, ask }: ItemViewProps<JournalData>) {
  const data = item.data;
  const today = todayISO();
  const [ym, setYm] = useState(today.slice(0, 7));
  const [day, setDay] = useState<string>(today);
  const [reading, setReading] = useState<string | null>(null);
  const wso = (data.settings.week_starts_on ?? 1) as 0 | 1;

  const days = useMemo(() => byDay(data.entries), [data.entries]);
  const cells = useMemo(() => monthGrid(ym, wso), [ym, wso]);
  const heads = wso === 1 ? ["M", "T", "W", "T", "F", "S", "S"] : ["S", "M", "T", "W", "T", "F", "S"];
  const monthEntries = useMemo(() => data.entries.filter((e) => e.date.startsWith(ym)), [data.entries, ym]);
  const monthMood = avgMood(monthEntries);
  const monthDays = new Set(monthEntries.map((e) => e.date)).size;
  const selected = days.get(day) ?? [];
  const monthDist = useMemo(() => MOODS.map((m) => ({ ...m, n: monthEntries.filter((e) => e.mood === m.value).length })), [monthEntries]);
  const monthMoodN = monthDist.reduce((a, b) => a + b.n, 0);

  const grid = (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <button type="button" aria-label="Previous month" onClick={() => setYm(shiftMonth(ym, -1))} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="text-center">
          <h2 className="text-base font-semibold text-[var(--text)]">{fmtMonth(ym)}</h2>
          <p className="text-xs tabular-nums text-[var(--text-muted)]">
            {monthDays} {monthDays === 1 ? "day" : "days"} written{monthMood ? ` · mood ${monthMood.toFixed(1)}` : ""}
          </p>
        </div>
        <button type="button" aria-label="Next month" onClick={() => setYm(shiftMonth(ym, 1))} disabled={ym >= today.slice(0, 7)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1.5 text-center" role="grid" aria-label={fmtMonth(ym)}>
        {heads.map((h, i) => (
          <span key={i} className="pb-1 text-[11px] font-medium text-[var(--text-muted)]" aria-hidden>
            {h}
          </span>
        ))}
        {cells.map((c, i) => {
          if (!c) return <span key={i} />;
          const list = days.get(c);
          const avg = list ? avgMood(list) : null;
          const fill = avg ? moodColor(avg) : null;
          const isToday = c === today;
          const isSel = c === day;
          const future = c > today;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setDay(c)}
              disabled={future}
              aria-label={`${fmtFullDay(c)}${list ? `, ${list.length} ${list.length === 1 ? "entry" : "entries"}` : ""}${avg ? `, mood ${avg.toFixed(1)}` : ""}`}
              aria-pressed={isSel}
              className={cn(
                "relative flex aspect-square min-h-[40px] flex-col items-center justify-center rounded-xl text-sm tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:opacity-35",
                isSel && "ring-2 ring-[var(--item-accent)] ring-offset-1 ring-offset-[var(--surface)]",
                !fill && "hover:bg-[var(--hover)]",
                isToday ? "font-bold" : "font-medium",
              )}
              style={fill ? { background: `color-mix(in srgb, ${fill} 42%, var(--surface))`, color: "var(--text)" } : { color: list ? "var(--text)" : "var(--text-muted)" }}
            >
              {Number(c.slice(8))}
              {list && !avg && <span className="absolute bottom-1.5 h-1 w-1 rounded-full bg-[var(--item-accent-fill)]" aria-hidden />}
              {list && list.length > 1 && <span className="absolute right-1 top-0.5 text-[9px] font-semibold opacity-60">{list.length}</span>}
              {isToday && <span className="absolute bottom-1 h-0.5 w-3 rounded-full bg-[var(--text)] opacity-60" aria-hidden />}
            </button>
          );
        })}
      </div>
      {monthMoodN > 0 && (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]" role="img" aria-label={`Moods this month: ${monthDist.filter((m) => m.n).map((m) => `${m.n} ${m.label}`).join(", ")}`}>
          {monthDist
            .slice()
            .reverse()
            .filter((m) => m.n)
            .map((m) => (
              <span key={m.value} style={{ width: `${(m.n / monthMoodN) * 100}%`, background: m.color }} title={`${m.label}: ${m.n}`} />
            ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
        {MOODS.map((m) => (
          <span key={m.value} className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.color }} aria-hidden /> {m.label}
          </span>
        ))}
      </div>
      {!isPhone && <p className="text-center text-[11px] text-[var(--text-muted)]">← → ↑ ↓ to move · Enter to open</p>}
      {ym !== today.slice(0, 7) && (
        <button type="button" onClick={() => { setYm(today.slice(0, 7)); setDay(today); }} className="self-center text-xs font-medium text-[var(--item-accent)]">
          Back to today
        </button>
      )}
    </Card>
  );

  const dayPanel = (
    <Section
      title={fmtFullDay(day)}
      action={
        item.canEdit && day <= today ? (
          <ItemButton size="sm" variant="primary" icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => editor.open({ date: day })}>
            {selected.length ? "Add" : "Write"}
          </ItemButton>
        ) : undefined
      }
    >
      {selected.length ? (
        <div className="flex flex-col gap-2">
          {selected.map((e) => (
            <EntryCard key={e.id} entry={e} hidePreview={data.settings.hide_previews} onOpen={() => setReading(e.id)} />
          ))}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
          {day === today ? "Nothing yet today." : "No entry this day — you can still write one looking back."}
        </p>
      )}
    </Section>
  );

  // Desktop: arrow keys move the day (← → a day, ↑ ↓ a week), Enter writes.
  useEffect(() => {
    if (isPhone) return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (editor.get() || document.querySelector('[role="dialog"]') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
      if (step) {
        ev.preventDefault();
        const next = addDays(day, step);
        if (next > today) return;
        setDay(next);
        setYm(next.slice(0, 7));
      } else if (ev.key === "Enter" && item.canEdit && t?.tagName !== "BUTTON") {
        ev.preventDefault();
        editor.open(selected.length ? { entryId: selected[0].id } : { date: day });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, day, today, selected, item.canEdit]);

  const deskDay = (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">{fmtFullDay(day)}</h2>
        {item.canEdit && day <= today && (
          <ItemButton size="sm" variant={selected.length ? "secondary" : "primary"} icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => editor.open({ date: day })}>
            {selected.length ? "Add an entry" : "Write"}
          </ItemButton>
        )}
      </div>
      {selected.length ? (
        selected.map((e, i) => (
          <Card key={e.id} className={cn("px-6 py-5", i > 0 && "mt-1")}>
            <EntryReader entry={e} item={item} ask={ask} />
          </Card>
        ))
      ) : (
        <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--text-muted)]">
          {day === today ? "Nothing yet today." : "No entry this day — you can still write one looking back."}
        </p>
      )}
    </div>
  );

  return (
    <Page wide>
      {isPhone ? (
        <>
          {grid}
          {dayPanel}
          <div className="h-16" aria-hidden />
        </>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.2fr)]">
          <div className="lg:sticky lg:top-0">{grid}</div>
          {deskDay}
        </div>
      )}
      <ReaderSheet entryId={reading} onClose={() => setReading(null)} item={item} ask={ask} />
    </Page>
  );
}
