import { BarChart3, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, Chip, EmptyState, ItemButton, Page, ProgressRing, Section, Stat, StatGrid, fmtDay } from "@/items/ui";
import { Sparkline } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { HabitDetail } from "./HabitDetail";
import { useHabitTools, useToday, useWidth } from "./hooks";
import { dn, habitStats, overallLevels, perfectDays, streakUnit } from "./engine";
import { HabitBadge, StreakBadge } from "./parts";
import type { HabitsData } from "./types";
import { pct } from "./util";
import { FillHeatmap } from "./viz";

export function StatsView({ item, isPhone, ask }: ItemViewProps<HabitsData>) {
  const data = item.data;
  const today = useToday(data.settings.day_ends_at);
  const tools = useHabitTools(item, today, ask);
  const t = dn(today);
  const ws = data.settings.week_start;
  const [showArchived, setShowArchived] = useState(false);
  const habits = useMemo(() => data.habits.filter((h) => showArchived || !h.archived), [data.habits, showArchived]);
  const stats = useMemo(() => habits.map((h) => ({ h, s: habitStats(h, t, ws) })), [habits, t, ws]);
  const [sel, setSel] = useState<string | null>(null);
  // Overview + detail side by side only when both fit (not with the AI panel open).
  const [wrapRef, width] = useWidth();
  const split = !isPhone && width >= 900;
  const stacked = !split;
  const perfect = useMemo(() => perfectDays(data.habits, t), [data.habits, t]);
  const levels = useMemo(() => overallLevels(data, t, t - 7 * 53), [data, t]);
  const since = useMemo(() => {
    let first: string | null = null;
    for (const h of data.habits) {
      const d = h.logs[0]?.day && (!h.start_date || h.logs[0].day < h.start_date) ? h.logs[0].day : h.start_date;
      if (d && (!first || d < first)) first = d;
    }
    return first;
  }, [data.habits]);
  const rates = stats.map((x) => x.s.rate30).filter((r): r is number => r !== null);
  const avg30 = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const best = stats.reduce((m, x) => Math.max(m, x.s.best), 0);

  if (!data.habits.length) {
    return (
      <Page>
        <EmptyState icon={BarChart3} title="No stats yet" text="Add a habit and check it off for a few days — streaks, strength and patterns appear here." />
      </Page>
    );
  }

  const selected = stats.find((x) => x.h.id === sel) ?? (stacked ? undefined : stats[0]);

  const detail = selected && (
    <HabitDetail
      habit={selected.h}
      data={data}
      today={today}
      onBack={stacked ? () => setSel(null) : undefined}
      onEdit={item.canEdit ? () => tools.openEdit(selected.h) : undefined}
      onOpenDay={(d) => tools.openLog(selected.h.id, d)}
      ask={ask}
    />
  );

  if (stacked && sel && selected) {
    return (
      <Page>
        <div ref={wrapRef} className="min-w-0">
          {detail}
        </div>
        {tools.element}
      </Page>
    );
  }

  const overview = (
    <div className="flex flex-col gap-5">
      <StatGrid className={cn(split && "md:!grid-cols-2")}>
        <Stat label="Perfect days" value={perfect.total} delta={`${perfect.last30} in the last 30`} tone="accent" />
        <Stat label="Perfect-day run" value={perfect.current} unit={perfect.current === 1 ? "day" : "days"} delta={`Best ${perfect.best}`} />
        <Stat label="Last 30 days" value={pct(avg30)} delta="Average completion" />
        <Stat label="Longest streak" value={best} delta={`${habits.filter((h) => !h.archived).length} active habits`} />
      </StatGrid>
      <Section title="Every habit, every day" hint="Darker = more of the day's habits done">
        <Card>
          <FillHeatmap days={levels} today={today} weekStart={ws} since={since} maxWeeks={split ? 26 : 53} label={(d, l) => `${fmtDay(d)}: ${["nothing", "a little", "half", "most", "all"][l]} done`} />
        </Card>
      </Section>
      <Section
        title="Habits"
        action={
          data.habits.some((h) => h.archived) && (
            <Chip active={showArchived} onClick={() => setShowArchived((s) => !s)}>
              Archived
            </Chip>
          )
        }
      >
        <div className="flex flex-col gap-2">
          {stats.map(({ h, s }) => {
            const spark = s.series.slice(-60).filter((_, i) => i % 3 === 0).map((p) => p.v);
            return (
              <Card key={h.id} onClick={() => setSel(h.id)} className={cn("flex items-center gap-3 !p-3", split && selected?.h.id === h.id && "border-[var(--item-accent)]")}>
                <HabitBadge habit={h} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-[var(--text)]">{h.name}</span>
                    <StreakBadge n={s.current} unit={s.unit} hot={s.current >= 7} />
                  </div>
                  <p className="text-xs tabular-nums text-[var(--text-muted)]">
                    {pct(s.rate30)} last 30 d · best {s.best} {streakUnit(h, s.best)}
                  </p>
                </div>
                <Sparkline values={spark} width={56} height={22} color={h.color} />
                <ProgressRing value={s.score} size={40} stroke={4} color={h.color}>
                  <span className="text-[10px]">{Math.round(s.score * 100)}</span>
                </ProgressRing>
              </Card>
            );
          })}
        </div>
      </Section>
      <ItemButton icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask("Look at all my habit stats. What patterns do you see — strongest, weakest, weekday dips — and what one change would help most?")}>
        Find patterns in my stats
      </ItemButton>
    </div>
  );

  return (
    <Page wide={!isPhone}>
      <div ref={wrapRef} className="min-w-0">
      {stacked ? (
        <div className={cn(!isPhone && "mx-auto w-full max-w-2xl")}>{overview}</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6">
          <div className="min-w-0">{overview}</div>
          <div className="min-w-0">{detail && <Card className="!p-5">{detail}</Card>}</div>
        </div>
      )}
      </div>
      {tools.element}
    </Page>
  );
}
