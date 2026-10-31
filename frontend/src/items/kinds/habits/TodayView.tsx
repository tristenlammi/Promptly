import { ChevronLeft, ChevronRight, CircleCheckBig, Keyboard, MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, IconButton, ItemButton, Page, ProgressRing, fmtDay, nowISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { HabitDetail } from "./HabitDetail";
import { useHabitTools, useToday, useWidth } from "./hooks";
import { CheckButton, Confetti, HabitBadge, StreakBadge, useLongPress } from "./parts";
import { WEEKDAYS, dayState, describeGoal, dn, ds, fmtN, habitStats, isFlexible, perfectDays, wd, weekStartOf, type DayState, type HabitStats } from "./engine";
import type { Habit, HabitsData, TimeOfDay } from "./types";
import { IDEAS, TIMES, applyTap, buzz, getLog, habitFromIdea, habitLabel, tapIntent, undoTap } from "./util";

interface Row {
  habit: Habit;
  state: DayState;
  stats: HabitStats;
}

function currentSlot(): TimeOfDay {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function subtitle(r: Row): string {
  const { habit: h, state: s } = r;
  if (s.skipped) return `Skipped${s.log?.reason ? ` · ${s.log.reason}` : ""}`;
  if (s.failed) return `${fmtN(s.value)} slip${s.value === 1 ? "" : "s"} — tomorrow's a fresh start`;
  const bits: string[] = [];
  if (h.active_timer) bits.push("⏱ Timer running");
  if (h.type === "count") bits.push(`${fmtN(s.value)} / ${fmtN(h.target)} ${h.unit || ""}`.trim());
  else if (h.type === "duration") bits.push(s.value ? `${fmtN(s.value)} / ${fmtN(h.target)} min` : `${fmtN(h.target)} min`);
  else if (h.type === "avoid") bits.push(s.done ? "Clean today ✓" : h.limit ? `At most ${h.limit}` : "Stay clean");
  if (s.period) bits.push(`${s.period.done} of ${s.period.required} this ${h.schedule.kind === "per_week" ? "week" : "month"}`);
  if (!bits.length || (h.type === "yes_no" && !s.period)) {
    if (h.intention) bits.push(h.intention);
  }
  return bits.join(" · ");
}

export function TodayView({ item, isPhone, ask }: ItemViewProps<HabitsData>) {
  const data = item.data;
  const ws = data.settings.week_start;
  const today = useToday(data.settings.day_ends_at);
  const [day, setDay] = useState(today);
  const [sel, setSel] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [confetti, setConfetti] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const tools = useHabitTools(item, today, ask);
  // Two columns (list + detail) only when there's room for both — the AI
  // side panel can leave the view phone-narrow on a desktop.
  const [wrapRef, width] = useWidth();
  const split = !isPhone && width >= 900;
  const t = dn(today);
  const n = dn(day);
  const celebrate = data.settings.celebrate;

  // Follow the day rolling over.
  const lastToday = useRef(today);
  useEffect(() => {
    if (lastToday.current !== today) {
      if (day === lastToday.current) setDay(today);
      lastToday.current = today;
    }
  }, [today, day]);

  const active = useMemo(() => data.habits.filter((h) => !h.archived), [data.habits]);
  const rows: Row[] = useMemo(
    () =>
      active.map((h) => {
        const stats = habitStats(h, t, ws);
        return { habit: h, stats, state: dayState(h, n, t, ws, stats.logs) };
      }),
    [active, t, n, ws],
  );
  const [dueRows, otherRows] = useMemo(() => {
    const due = rows.filter((r) => r.state.due || r.state.done || r.state.skipped || r.state.failed);
    return [due, rows.filter((r) => !due.includes(r))];
  }, [rows]);
  // The day's ring: day-based habits due today, plus flexible (× a week)
  // ones done today or with no slack left — an open weekly target with
  // spare days isn't "to go" today.
  const counted = dueRows.filter((r) => {
    if (r.state.skipped) return false;
    if (!isFlexible(r.habit) || r.state.done) return true;
    const p = r.state.period;
    return !!p && p.status === "pending" && p.required - p.done >= p.left;
  });
  const doneCount = counted.filter((r) => r.state.done).length;
  const progress = counted.length ? doneCount / counted.length : 0;
  const perfect = useMemo(() => perfectDays(data.habits, t), [data.habits, t]);
  const allDone = counted.length > 0 && doneCount === counted.length;

  // Confetti when the day becomes perfect (not on load).
  const wasDone = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasDone.current === false && allDone && celebrate) {
      setConfetti((c) => c + 1);
      buzz([15, 60, 15, 60, 30]);
    }
    wasDone.current = allDone;
  }, [allDone, celebrate]);
  useEffect(() => {
    wasDone.current = null;
  }, [day]);

  const groups = useMemo(() => {
    const out: { id: TimeOfDay; label: string; rows: Row[] }[] = [];
    for (const tod of TIMES) {
      const rs = dueRows.filter((r) => r.habit.time_of_day === tod.id);
      if (rs.length) out.push({ id: tod.id, label: tod.label, rows: rs });
    }
    return out;
  }, [dueRows]);
  const flat = useMemo(() => [...groups.flatMap((g) => g.rows), ...(showOther ? otherRows : [])], [groups, otherRows, showOther]);

  const tap = useCallback(
    (h: Habit) => {
      if (!item.canEdit || day > today) return;
      const before = getLog(h, day);
      // Decide what the tap means from what's on screen; apply it relative
      // to the latest state (a +1 from two devices is +2, not +1).
      const { intent, completes, value } = tapIntent(h, day);
      if (intent !== "clear" && tools.full(h.id, day)) return;
      const at = nowISO();
      item.update((d) => applyTap(d, h.id, day, intent, at));
      if (completes && celebrate) buzz([10, 40, 16]);
      else buzz(8);
      const st = rows.find((r) => r.habit.id === h.id)?.stats;
      const streakNext = st && completes && day === today ? st.current + (isFlexible(h) ? 0 : 1) : 0;
      const text = completes
        ? `${habitLabel(h)} — done${streakNext > 1 ? ` · ${streakNext}-day streak 🔥` : ""}`
        : intent === "clear"
          ? `${habitLabel(h)} unchecked`
          : `${habitLabel(h)} · ${fmtN(value)} / ${fmtN(h.target)}`;
      tools.say(text, () => {
        const at2 = nowISO();
        item.update((d) => undoTap(d, h.id, day, intent, before, at2));
      });
    },
    [item, day, today, rows, tools, celebrate],
  );

  // Desktop: the selected habit, defaulting to the first.
  const selected = !isPhone ? rows.find((r) => r.habit.id === sel) ?? (split ? flat[0] ?? rows[0] : undefined) : undefined;

  // Keyboard shortcuts (desktop).
  useEffect(() => {
    if (isPhone) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (el && el.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return; // the focused button wins
      const idx = selected ? flat.findIndex((r) => r.habit.id === selected.habit.id) : -1;
      const move = (k: number) => {
        const next = flat[Math.max(0, Math.min(flat.length - 1, idx + k))];
        if (next) {
          setSel(next.habit.id);
          document.getElementById(`hb-row-${next.habit.id}`)?.scrollIntoView({ block: "nearest" });
        }
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "x":
        case " ":
          if (selected) {
            e.preventDefault();
            tap(selected.habit);
          }
          break;
        case "l":
        case "s":
          if (selected) tools.openLog(selected.habit.id, day);
          break;
        case "e":
          if (selected) tools.openEdit(selected.habit);
          break;
        case "n":
          tools.openNew();
          break;
        case "ArrowLeft":
        case "[":
          setDay((d) => ds(dn(d) - 1));
          break;
        case "ArrowRight":
        case "]":
          setDay((d) => (d < today ? ds(dn(d) + 1) : d));
          break;
        case "t":
          setDay(today);
          break;
        case "u":
        case "z":
          item.undo();
          break;
        case "?":
          setShortcuts((s) => !s);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, flat, selected, tap, tools, day, today, item]);

  // ---------------------------------------------------------------- empty
  if (!active.length) {
    return (
      <Page>
        <EmptyState
          icon={CircleCheckBig}
          title={data.habits.length ? "Every habit is archived" : "Start with one tiny habit"}
          text="Small and anchored beats big and vague. Pick an idea, make your own, or let the coach design a routine with you."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={tools.openNew}>
                  New habit
                </ItemButton>
                <ItemButton icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask("Help me pick 1–3 tiny habits to start with. Ask me one question first.")}>
                  Design with the coach
                </ItemButton>
              </div>
            )
          }
        />
        {item.canEdit && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {IDEAS.slice(0, 9).map((idea) => (
              <Card
                key={idea.name}
                className="flex items-center gap-2 !p-3"
                onClick={() => {
                  // Built outside the mutator (ids / times), pushed inside.
                  const made = habitFromIdea(data, idea);
                  item.update((d) => {
                    if (!d.habits.some((x) => x.id === made.id)) d.habits.push(structuredClone(made));
                    d.settings.onboarded = true;
                  });
                  tools.say(`Added ${idea.emoji} ${idea.name}`);
                }}
              >
                <span className="text-xl" aria-hidden>
                  {idea.emoji}
                </span>
                <span className="min-w-0 truncate text-sm font-medium text-[var(--text)]">{idea.name}</span>
              </Card>
            ))}
          </div>
        )}
        {tools.element}
      </Page>
    );
  }

  const slot = currentSlot();
  const toGo = counted.length - doneCount;

  const list = (
    <div className="flex flex-col gap-4">
      {/* Day header: progress, the date and the week at a glance. */}
      <Card className={cn("flex flex-col gap-3 !p-3 sm:!p-4", allDone && "hb-glow")}>
        <div className="flex items-center gap-4 px-1">
          <ProgressRing value={progress} size={60} stroke={6}>
            <span className="text-sm tabular-nums">
              {doneCount}/{counted.length}
            </span>
          </ProgressRing>
          <div className="min-w-0 flex-1" aria-live="polite">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{longDate(day)}</p>
            <p className="text-lg font-semibold leading-snug text-[var(--text)]">
              {counted.length === 0
                ? "A free day"
                : allDone
                  ? day === today
                    ? "Perfect day 🎉"
                    : "Every habit done"
                  : day === today
                    ? `${toGo} to go${toGo === 1 ? " — nearly there" : ""}`
                    : `${doneCount} of ${counted.length} done`}
            </p>
            <p className="truncate text-xs text-[var(--text-muted)]">
              {counted.length === 0
                ? "Nothing scheduled."
                : perfect.current > 1 && day === today
                  ? <span className="text-[var(--item-accent)]">{perfect.current} perfect days in a row</span>
                  : `${Math.round(progress * 100)}% complete`}
            </p>
          </div>
          {day !== today && (
            <ItemButton size="sm" onClick={() => setDay(today)}>
              Today
            </ItemButton>
          )}
        </div>
        <div className="border-t border-[var(--border)] pt-2">
          <WeekStrip data={data} rows={rows} day={day} today={today} onPick={setDay} weekStart={ws} ring={isPhone ? 30 : 36} />
        </div>
      </Card>

      {/* Groups */}
      {groups.length === 0 && (
        <p className="px-1 text-sm text-[var(--text-muted)]">Nothing due {day === today ? "today" : "this day"}. Enjoy it — or log something below.</p>
      )}
      {groups.map((g) => (
        <section key={g.id} className="flex flex-col gap-2" aria-label={g.label}>
          <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {g.label}
            {day === today && g.id === slot && <span className="rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-[var(--item-accent)]">now</span>}
            <span className="ml-auto font-normal normal-case tracking-normal tabular-nums">
              {g.rows.filter((r) => r.state.done).length}/{g.rows.filter((r) => counted.includes(r)).length}
            </span>
          </h3>
          <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {g.rows.map((r, i) => (
              <HabitRow
                key={r.habit.id}
                row={r}
                divider={i > 0}
                selected={!isPhone && selected?.habit.id === r.habit.id}
                onTap={() => tap(r.habit)}
                onMore={() => tools.openLog(r.habit.id, day)}
                onSelect={() => (split ? setSel(r.habit.id) : tools.openLog(r.habit.id, day))}
                canEdit={item.canEdit && day <= today}
                celebrate={celebrate}
                showRisk={day === today}
              />
            ))}
          </div>
        </section>
      ))}

      {otherRows.length > 0 && (
        <section className="flex flex-col gap-2">
          <button type="button" onClick={() => setShowOther((s) => !s)} aria-expanded={showOther} className="flex items-center gap-2 px-1 text-left text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text)]">
            Not due {day === today ? "today" : "this day"} ({otherRows.length})
            <ChevronRight className={cn("h-3.5 w-3.5 transition", showOther && "rotate-90")} />
          </button>
          {showOther && (
            <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] opacity-90">
              {otherRows.map((r, i) => (
                <HabitRow
                  key={r.habit.id}
                  row={r}
                  divider={i > 0}
                  selected={!isPhone && selected?.habit.id === r.habit.id}
                  onTap={() => tap(r.habit)}
                  onMore={() => tools.openLog(r.habit.id, day)}
                  onSelect={() => (split ? setSel(r.habit.id) : tools.openLog(r.habit.id, day))}
                  canEdit={item.canEdit && day <= today}
                  celebrate={celebrate}
                  showRisk={false}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {item.canEdit && (
          <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={tools.openNew}>
            New habit
          </ItemButton>
        )}
        <ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => ask("Which of my habits are at risk today, and what's the tiniest way to keep each one going?")}>
          What's at risk today?
        </ItemButton>
        {!isPhone && (
          <ItemButton size="sm" variant="ghost" icon={<Keyboard className="h-3.5 w-3.5" />} onClick={() => setShortcuts((s) => !s)}>
            Shortcuts
          </ItemButton>
        )}
      </div>
      {shortcuts && !isPhone && (
        <Card className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[var(--text-muted)]">
          {[
            ["j / k  ↑ ↓", "Move"],
            ["Space / x", "Check off"],
            ["l", "Log details · skip"],
            ["e", "Edit habit"],
            ["n", "New habit"],
            ["← →  [ ]", "Previous / next day"],
            ["t", "Back to today"],
            ["u", "Undo"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <kbd className="font-mono text-[var(--text)]">{k}</kbd>
              <span>{v}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );

  return (
    <Page wide={!isPhone}>
      <div ref={wrapRef} className="min-w-0">
      {!split ? (
        <div className="mx-auto w-full max-w-2xl">{list}</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-6">
          <div className="min-w-0">{list}</div>
          <aside className="min-w-0" aria-label="Selected habit">
            <div className="sticky top-4">
              {selected ? (
                <Card className="max-h-[calc(100vh-170px)] overflow-y-auto !p-5">
                  <HabitDetail
                    habit={selected.habit}
                    data={data}
                    today={today}
                    compact
                    onEdit={item.canEdit ? () => tools.openEdit(selected.habit) : undefined}
                    onOpenDay={(d) => tools.openLog(selected.habit.id, d)}
                    ask={ask}
                  />
                </Card>
              ) : null}
            </div>
          </aside>
        </div>
      )}
      </div>
      <Confetti run={confetti} />
      {tools.element}
    </Page>
  );
}

const longFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
function longDate(day: string): string {
  return longFmt.format(new Date(`${day}T12:00:00`));
}

function HabitRow({
  row,
  divider,
  selected,
  onTap,
  onMore,
  onSelect,
  canEdit,
  celebrate,
  showRisk,
}: {
  row: Row;
  divider: boolean;
  selected: boolean;
  onTap: () => void;
  onMore: () => void;
  onSelect: () => void;
  canEdit: boolean;
  celebrate: boolean;
  showRisk: boolean;
}) {
  const { habit: h, state: s, stats } = row;
  const press = useLongPress(onTap, onMore);
  const risk = showRisk && !s.done && !s.skipped && !s.failed && s.due && stats.missedYesterday;
  const streakHot = stats.current >= 7;
  const label = `${h.name}: ${s.done ? "done — tap to undo" : h.type === "count" ? `add one (${fmtN(s.value)} of ${fmtN(h.target)})` : "mark done"}. Hold for more.`;
  return (
    <div
      id={`hb-row-${h.id}`}
      className={cn(
        "hb-row flex items-center gap-3 px-3 py-2.5",
        divider && "border-t border-[var(--border)]",
        selected && "bg-[var(--hover)]",
        s.done && "hb-row-done",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-[48px] min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
      >
        <HabitBadge habit={h} size={40} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn("hb-title truncate text-[15px] font-medium", s.done ? "text-[var(--text-muted)]" : "text-[var(--text)]")}>{h.name}</span>
            <StreakBadge n={stats.current} unit={stats.unit} hot={streakHot} />
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">
            {risk ? <span className="font-medium text-[var(--warning)]">Missed yesterday — never miss twice</span> : subtitle(row) || describeGoal(h)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`More for ${h.name}`}
        onClick={onMore}
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] md:flex"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <CheckButton habit={h} state={s} size={52} label={label} handlers={press} celebrate={celebrate} disabled={!canEdit} />
    </div>
  );
}

function WeekStrip({
  data,
  rows,
  day,
  today,
  onPick,
  weekStart,
  ring = 30,
}: {
  ring?: number;
  data: HabitsData;
  rows: Row[];
  day: string;
  today: string;
  onPick: (d: string) => void;
  weekStart: number;
}) {
  const t = dn(today);
  const [anchor, setAnchor] = useState(() => weekStartOf(dn(day), weekStart));
  useEffect(() => setAnchor(weekStartOf(dn(day), weekStart)), [day, weekStart]);
  const cells = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const n = anchor + i;
        let due = 0;
        let done = 0;
        if (n <= t) {
          for (const r of rows) {
            const s = dayState(r.habit, n, t, data.settings.week_start, r.stats.logs);
            if ((s.due || s.done || s.failed) && !s.skipped) {
              due++;
              if (s.done) done++;
            }
          }
        }
        return { n, due, done };
      }),
    [anchor, rows, t, data.settings.week_start],
  );
  return (
    <div className="flex items-center gap-1">
      <IconButton label="Previous week" icon={ChevronLeft} onClick={() => setAnchor((a) => a - 7)} />
      <div className="grid flex-1 grid-cols-7 gap-1">
        {cells.map((c) => {
          const future = c.n > t;
          const on = ds(c.n) === day;
          const f = c.due ? c.done / c.due : 0;
          return (
            <button
              key={c.n}
              type="button"
              disabled={future}
              onClick={() => onPick(ds(c.n))}
              aria-label={`${fmtDay(ds(c.n))}: ${c.done} of ${c.due} done`}
              aria-pressed={on}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl py-1.5 transition disabled:opacity-35",
                on ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "hover:bg-[var(--hover)]",
              )}
            >
              <span className={cn("text-[10px] font-medium", c.n === t ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{WEEKDAYS[wd(c.n)].slice(0, 1)}</span>
              <ProgressRing value={future ? 0 : f} size={ring} stroke={3.5}>
                <span className={cn(ring > 30 ? "text-xs" : "text-[11px]", f >= 1 && "text-[var(--item-accent)]")}>{Number(ds(c.n).slice(8))}</span>
              </ProgressRing>
            </button>
          );
        })}
      </div>
      <IconButton label="Next week" icon={ChevronRight} onClick={() => setAnchor((a) => a + 7)} disabled={anchor + 7 > t} />
    </div>
  );
}
