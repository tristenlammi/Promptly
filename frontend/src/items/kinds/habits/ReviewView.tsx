import { ChevronLeft, ChevronRight, NotebookPen, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ItemViewProps } from "@/items/types";
import { Card, Chip, EmptyState, Field, IconButton, ItemButton, Page, ProgressBar, Section, Stat, StatGrid, TextArea, fmtDay, nowISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { dayStatuses, dn, ds, isFlexible, isMet, logMap, periods, perfectDays, startOf, weekStartOf } from "./engine";
import { useHabitTools, useToday, useWidth } from "./hooks";
import { HabitBadge } from "./parts";
import type { Habit, HabitsData, Review } from "./types";
import { pct } from "./util";

interface WeekRow {
  habit: Habit;
  done: number;
  expected: number | null;
  rate: number | null;
  pending: boolean;
  slips: number;
  skipped: number;
  notes: { day: string; note: string }[];
}

function weekSummary(data: HabitsData, wk: number, t: number, ws: number) {
  const last = Math.min(wk + 6, t);
  const rows: WeekRow[] = [];
  for (const h of data.habits) {
    if (h.archived) continue;
    const start = startOf(h);
    if (start === null || start > last) continue;
    const logs = logMap(h);
    let skipped = 0;
    let slips = 0;
    const notes: { day: string; note: string }[] = [];
    for (let n = wk; n <= wk + 6; n++) {
      const l = logs.get(n);
      if (!l) continue;
      if (l.skipped) skipped++;
      else if (h.type === "avoid") slips += l.value;
      if (l.note) notes.push({ day: ds(n), note: l.note });
    }
    let done = 0;
    let expected: number | null = null;
    let pending = false;
    if (isFlexible(h)) {
      for (let n = Math.max(wk, start); n <= last; n++) if (isMet(h, logs.get(n), n, t)) done++;
      if (h.schedule.kind === "per_week") {
        const p = periods(h, last, ws, logs).find((x) => x.start <= last && x.end >= wk);
        if (p) {
          expected = p.required;
          pending = p.status === "pending";
        }
      }
    } else {
      let missed = 0;
      for (const { n, s } of dayStatuses(h, last, logs)) {
        if (n < wk) continue;
        if (s === "done") done++;
        else if (s === "missed") missed++;
        else if (s === "pending") pending = true;
      }
      expected = done + missed + (pending ? 1 : 0);
    }
    const rate = expected ? Math.min(1, done / expected) : null;
    rows.push({ habit: h, done, expected, rate, pending, slips, skipped, notes });
  }
  const exp = rows.reduce((a, r) => a + (r.expected ?? 0), 0);
  const got = rows.reduce((a, r) => a + (r.expected ? Math.min(r.done, r.expected) : 0), 0);
  return { rows, rate: exp ? got / exp : null };
}

const rangeFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function ReviewView({ item, isPhone, ask }: ItemViewProps<HabitsData>) {
  const data = item.data;
  const ws = data.settings.week_start;
  const today = useToday(data.settings.day_ends_at);
  const tools = useHabitTools(item, today, ask);
  const [wrapRef, width] = useWidth();
  const twoCol = !isPhone && width >= 900;
  const t = dn(today);
  const thisWeek = weekStartOf(t, ws);
  const [wk, setWk] = useState(thisWeek);
  const week = ds(wk);
  const sum = useMemo(() => weekSummary(data, wk, t, ws), [data, wk, t, ws]);
  const prev = useMemo(() => weekSummary(data, wk - 7, t, ws), [data, wk, t, ws]);
  const perfect = useMemo(() => perfectDays(data.habits, t), [data.habits, t]);
  let perfectInWeek = 0;
  for (let n = wk; n <= wk + 6; n++) if (perfect.days.has(n)) perfectInWeek++;
  const review = data.reviews.find((r) => r.week === week);
  const [draft, setDraft] = useState<Pick<Review, "wins" | "misses" | "notes" | "focus">>({ wins: "", misses: "", notes: "", focus: "" });
  useEffect(() => {
    setDraft({ wins: review?.wins ?? "", misses: review?.misses ?? "", notes: review?.notes ?? "", focus: review?.focus ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, review?.updated_at]);

  const saveField = (k: keyof typeof draft) => {
    if ((review?.[k] ?? "") === draft[k]) return;
    const v = draft[k];
    const at = nowISO();
    item.update((d) => {
      let r = d.reviews.find((x) => x.week === week);
      if (!r) {
        r = { week, wins: "", misses: "", notes: "", focus: "", insights: "", updated_at: "" };
        d.reviews.push(r);
        d.reviews.sort((a, b) => (a.week < b.week ? -1 : 1));
      }
      r[k] = v;
      r.updated_at = at;
    });
  };

  const wins = sum.rows.filter((r) => r.rate !== null && r.rate >= 1 && !r.pending);
  const care = sum.rows.filter((r) => r.rate !== null && r.rate < 0.6 && !r.pending);
  const allNotes = sum.rows.flatMap((r) => r.notes.map((n) => ({ ...n, habit: r.habit }))).sort((a, b) => (a.day < b.day ? -1 : 1));
  const delta = sum.rate !== null && prev.rate !== null ? Math.round((sum.rate - prev.rate) * 100) : null;
  const label = `${rangeFmt.format(new Date(`${week}T12:00:00`))} – ${rangeFmt.format(new Date(`${ds(wk + 6)}T12:00:00`))}`;
  const pastReviews = [...data.reviews].reverse().filter((r) => r.week !== week && (r.wins || r.misses || r.notes || r.insights || r.focus));
  const askReview = () =>
    ask(
      `Review my habits for the week of ${week}: use weekly_review_data, celebrate the wins, be curious (not judgemental) about the misses, spot one pattern, and suggest one tiny tweak. Save it with write_review as insights.`,
    );

  if (!data.habits.length) {
    return (
      <Page>
        <EmptyState icon={NotebookPen} title="Weekly reviews" text="Once you're tracking habits, a two-minute review each week keeps them on course — wins, what got in the way, one tweak." />
      </Page>
    );
  }

  const reflection = (
    <Section title="Your reflection">
      <Card className="flex flex-col gap-3">
        {(
          [
            ["wins", "What went well?", "Celebrate it — even the tiny ones."],
            ["misses", "What got in the way?", "Curious, not critical. What would make it easier?"],
            ["focus", "One focus for next week", "Shrink a habit, move it to a better anchor, plan a skip…"],
            ["notes", "Notes", ""],
          ] as const
        ).map(([k, l, ph]) => (
          <Field key={k} label={l}>
            <TextArea
              value={draft[k]}
              readOnly={!item.canEdit}
              placeholder={ph}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              onBlur={() => saveField(k)}
              className="min-h-[64px]"
              maxLength={k === "notes" ? 5000 : 3000}
            />
          </Field>
        ))}
      </Card>
    </Section>
  );

  const insights = (
    <Section title="Coach's insights" action={<ItemButton size="sm" icon={<Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={askReview}>{review?.insights ? "Refresh" : "Review my week"}</ItemButton>}>
      <Card>
        {review?.insights ? (
          <div className="prose prose-sm max-w-none text-sm text-[var(--text)] [&_li]:my-0.5 [&_p]:my-1.5 [&_strong]:text-[var(--text)] [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{review.insights}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">Ask the coach to look at this week's numbers and your notes — you'll get your wins, one pattern and one tiny tweak, written here.</p>
        )}
      </Card>
    </Section>
  );

  return (
    <Page wide={!isPhone}>
      <div className="flex items-center gap-2">
        <IconButton label="Previous week" icon={ChevronLeft} onClick={() => setWk((w) => w - 7)} />
        <div className="min-w-0 flex-1 text-center">
          <p className="text-base font-semibold text-[var(--text)]">{wk === thisWeek ? "This week" : wk === thisWeek - 7 ? "Last week" : "Week"}</p>
          <p className="text-xs text-[var(--text-muted)]">{label}</p>
        </div>
        <IconButton label="Next week" icon={ChevronRight} onClick={() => setWk((w) => w + 7)} disabled={wk >= thisWeek} />
      </div>

      <StatGrid>
        <Stat label="Completion" value={pct(sum.rate)} tone="accent" delta={delta === null ? undefined : `${delta >= 0 ? "+" : ""}${delta} pts vs the week before`} />
        <Stat label="Perfect days" value={perfectInWeek} unit="/ 7" />
        <Stat label="Wins" value={wins.length} delta={wins.length ? "habits fully on track" : undefined} />
        <Stat label="Notes logged" value={allNotes.length} />
      </StatGrid>

      <div ref={wrapRef} className={cn("grid gap-5", twoCol && "grid-cols-2")}>
        <div className="flex min-w-0 flex-col gap-5">
          <Section title="Habit by habit">
            <div className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              {sum.rows.map((r) => (
                <div key={r.habit.id} className="flex items-center gap-3 px-3 py-2.5">
                  <HabitBadge habit={r.habit} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-[var(--text)]">{r.habit.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                        {r.expected !== null ? `${r.done}/${r.expected}` : `${r.done}×`}
                        {r.habit.type === "avoid" && r.slips ? ` · ${r.slips} slip${r.slips === 1 ? "" : "s"}` : ""}
                        {r.skipped ? ` · ${r.skipped} skipped` : ""}
                      </span>
                    </div>
                    <ProgressBar value={r.rate ?? 0} color={r.habit.color} className="mt-1.5" />
                  </div>
                </div>
              ))}
            </div>
          </Section>
          {(wins.length > 0 || care.length > 0) && (
            <div className="flex flex-col gap-2">
              {wins.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--text-muted)]">Wins</span>
                  {wins.map((r) => (
                    <Chip key={r.habit.id} active>
                      {r.habit.emoji} {r.habit.name}
                    </Chip>
                  ))}
                </div>
              )}
              {care.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--text-muted)]">Needs a tweak</span>
                  {care.map((r) => (
                    <Chip key={r.habit.id} onClick={() => ask(`"${r.habit.name}" didn't go well this week (${r.done} of ${r.expected}). Help me redesign it to be easier — smaller, a better anchor, or a kinder schedule.`)}>
                      {r.habit.emoji} {r.habit.name}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )}
          {allNotes.length > 0 && (
            <Section title="What you noted">
              <Card className="flex flex-col gap-2">
                {allNotes.map((n) => (
                  <div key={`${n.habit.id}-${n.day}`} className="flex gap-3 text-sm">
                    <span className="w-24 shrink-0 text-xs text-[var(--text-muted)]">
                      {fmtDay(n.day)} · {n.habit.emoji || n.habit.name.slice(0, 8)}
                    </span>
                    <span className="min-w-0 flex-1 text-[var(--text)]">{n.note}</span>
                  </div>
                ))}
              </Card>
            </Section>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {insights}
          {reflection}
        </div>
      </div>

      {pastReviews.length > 0 && (
        <Section title="Past reviews">
          <div className="flex flex-col gap-2">
            {pastReviews.slice(0, 12).map((r) => (
              <Card key={r.week} onClick={() => setWk(dn(r.week))} className="!p-3">
                <p className="text-xs font-medium text-[var(--text-muted)]">Week of {rangeFmt.format(new Date(`${r.week}T12:00:00`))}</p>
                <p className="line-clamp-2 text-sm text-[var(--text)]">{r.focus ? `Focus: ${r.focus}` : r.wins || r.insights.replace(/[#*_>-]/g, "").slice(0, 200)}</p>
              </Card>
            ))}
          </div>
        </Section>
      )}
      {tools.element}
    </Page>
  );
}
