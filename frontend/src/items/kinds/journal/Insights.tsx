import { BarChart3, Flame, PenLine, Smile, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, ItemButton, Page, Section, Segmented, Stat, StatGrid, addDays, parseDay, todayISO, weekStart } from "@/items/ui";
import { Bars, Heatmap } from "@/items/ui/charts";

import { EMOTION_FAMILIES, FAMILY_OF, MOODS, WEEKDAYS, moodColor, moodInfo } from "./constants";
import { avgMood, familyCounts, streaks } from "./lib";
import { editor } from "./store";
import type { Entry, JournalData } from "./types";

type RangeId = "30" | "90" | "365" | "all";

const short = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const monthShort = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });

function HBar({ label, value, max, color, note }: { label: React.ReactNode; value: number; max: number; color: string; note?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 truncate text-[var(--text)]">{label}</span>
      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${max ? (value / max) * 100 : 0}%`, background: color }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)]">{note ?? value}</span>
    </div>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Mood over time as Daylio/Reflectly draw it: one mood-coloured dot per day
 * (or week) at its true height, and a calm rolling-average line — instead
 * of a smoothed curve that swings wildly between sparse days.
 */
function MoodChart({ points, from, to, height = 200 }: { points: { day: string; y: number }[]; from: string; to: string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const t0 = parseDay(from).getTime();
  const span = Math.max(1, parseDay(to).getTime() - t0);
  const X = (d: string) => padL + ((parseDay(d).getTime() - t0) / span) * Math.max(1, w - padL - padR);
  const Y = (v: number) => padT + ((5 - v) / 4) * (height - padT - padB);
  // Rolling mean over the last 7 points (each point is a day or a week).
  const avg = points.map((p, i) => {
    const win = points.slice(Math.max(0, i - 6), i + 1);
    return { day: p.day, y: win.reduce((a, b) => a + b.y, 0) / win.length };
  });
  const path = avg.map((p, i) => `${i ? "L" : "M"}${X(p.day).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const d = new Date(t0 + f * span);
    return { x: padL + f * Math.max(1, w - padL - padR), label: short.format(d) };
  });
  const r = points.length > 120 ? 2.5 : points.length > 45 ? 3.5 : 4.5;
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`Mood over time, ${points.length} points, recent average ${avg.length ? avg[avg.length - 1].y.toFixed(1) : "–"} of 5`}>
          {[1, 2, 3, 4, 5].map((v) => (
            <g key={v}>
              <line x1={padL} x2={w - padR} y1={Y(v)} y2={Y(v)} stroke="var(--border)" strokeDasharray={v === 3 ? undefined : "2 4"} />
              <circle cx={12} cy={Y(v)} r={4} fill={MOODS[v - 1].color} opacity={0.9} />
            </g>
          ))}
          {path && <path d={path} fill="none" stroke="var(--text)" strokeOpacity={0.55} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {points.map((p) => (
            <circle key={p.day} cx={X(p.day)} cy={Y(p.y)} r={r} fill={moodColor(p.y)} stroke="var(--surface)" strokeWidth={1.5}>
              <title>{`${p.day}: ${p.y.toFixed(1)} (${moodInfo(p.y)?.label ?? ""})`}</title>
            </circle>
          ))}
          {ticks.map((t, i) => (
            <text key={i} x={t.x} y={height - 4} fontSize={11} fill="var(--text-muted)" textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
              {t.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Average mood per weekday on the 1–5 scale, each bar in its mood's colour. */
function WeekdayMood({ data }: { data: { x: string; y: number | null; n: number }[] }) {
  return (
    <div className="flex h-[176px] items-stretch gap-2" role="list" aria-label="Average mood by weekday">
      {data.map((d) => {
        const h = d.y ? ((d.y - 1) / 4) * 100 : 0;
        return (
          <div key={d.x} role="listitem" aria-label={`${d.x}: ${d.y ? `${d.y.toFixed(1)} of 5 over ${d.n} days` : "no moods"}`} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="text-xs font-semibold tabular-nums text-[var(--text)]">{d.y ? d.y.toFixed(1) : "–"}</span>
            <div className="relative w-full max-w-[40px] flex-1 overflow-hidden rounded-lg bg-[var(--surface-2)]">
              {d.y && <div className="absolute inset-x-0 bottom-0 rounded-lg" style={{ height: `${Math.max(6, h)}%`, background: moodColor(d.y) }} />}
            </div>
            <span className="text-[11px] font-medium text-[var(--text-muted)]">{d.x}</span>
          </div>
        );
      })}
    </div>
  );
}

export function InsightsView({ item, ask }: ItemViewProps<JournalData>) {
  const data = item.data;
  const today = todayISO();
  const [range, setRange] = useState<RangeId>("30");
  const start = range === "all" ? "0000-00-00" : addDays(today, -(Number(range) - 1));
  const entries = useMemo(() => data.entries.filter((e) => e.date >= start && e.date <= today), [data.entries, start, today]);
  const wso = (data.settings.week_starts_on ?? 1) as 0 | 1;

  const s = useMemo(() => {
    const words = entries.reduce((n, e) => n + e.word_count, 0);
    const mood = avgMood(entries);
    const byDate = new Map<string, Entry[]>();
    for (const e of entries) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    const long = range === "365" || range === "all";
    // Mood trend: daily for short ranges, weekly for long ones.
    const buckets = new Map<string, number[]>();
    for (const e of entries) {
      if (!e.mood) continue;
      const k = long ? weekStart(e.date, wso) : e.date;
      buckets.set(k, [...(buckets.get(k) ?? []), e.mood]);
    }
    const trend = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({ day: k, y: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 }));
    // Words: per week (short) or month (long).
    const wb = new Map<string, number>();
    for (const e of entries) {
      const k = long ? e.date.slice(0, 7) : weekStart(e.date, wso);
      wb.set(k, (wb.get(k) ?? 0) + e.word_count);
    }
    const wordsSeries = [...wb.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({ x: long ? monthShort.format(parseDay(`${k}-01`)) : short.format(parseDay(k)), y: v }));
    const dist = MOODS.map((m) => ({ ...m, n: entries.filter((e) => e.mood === m.value).length }));
    const wd = WEEKDAYS.map(() => [] as number[]);
    for (const [d, list] of byDate) {
      const a = avgMood(list);
      if (a) wd[(parseDay(d).getDay() + 6) % 7].push(a);
    }
    const order = wso === 1 ? [0, 1, 2, 3, 4, 5, 6] : [6, 0, 1, 2, 3, 4, 5];
    const weekday = order.map((i) => ({ x: WEEKDAYS[i], n: wd[i].length, y: wd[i].length ? Math.round((wd[i].reduce((a, b) => a + b, 0) / wd[i].length) * 100) / 100 : null }));
    const words2 = new Map<string, number>();
    for (const e of entries) for (const w of e.emotions) words2.set(w, (words2.get(w) ?? 0) + 1);
    const topWords = [...words2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const tagMap = new Map<string, Entry[]>();
    for (const e of entries) for (const t of e.tags) tagMap.set(t, [...(tagMap.get(t) ?? []), e]);
    const tags = [...tagMap.entries()].map(([t, list]) => ({ t, n: list.length, mood: avgMood(list) })).sort((a, b) => b.n - a.n).slice(0, 40);
    const heat: Record<string, number> = {};
    for (const e of data.entries) heat[e.date] = (heat[e.date] ?? 0) + e.word_count;
    for (const k of Object.keys(heat)) heat[k] = heat[k] >= 600 ? 4 : heat[k] >= 300 ? 3 : heat[k] >= 100 ? 2 : 1;
    return { words, mood, days: byDate.size, trend, wordsSeries, dist, weekday, topWords, tags, heat, families: familyCounts(entries) };
  }, [entries, range, wso, data.entries]);

  const streak = useMemo(() => streaks(data.entries, today), [data.entries, today]);

  if (data.entries.length === 0) {
    return (
      <Page>
        <EmptyState
          icon={BarChart3}
          title="Insights grow as you write"
          text="Check in with your mood and feelings when you write. After a week or two you'll see trends, what lifts you, and your writing rhythm."
          action={item.canEdit ? <ItemButton variant="primary" icon={<PenLine className="h-4 w-4" />} onClick={() => editor.open()}>Write today's entry</ItemButton> : undefined}
        />
      </Page>
    );
  }

  const maxDist = Math.max(1, ...s.dist.map((d) => d.n));
  const maxFam = Math.max(1, ...s.families.map((f) => f.n));
  const tagMax = Math.max(1, ...s.tags.map((t) => t.n));
  const moodTags = s.tags.filter((t) => t.n >= 2 && t.mood).sort((a, b) => (b.mood ?? 0) - (a.mood ?? 0));

  return (
    <Page wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[var(--text)]">Insights</h1>
        <Segmented<RangeId>
          value={range}
          onChange={setRange}
          size="sm"
          options={[
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "365", label: "Year" },
            { value: "all", label: "All" },
          ]}
        />
      </div>

      <StatGrid>
        <Stat label="Entries" value={entries.length.toLocaleString()} delta={`${s.days} days written`} icon={PenLine} />
        <Stat label="Words" value={s.words.toLocaleString()} delta={entries.length ? `${Math.round(s.words / entries.length)} per entry` : undefined} />
        <Stat label="Average mood" value={s.mood ? s.mood.toFixed(1) : "–"} unit="/ 5" delta={s.mood ? MOODS[Math.round(s.mood) - 1].label : "Add moods when you write"} icon={Smile} />
        <Stat label="Streak" value={streak.current} unit={streak.current === 1 ? "day" : "days"} delta={`Longest ${streak.longest}`} icon={Flame} tone="accent" />
      </StatGrid>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Mood over time" hint={`${range === "365" || range === "all" ? "Each week" : "Each day"}, with the running average`}>
          <Card>
            {s.trend.length >= 2 ? (
              <MoodChart points={s.trend} from={range === "all" ? s.trend[0].day : start} to={today} height={200} />
            ) : (
              <p className="py-10 text-center text-sm text-[var(--text-muted)]">Add a mood to a few entries to see the trend.</p>
            )}
          </Card>
        </Section>

        <Section title="How you've felt">
          <Card className="flex flex-col gap-2.5">
            {s.dist
              .slice()
              .reverse()
              .map((d) => (
                <HBar key={d.value} label={d.label} value={d.n} max={maxDist} color={d.color} />
              ))}
          </Card>
        </Section>

        <Section title="Emotions" hint="Feelings you named, by family">
          <Card className="flex flex-col gap-4">
            {s.families.length ? (
              <>
                <div className="flex flex-col gap-2.5">
                  {s.families.map((f) => {
                    const fam = EMOTION_FAMILIES.find((x) => x.id === f.id);
                    return <HBar key={f.id} label={fam?.label ?? "Other"} value={f.n} max={maxFam} color={fam?.color ?? "var(--text-muted)"} />;
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {s.topWords.map(([w, n]) => (
                    <span
                      key={w}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-[var(--text)]"
                      style={{ background: `color-mix(in srgb, ${FAMILY_OF[w]?.color ?? "var(--text-muted)"} 20%, var(--surface))` }}
                    >
                      {w} <span className="tabular-nums opacity-60">{n}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-[var(--text-muted)]">Name a feeling or two when you write — it's one of the most useful habits in journaling.</p>
            )}
          </Card>
        </Section>

        <Section title="Mood by weekday" hint="Average, 1–5">
          <Card>
            {s.weekday.some((w) => w.y !== null) ? (
              <WeekdayMood data={s.weekday} />
            ) : (
              <p className="py-10 text-center text-sm text-[var(--text-muted)]">Not enough moods yet.</p>
            )}
          </Card>
        </Section>

        <Section title="Words written" hint={range === "365" || range === "all" ? "Per month" : "Per week"}>
          <Card>
            <Bars data={s.wordsSeries} height={180} unit="words" />
          </Card>
        </Section>

        <Section title="Tags">
          <Card className="flex flex-col gap-4">
            {s.tags.length ? (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5" aria-label="Tag cloud">
                  {s.tags.map((t) => (
                    <span
                      key={t.t}
                      className="font-medium leading-tight"
                      style={{
                        fontSize: `${12 + Math.round((t.n / tagMax) * 12)}px`,
                        color: t.mood ? `color-mix(in srgb, ${moodColor(t.mood)} 65%, var(--text))` : "var(--text)",
                      }}
                      title={`${t.n} entries${t.mood ? ` · mood ${t.mood.toFixed(1)}` : ""}`}
                    >
                      #{t.t}
                    </span>
                  ))}
                </div>
                {moodTags.length >= 2 && (
                  <div className="flex flex-col gap-1.5 border-t border-[var(--border)] pt-3">
                    <p className="text-xs font-medium text-[var(--text-muted)]">Average mood when an entry has this tag</p>
                    {moodTags.slice(0, 6).map((t) => (
                      <HBar key={t.t} label={`#${t.t}`} value={t.mood ?? 0} max={5} color={moodColor(t.mood ?? 3)} note={(t.mood ?? 0).toFixed(1)} />
                    ))}
                    <p className="text-[11px] text-[var(--text-muted)]">Patterns, not causes — other things may be at play.</p>
                  </div>
                )}
              </>
            ) : (
              <p className="py-6 text-center text-sm text-[var(--text-muted)]">Tag entries (#work, #family…) to see what shows up most.</p>
            )}
          </Card>
        </Section>
      </div>

      <Section title="Your writing rhythm" hint="The last six months">
        <Card>
          <Heatmap days={s.heat} weeks={26} label={(d, l) => `${d}: ${["no entry", "a little", "some", "a lot", "a great deal"][l]}`} />
        </Card>
      </Section>

      <Section title="Go deeper with the assistant">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Does my sleep relate to my mood?", "Read my health data and check whether my sleep relates to my mood (with caveats)."],
            ["Do my habits lift my mood?", "Read my habits and check which habits go with better or worse mood days."],
            ["What lifts and drains me?", "Look across my entries and tell me what seems to lift my mood and what drains it."],
            ["Review this period", `Review my journal for the ${range === "all" ? "whole time" : range === "365" ? "last year" : `last ${range} days`}: themes, patterns and one question for me.`],
          ].map(([label, prompt]) => (
            <button
              key={label}
              type="button"
              onClick={() => ask(prompt)}
              className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left text-sm font-medium text-[var(--text)] transition hover:border-[var(--item-accent)]"
            >
              <Sparkles className="h-4 w-4 shrink-0 text-[var(--item-accent)]" /> {label}
            </button>
          ))}
        </div>
      </Section>
      <div className="h-6 md:hidden" aria-hidden />
    </Page>
  );
}
