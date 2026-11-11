import { Fragment, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  Mail,
  Cake,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Check,
  ChevronRight,
  Clock,
  Dumbbell,
  GraduationCap,
  HeartPulse,
  House,
  Layers,
  ListChecks,
  MessageCircle,
  Pill,
  Navigation,
  Plane,
  Plus,
  Loader2,
  Receipt,
  Sparkles,
  StickyNote,
  Stethoscope,
  Users,
  UtensilsCrossed,
  Wallet,
  Workflow,
  type LucideIcon,
  Volume2,
} from "lucide-react";
import { joinVoice } from "@/rtc/ui/uiStore";
import { namesList } from "@/rtc/ui/words";

import type { TodayAttention, TodayComing, TodayData, TodayScheduleItem } from "@/api/today";
import { timeLabel } from "@/calendar/dates";
import { itemsApi } from "@/items/api";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * The Today hub's cards: what needs you, the day in time order, medication
 * (taken from here), body numbers, macros and water, money, the next trip,
 * study, journal, people, the week ahead and automations. Each writes through
 * its app's own actions, so Today and the app can't disagree. Data comes from
 * ``/api/today`` (``backend/app/today/hub.py``).
 */

const QUERY_KEY = ["today"];

type Sections = TodayData["sections"];

/** "14:30" in your time format (Account → About you → Units & time). */
export function hhmm(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return timeLabel(new Date(2000, 0, 1, h, m));
}

function dayName(day: string, today: string): string {
  const d = new Date(`${day}T12:00:00`);
  const diff = Math.round((d.getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString([], diff < 7 ? { weekday: "long" } : { weekday: "short", day: "numeric", month: "short" });
}

/** A section: icon, title, link into the app. */
export function HubCard({
  icon: Icon,
  title,
  to,
  open,
  aside,
  children,
}: {
  icon: LucideIcon;
  title: string;
  to?: string;
  open?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Icon className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{title}</h2>
        {aside}
        {to && open && (
          <Link to={to} className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-[var(--accent-text)] hover:underline">
            {open}
            <ChevronRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function useRun() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (err) {
      toast.error(apiErrorMessage(err, "That didn't work. Try again."));
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** A progress ring with something in the middle. */
export function Ring({ pct, size = 56, stroke = 5, over, children }: { pct: number; size?: number; stroke?: number; over?: boolean; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, pct));
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={over ? "var(--danger)" : "var(--accent)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (shown / 100) * c}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center text-center leading-none">{children}</span>
    </span>
  );
}

/** A small trend line: gaps stay gaps, the latest point is marked. */
export function Sparkline({ values, className, label }: { values: (number | null)[]; className?: string; label?: string }) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const W = 100;
  const H = 28;
  const lo = Math.min(...known);
  const span = Math.max(...known) - lo || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => H - 3 - ((v - lo) / span) * (H - 6);
  const segments: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) segments.push(run.join(" "));
      run = [];
    } else {
      run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    }
  });
  if (run.length) segments.push(run.join(" "));
  const lastAt = values.reduce<number>((at, v, i) => (v !== null ? i : at), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label ?? "Trend"} className={cn("block h-7 w-full overflow-visible", className)}>
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      ))}
      <circle cx={x(lastAt)} cy={y(values[lastAt] as number)} r={2.2} fill="var(--accent)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Spike bars for daily amounts, with a target line; today is the solid one. */
export function SpikeBars({ values, target, className, label }: { values: (number | null)[]; target?: number | null; className?: string; label?: string }) {
  const known = values.filter((v): v is number => v !== null);
  if (!known.some((v) => v > 0)) return null;
  const top = Math.max(...known, target ?? 0) || 1;
  return (
    <span role="img" aria-label={label ?? "Last two weeks"} className={cn("relative flex h-8 items-end gap-[2px]", className)}>
      {target ? <span className="absolute inset-x-0 border-t border-dashed border-[var(--text-muted)] opacity-50" style={{ bottom: `${(target / top) * 100}%` }} /> : null}
      {values.map((v, i) => (
        <span
          key={i}
          className={cn("min-w-0 flex-1 rounded-sm", v === null ? "bg-[var(--surface-2)]" : i === values.length - 1 ? "bg-[var(--accent-strong)]" : "bg-[var(--accent-strong)] opacity-50", v !== null && target && v > target * 1.1 && "!bg-[var(--danger)]")}
          style={{ height: v === null ? "2px" : `${Math.max(6, (v / top) * 100)}%` }}
        />
      ))}
    </span>
  );
}

function Bar({ pct, over, className }: { pct: number; over?: boolean; className?: string }) {
  return (
    <span className={cn("block h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]", className)}>
      <span
        className={cn("block h-full rounded-full transition-[width] duration-500", over ? "bg-[var(--danger)]" : "bg-[var(--accent-strong)]")}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

// ---------------------------------------------------------------- attention

const ATTENTION_ICON: Record<string, LucideIcon> = {
  med: Pill,
  task: ListChecks,
  appointment: Stethoscope,
  bill: Receipt,
  budget: Wallet,
  person: Cake,
  message: MessageCircle,
  automation: Workflow,
};

/** What needs you now, most pressing first. Hidden when nothing does. */
export function AttentionStrip({ items }: { items: TodayAttention[] }) {
  const navigate = useNavigate();
  if (!items.length) return null;
  const go = (a: TodayAttention) => {
    const here = a.anchor && document.getElementById(`today-${a.anchor}`);
    if (here) here.scrollIntoView({ behavior: "smooth", block: "center" });
    else navigate(a.url);
  };
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="list" aria-label="Needs you">
      {items.map((a, i) => {
        const Icon = ATTENTION_ICON[a.kind] ?? AlertTriangle;
        return (
          <button
            key={`${a.kind}-${i}`}
            type="button"
            role="listitem"
            onClick={() => go(a)}
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left text-sm transition hover:brightness-110",
              a.level === "danger" && "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--text)]",
              a.level === "warn" && "border-amber-500/40 bg-amber-500/10 text-[var(--text)]",
              a.level === "info" && "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
            )}
          >
            <Icon className={cn("h-4 w-4 shrink-0", a.level === "danger" ? "text-[var(--danger)]" : a.level === "warn" ? "text-amber-500" : "text-[var(--accent-text)]")} />
            <span className="truncate font-medium">{a.title}</span>
            {a.detail && <span className="hidden truncate text-xs text-[var(--text-muted)] sm:inline">{a.detail}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------- glance

/** The day in numbers, a row of tiles (only what you use). */
export function GlanceRow({ data }: { data: TodayData }) {
  const s = data.sections;
  const tiles: { key: string; label: string; to: string; value: string; sub?: string; pct?: number; over?: boolean; series?: (number | null)[] }[] = [];
  if (s.health?.doses.length) {
    const live = s.health.doses.filter((d) => d.state !== "skipped").length;
    tiles.push({ key: "meds", label: "Medication", to: s.health.url, value: `${s.health.doses_taken}/${live}`, sub: s.health.doses_due ? `${s.health.doses_due} due now` : "taken", pct: live ? (s.health.doses_taken / live) * 100 : 0, over: s.health.doses_due > 0 });
  }
  if (s.tasks) {
    const left = s.tasks.today_count + s.tasks.overdue_count;
    tiles.push({ key: "tasks", label: "Tasks", to: s.tasks.url, value: String(left), sub: s.tasks.overdue_count ? `${s.tasks.overdue_count} overdue` : "left today", over: s.tasks.overdue_count > 0 });
  }
  if (s.habits) {
    const n = s.habits.habits.length;
    tiles.push({ key: "habits", label: "Habits", to: s.habits.url, value: `${n - s.habits.left}/${n}`, sub: "done", pct: n ? ((n - s.habits.left) / n) * 100 : 0 });
  }
  if (s.nutrition?.kcal_target) {
    const left = s.nutrition.kcal_target - s.nutrition.kcal;
    tiles.push({ key: "kcal", label: "Calories", to: s.nutrition.url, value: Math.abs(Math.round(left)).toLocaleString(), sub: left >= 0 ? "left" : "over", pct: (s.nutrition.kcal / s.nutrition.kcal_target) * 100, over: left < 0 });
  }
  if (s.nutrition?.water_target) {
    tiles.push({ key: "water", label: "Water", to: s.nutrition.url, value: `${(s.nutrition.water_ml / 1000).toFixed(1)} L`, sub: `of ${(s.nutrition.water_target / 1000).toFixed(1)} L`, pct: (s.nutrition.water_ml / s.nutrition.water_target) * 100 });
  }
  if (s.health?.weight) {
    tiles.push({ key: "weight", label: "Weight", to: s.health.url, value: s.health.weight, sub: s.health.weight_change ?? undefined, series: s.health.weight_series });
  }
  if (s.budget?.left) {
    tiles.push({ key: "budget", label: s.budget.over ? "Over budget" : "Left to spend", to: s.budget.url, value: s.budget.left.replace("-", ""), sub: `${s.budget.days_left} days left`, pct: s.budget.pct ?? undefined, over: s.budget.over });
  }
  if (s.study?.due) {
    tiles.push({ key: "study", label: "Cards due", to: s.study.url, value: String(s.study.due), sub: s.study.streak ? `${s.study.streak} day streak` : "to review" });
  }
  if (!tiles.length) return null;
  return (
    <div className="-mx-4 mb-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] sm:overflow-visible sm:px-0 sm:pb-0 lg:gap-3">
      {tiles.map((t) => (
        <Link key={t.key} to={t.to} className="w-36 shrink-0 snap-start rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 transition hover:bg-[var(--hover)] sm:w-auto">
          <span className="block truncate text-xs text-[var(--text-muted)]">{t.label}</span>
          <span className="mt-0.5 flex items-baseline gap-1.5">
            <span className={cn("text-xl font-semibold tabular-nums tracking-tight", t.over ? "text-[var(--danger)]" : "text-[var(--text)]")}>{t.value}</span>
            {t.sub && <span className="truncate text-xs text-[var(--text-muted)]">{t.sub}</span>}
          </span>
          {t.pct !== undefined && <Bar pct={t.pct} over={t.over} className="mt-1.5" />}
          {t.series && <Sparkline values={t.series} label={`${t.label} trend`} className="mt-1 !h-5" />}
        </Link>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- schedule

const SCHEDULE_ICON: Record<string, LucideIcon> = {
  event: CalendarDays,
  med: Pill,
  appointment: Stethoscope,
  task: ListChecks,
  workout: Dumbbell,
  shift: Clock,
  person: Cake,
  meal: UtensilsCrossed,
};

/** The day in time order, whichever app each thing lives in, with a "now" line. */
export function ScheduleCard({ data }: { data: TodayData }) {
  const { all_day: allDay } = data.schedule;
  const items = mergeDoses(data.schedule.items);
  const now = data.now.slice(11, 16);
  const nextAt = items.findIndex((i) => !i.done && i.time >= now);
  const nowAt = items.findIndex((i) => i.time > now);
  const row = (i: TodayScheduleItem, key: number) => {
    const Icon = SCHEDULE_ICON[i.kind] ?? CalendarDays;
    return (
      <li key={`${i.kind}-${i.time}-${key}`}>
        <Link to={i.url} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <span className={cn("w-[3.75rem] shrink-0 text-right text-xs tabular-nums", i.due ? "font-semibold text-[var(--danger)]" : "text-[var(--text-muted)]")}>{hhmm(i.time)}</span>
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
              i.done ? "bg-[var(--surface-2)] text-[var(--text-muted)]" : i.due ? "bg-[var(--danger-bg)] text-[var(--danger)]" : key === nextAt ? "bg-[var(--accent-strong)] text-white" : "bg-[var(--accent-soft)] text-[var(--accent-text)]",
            )}
            style={i.color && !i.done && key !== nextAt ? { color: i.color } : undefined}
          >
            {i.done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-sm", i.done ? "text-[var(--text-muted)] line-through" : "font-medium text-[var(--text)]")}>{i.title}</span>
            {(i.detail || i.end) && (
              <span className="block truncate text-xs text-[var(--text-muted)]">{[i.end ? `until ${hhmm(i.end)}` : "", i.detail].filter(Boolean).join(" · ")}</span>
            )}
          </span>
          {i.due && <span className="shrink-0 rounded-full bg-[var(--danger-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--danger)]">Due</span>}
        </Link>
      </li>
    );
  };
  return (
    <HubCard icon={CalendarDays} title="Schedule" to={data.sections.events?.url ?? "/calendar"} open="Calendar">
      {allDay.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {allDay.map((a, i) => {
            const Icon = SCHEDULE_ICON[a.kind] ?? CalendarDays;
            return (
              <Link
                key={`${a.kind}-${i}`}
                to={a.url}
                className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--hover)]", a.done ? "text-[var(--text-muted)] line-through" : "text-[var(--text)]")}
              >
                <Icon className="h-3 w-3 shrink-0 text-[var(--accent-text)]" />
                <span className="truncate">{a.title}</span>
              </Link>
            );
          })}
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-1 py-2 text-sm text-[var(--text-muted)]">{allDay.length ? "Nothing at a set time today." : "A clear day — nothing scheduled."}</p>
      ) : (
        <ul>
          {items.map((i, k) => (
            <Fragment key={k}>
              {k === nowAt && k > 0 && <NowLine time={now} />}
              {row(i, k)}
            </Fragment>
          ))}
          {nowAt === -1 && <NowLine time={now} />}
        </ul>
      )}
    </HubCard>
  );
}

/** Doses at the same time and in the same state read as one row. */
function mergeDoses(items: TodayScheduleItem[]): TodayScheduleItem[] {
  const out: TodayScheduleItem[] = [];
  for (const i of items) {
    const last = out[out.length - 1];
    if (i.kind === "med" && last?.kind === "med" && last.time === i.time && last.done === i.done && !!last.due === !!i.due) {
      out[out.length - 1] = { ...last, title: `${last.title}, ${i.title}`, detail: "" };
    } else {
      out.push(i);
    }
  }
  return out;
}

function NowLine({ time }: { time: string }) {
  return (
    <li aria-label={`Now, ${hhmm(time)}`} className="flex items-center gap-2.5 px-1 py-0.5">
      <span className="w-[3.75rem] shrink-0 text-right text-[11px] font-semibold tabular-nums text-[var(--accent-text)]">{hhmm(time)}</span>
      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent-strong)]" />
      <span className="h-px flex-1 bg-[var(--accent-strong)]" />
    </li>
  );
}

/** What's next: the first thing not done from now (a due dose first). */
export function nextUp(data: TodayData): TodayScheduleItem | null {
  const now = data.now.slice(11, 16);
  return data.schedule.items.find((i) => i.due) ?? data.schedule.items.find((i) => !i.done && i.time >= now) ?? null;
}

// --------------------------------------------------------------- medication

export function MedsCard({ health }: { health: NonNullable<Sections["health"]> }) {
  const { busy, run } = useRun();
  const log = (key: string, doses: Record<string, unknown>[], done: string) => run(key, () => itemsApi.action(health.file_id, "log_dose", { doses }), done);
  const live = health.doses.filter((d) => d.state !== "skipped");
  const due = health.doses.filter((d) => d.state === "due");
  return (
    <HubCard
      icon={Pill}
      title={due.length ? `Medication · ${due.length} due` : "Medication"}
      to={`${health.url}?tab=meds`}
      open="All"
      aside={
        due.length > 1 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void log("all", due.map((d) => ({ med: d.med_id, slot: d.time })), `Took ${due.length} doses`)}
            className="rounded-full bg-[var(--accent-strong)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-60"
          >
            Take all
          </button>
        ) : undefined
      }
    >
      <ul className="space-y-1">
        {health.doses.map((d) => {
          const key = `${d.med_id}-${d.time}`;
          const taken = d.state === "taken" || d.state === "late";
          return (
            <li key={key} className={cn("flex items-center gap-2.5 rounded-lg px-1 py-1.5", d.state === "due" && "bg-[var(--danger-bg)]")}>
              <span className={cn("w-[3.75rem] shrink-0 text-right text-xs tabular-nums", d.state === "due" ? "font-semibold text-[var(--danger)]" : "text-[var(--text-muted)]")}>{hhmm(d.time)}</span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm", taken || d.state === "skipped" ? "text-[var(--text-muted)]" : "font-medium text-[var(--text)]", d.state === "skipped" && "line-through")}>{d.name}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {[d.dose, d.state === "late" ? "taken late" : d.state === "taken" ? "taken" : d.state === "skipped" ? "skipped" : d.state === "due" ? "due now" : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              {taken ? (
                <Check className="mr-1 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-label="Taken" />
              ) : d.state === "skipped" ? null : (
                <span className="flex shrink-0 items-center gap-1">
                  {d.state === "due" && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void log(key + "s", [{ med: d.med_id, slot: d.time, status: "skipped" }], `Skipped ${d.name}`)}
                      className="rounded-full px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-60"
                    >
                      Skip
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-label={`Take ${d.name}`}
                    onClick={() => void log(key, [{ med: d.med_id, slot: d.time }], `Took ${d.name}`)}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-60",
                      d.state === "due" ? "bg-[var(--accent-strong)] text-white" : "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
                    )}
                  >
                    Take
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {live.length > 0 && <Bar pct={(health.doses_taken / live.length) * 100} className="mx-1 mt-2" />}
    </HubCard>
  );
}

// ------------------------------------------------------------------- health

const MOODS: [number, string][] = [[1, "😞"], [2, "🙁"], [3, "😐"], [4, "🙂"], [5, "😄"]];

export function HealthCard({ health, today, hideWater }: { health: NonNullable<Sections["health"]>; today: string; hideWater?: boolean }) {
  const { busy, run } = useRun();
  const [weight, setWeight] = useState("");
  const logMetric = (metric: string, value: number, done: string) => run(metric, () => itemsApi.action(health.file_id, "log_metrics", { readings: [{ metric, value }] }), done);
  const moodDone = health.numbers.find((n) => n.metric === "mood")?.value;
  const goals = health.goals.filter((g) => !(hideWater && g.metric === "water"));
  // A number with a daily goal shows as its progress bar instead.
  const withGoal = new Set(health.goals.map((g) => g.metric));
  const numbers = health.numbers.filter((n) => n.value && !["mood", "weight"].includes(n.metric) && !withGoal.has(n.metric) && !(hideWater && n.metric === "water"));
  const next = health.appointments[0];
  return (
    <HubCard icon={HeartPulse} title="Body & Health" to={health.url} open="Open">
      <form
        className="flex items-center gap-2 px-1"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(weight);
          if (!v) return;
          void logMetric("weight", v, "Weight logged — Macros and Workout have it too").then(() => setWeight(""));
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-[var(--text-muted)]">Weight{health.weight_day === today ? " today" : health.weight_day ? ` · ${dayName(health.weight_day, today).toLowerCase()}` : ""}</span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums tracking-tight text-[var(--text)]">{health.weight ?? "–"}</span>
            {health.weight_change && <span className="text-xs tabular-nums text-[var(--text-muted)]">{health.weight_change} in 30 days</span>}
          </span>
        </span>
        <input
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          inputMode="decimal"
          aria-label={`Log weight in ${health.weight_unit}`}
          placeholder={health.weight_unit}
          className="w-16 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
        />
        <button type="submit" disabled={busy !== null || !weight} className="rounded-lg bg-[var(--accent-strong)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
          Log
        </button>
      </form>
      <Sparkline values={health.weight_series} label="Weight over the last 30 days" className="mt-1 px-1" />
      {health.numbers.some((n) => n.metric === "mood") && (
        <div className="mt-2 flex items-center gap-1 px-1">
          <span className="flex-1 text-xs text-[var(--text-muted)]">{moodDone ? `Mood today: ${moodDone}` : "How are you feeling?"}</span>
          {MOODS.map(([v, e]) => (
            <button key={v} type="button" disabled={busy !== null} aria-label={`Mood ${v} of 5`} onClick={() => void logMetric("mood", v, "Mood logged")} className="rounded-lg px-1 py-0.5 text-lg transition hover:bg-[var(--hover)] disabled:opacity-60">
              {e}
            </button>
          ))}
        </div>
      )}
      {numbers.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 px-1">
          {numbers.map((n) => (
            <div key={n.metric} className="grid grid-cols-[1fr_auto] items-baseline gap-x-2 text-sm">
              <dt className="truncate text-xs text-[var(--text-muted)]">{n.label}</dt>
              <dd className="font-medium tabular-nums text-[var(--text)]">{n.value}</dd>
              {n.series && <Sparkline values={n.series} label={`${n.label}, last two weeks`} className="col-span-full !h-4" />}
            </div>
          ))}
        </dl>
      )}
      {goals.length > 0 && (
        <ul className="mt-2 space-y-1.5 px-1">
          {goals.map((g) => (
            <li key={g.metric}>
              <span className="flex items-baseline justify-between text-xs">
                <span className="text-[var(--text-muted)]">{g.label}</span>
                <span className="tabular-nums text-[var(--text)]">{g.today} / {g.target}</span>
              </span>
              <Bar pct={g.pct} className="mt-0.5" />
              <SpikeBars values={g.series} label={`${g.label}, last two weeks`} className="mt-1 h-5" />
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Link to={health.url} className="mt-2 flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <Stethoscope className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{next.title}{next.who ? ` · ${next.who}` : ""}</span>
          <span className="shrink-0 text-xs text-[var(--text-muted)]">{dayName(next.date, today)} {hhmm(next.time)}</span>
        </Link>
      )}
    </HubCard>
  );
}

// ---------------------------------------------------------------- nutrition

export function NutritionCard({ n }: { n: NonNullable<Sections["nutrition"]> }) {
  const { busy, run } = useRun();
  const left = n.kcal_target ? n.kcal_target - n.kcal : null;
  const water = (ml: number) => run(`w${ml}`, () => itemsApi.action(n.file_id, "log_water", { ml }));
  return (
    <HubCard icon={UtensilsCrossed} title="Food" to={n.url} open="Log food">
      <div className="flex items-center gap-3 px-1">
        <Ring pct={n.kcal_target ? (n.kcal / n.kcal_target) * 100 : 0} size={76} stroke={7} over={left !== null && left < 0}>
          <span className="text-base font-semibold tabular-nums text-[var(--text)]">{left === null ? n.kcal : Math.abs(left).toLocaleString()}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{left === null ? "kcal" : left >= 0 ? "kcal left" : "kcal over"}</span>
        </Ring>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {n.macros.map((m) => (
            <li key={m.key}>
              <span className="flex items-baseline justify-between text-xs">
                <span className="text-[var(--text-muted)]">{m.label}</span>
                <span className="tabular-nums text-[var(--text)]">{m.value}{m.target ? ` / ${Math.round(m.target)}` : ""} g</span>
              </span>
              <Bar pct={m.target ? (m.value / m.target) * 100 : 0} className="mt-0.5" />
            </li>
          ))}
        </ul>
      </div>
      {n.kcal_series.some((v) => v !== null) && (
        <div className="mt-2 grid grid-cols-2 gap-3 px-1">
          <div>
            <p className="mb-0.5 text-[11px] text-[var(--text-muted)]">Calories, 14 days</p>
            <SpikeBars values={n.kcal_series} target={n.kcal_target} label="Calories, last two weeks" />
          </div>
          <div>
            <p className="mb-0.5 text-[11px] text-[var(--text-muted)]">Protein, 14 days</p>
            <SpikeBars values={n.protein_series} target={n.macros.find((m) => m.key === "protein")?.target} label="Protein, last two weeks" />
          </div>
        </div>
      )}
      {n.meals_left.length > 0 && n.entries > 0 && <p className="mt-2 truncate px-1 text-xs text-[var(--text-muted)]">Not logged yet: {n.meals_left.join(", ")}</p>}
      <div className="mt-2 flex items-center gap-2 border-t border-[var(--border)] px-1 pt-2">
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between text-xs">
            <span className="text-[var(--text-muted)]">Water</span>
            <span className="tabular-nums text-[var(--text)]">{(n.water_ml / 1000).toFixed(2).replace(/0$/, "")}{n.water_target ? ` / ${(n.water_target / 1000).toFixed(1)}` : ""} L</span>
          </span>
          <Bar pct={n.water_target ? (n.water_ml / n.water_target) * 100 : 0} className="mt-0.5" />
        </span>
        {[250, 500].map((ml) => (
          <button key={ml} type="button" disabled={busy !== null} onClick={() => void water(ml)} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60">
            <Plus className="h-3 w-3" />
            {ml}
          </button>
        ))}
      </div>
    </HubCard>
  );
}

// ------------------------------------------------------------------- budget

export function BudgetCard({ b, today }: { b: NonNullable<Sections["budget"]>; today: string }) {
  return (
    <HubCard icon={Wallet} title={`Budget · ${b.label}`} to={b.url} open="Open">
      <div className="px-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("text-xl font-semibold tabular-nums tracking-tight", b.over ? "text-[var(--danger)]" : "text-[var(--text)]")}>{b.left ? b.left.replace("-", "") : b.spent}</span>
          <span className="text-xs text-[var(--text-muted)]">{b.left ? (b.over ? "over budget" : "left") : "spent"} · {b.days_left} days to go</span>
        </span>
        {b.pct !== null && <Bar pct={b.pct} over={b.over} className="mt-1" />}
        {b.budgeted && <p className="mt-1 text-xs text-[var(--text-muted)]">{b.spent} of {b.budgeted} spent</p>}
        {b.projected_over && !b.over && <p className="mt-1 text-xs text-amber-500">On pace to finish {b.projected_over} over</p>}
      </div>
      {b.overspent.length > 0 && (
        <ul className="mt-2 px-1 text-xs">
          {b.overspent.map((o) => (
            <li key={o.name} className="flex justify-between py-0.5">
              <span className="truncate text-[var(--text)]">{o.name}</span>
              <span className="shrink-0 tabular-nums text-[var(--danger)]">over {o.by}</span>
            </li>
          ))}
        </ul>
      )}
      {b.bills.length > 0 && (
        <>
          <p className="mt-2 px-1 text-xs font-medium text-[var(--text-muted)]">Bills this week</p>
          <ul className="px-1">
            {b.bills.map((x) => (
              <li key={`${x.name}-${x.date}`} className="flex items-center gap-2 py-1 text-sm">
                <Receipt className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{x.name}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{dayName(x.date, today)}</span>
                <span className="shrink-0 tabular-nums text-[var(--text)]">{x.amount}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </HubCard>
  );
}

// --------------------------------------------------------------------- trip

export function MapsCard({ m }: { m: NonNullable<Sections["maps"]> }) {
  return (
    <HubCard icon={Navigation} title="Getting there" to="/maps" open="Open maps">
      {m.next && (
        <Link to={m.next.url} className="block rounded-lg px-1 py-1 hover:bg-[var(--hover)]">
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--text)]">{m.next.leave_by_label}</span>
            <span className="text-sm text-[var(--text-muted)]">leave by</span>
          </span>
          <span className="mt-0.5 block truncate text-sm text-[var(--text)]">{m.next.title}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{m.next.minutes} min, {m.next.km} km, {m.next.traffic ? (m.next.adds ? `traffic adds ${m.next.adds} min` : "no traffic delays") : "without traffic"}</span>
          {m.next.warning && <span className="mt-0.5 block truncate text-xs font-medium text-[#C62828] dark:text-[#EF8A8A]">{m.next.warning}</span>}
        </Link>
      )}
      {m.parked && (
        <Link to={m.parked.url} className="mt-1 flex items-center gap-2 rounded-lg px-1 py-1 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-[#4F7FE0] text-[11px] font-bold text-white">P</span>
          Your car, parked {new Date(m.parked.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
        </Link>
      )}
    </HubCard>
  );
}

export function TripCard({ t }: { t: NonNullable<Sections["trip"]> }) {
  const during = t.phase === "during";
  return (
    <HubCard icon={Plane} title={`${t.emoji ? `${t.emoji} ` : ""}${t.title}`} to={t.url} open="Open">
      <div className="flex items-baseline gap-2 px-1">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--text)]">{during ? `Day ${t.day}` : t.days_to_go}</span>
        <span className="text-sm text-[var(--text-muted)]">{during ? `of ${t.of}` : t.days_to_go === 1 ? "day to go" : "days to go"}</span>
        {t.start && (
          <span className="ml-auto text-xs text-[var(--text-muted)]">
            {new Date(`${t.start}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}
            {t.end ? ` – ${new Date(`${t.end}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""}
          </span>
        )}
      </div>
      {t.next.length > 0 && (
        <ul className="mt-1 px-1">
          {t.next.slice(0, 2).map((m, i) => (
            <li key={i} className="flex items-baseline gap-2 py-0.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-[var(--text)]">{m.what}</span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">in {m.in}</span>
            </li>
          ))}
        </ul>
      )}
      {t.packing_total > 0 && (
        <div className="mt-2 px-1">
          <span className="flex justify-between text-xs">
            <span className="text-[var(--text-muted)]">Packing</span>
            <span className="tabular-nums text-[var(--text)]">{t.packed}/{t.packing_total}</span>
          </span>
          <Bar pct={(t.packed / t.packing_total) * 100} className="mt-0.5" />
        </div>
      )}
    </HubCard>
  );
}

// ------------------------------------------------------------ study, journal

export function StudyCard({ s }: { s: NonNullable<Sections["study"]> }) {
  return (
    <HubCard icon={GraduationCap} title="Flashcards" to={s.url} open="Decks">
      <div className="flex items-center gap-3 px-1">
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-semibold tabular-nums tracking-tight text-[var(--text)]">{s.due ? `${s.due} due` : "All caught up"}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">
            {[s.due ? `${s.review} to review, ${s.new} new` : "", s.done_today ? `${s.done_today} done today` : "", s.streak ? `${s.streak} day streak` : ""].filter(Boolean).join(" · ")}
          </span>
        </span>
        {s.due > 0 && (
          <Link to={s.url} className="shrink-0 rounded-lg bg-[var(--accent-strong)] px-3 py-1.5 text-xs font-semibold text-white">
            Study
          </Link>
        )}
      </div>
    </HubCard>
  );
}

export function MailCard({ m }: { m: NonNullable<Sections["mail"]> }) {
  const said = [m.needs_reply ? `${m.needs_reply} waiting on a reply` : "", m.unread ? `${m.unread} unread` : ""].filter(Boolean).join(" · ");
  return (
    <HubCard icon={Mail} title="Mail" to={m.url} open="Open">
      <p className="px-1 pb-1 text-sm font-medium text-[var(--text)]">{said}</p>
      {m.items.map((item) => (
        <Link key={item.url} to={item.url} className="block rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <span className="block truncate text-sm text-[var(--text)]">{item.from}: {item.subject}</span>
          {item.summary && <span className="block truncate text-xs text-[var(--text-muted)]">{item.summary}</span>}
        </Link>
      ))}
    </HubCard>
  );
}

/** Forms (WP-F1.4): how many new answers per form, never what they say. */
export function FormsCard({ f }: { f: NonNullable<Sections["forms"]> }) {
  return (
    <HubCard icon={ClipboardList} title="Forms" to={f.url} open="Open">
      {f.new_total > 0 && (
        <p className="px-1 pb-1 text-sm font-medium text-[var(--text)]">{f.new_total === 1 ? "1 new answer" : `${f.new_total} new answers`}</p>
      )}
      {f.forms.map((x) => (
        <Link key={x.url} to={x.url} className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.title}</span>
          <span className="shrink-0 rounded-full bg-[var(--accent-strong)] px-1.5 text-[11px] font-semibold leading-5 text-white">{x.new > 99 ? "99+" : x.new} new</span>
        </Link>
      ))}
      {f.more > 0 && <p className="px-1 pt-0.5 text-xs text-[var(--text-muted)]">and {f.more} more {f.more === 1 ? "form" : "forms"}</p>}
      {f.closing.map((x) => (
        <Link key={`c-${x.url}`} to={x.url} className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.title}</span>
          <span className="shrink-0 text-xs text-[var(--text-muted)]">closes {timeLabel(new Date(x.closes_at))}</span>
        </Link>
      ))}
      {(f.to_mark ?? []).map((x) => (
        <Link key={`m-${x.url}`} to={x.url} className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.title}</span>
          <span className="shrink-0 text-xs font-medium text-[var(--accent-text)]">{x.count === 1 ? "1 answer to mark" : `${x.count} answers to mark`}</span>
        </Link>
      ))}
    </HubCard>
  );
}

// -------------------------------------------------------------------- porch

/** Porch: new posts in your ticked groups since you last looked (a few
 *  thumbnails and who posted), and today's birthdays with "Post for Sam". */
export function PorchCard({ p }: { p: NonNullable<Sections["porch"]> }) {
  const n = p.new_posts;
  const who = n ? [...n.from, ...(n.more_people ? [`${n.more_people} more`] : [])] : [];
  const whoText = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}` : who[0] ?? "";
  return (
    <HubCard icon={House} title="Porch" to={p.url} open="Open Porch">
      {n && (
        <Link to={p.url} className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-[var(--text)]">{n.count === 1 ? "1 new post" : `${n.count > 99 ? "99+" : n.count} new posts`}</span>
            {whoText && <span className="block truncate text-xs text-[var(--text-muted)]">from {whoText}</span>}
          </span>
          {n.thumbs.length > 0 && (
            <span className="flex shrink-0 -space-x-2">
              {n.thumbs.map((t) => (
                <img key={t.post_id} src={t.thumb ?? undefined} alt="" loading="lazy" className="h-10 w-10 rounded-lg border-2 border-[var(--surface)] object-cover" />
              ))}
            </span>
          )}
        </Link>
      )}
      {p.birthdays.length > 0 && (
        <ul className={cn(n && "mt-1 border-t border-[var(--border)] pt-1")}>
          {p.birthdays.map((b) => (
            <li key={b.user.id} className="flex items-center gap-2 px-1 py-1.5">
              <Cake className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />
              <Link to={b.profile_url} className="min-w-0 flex-1 hover:underline">
                <span className="block truncate text-sm text-[var(--text)]">{b.user.name}</span>
                <span className="block text-xs text-[var(--text-muted)]">Birthday today</span>
              </Link>
              <Link to={b.post_url} className="shrink-0 rounded-lg bg-[var(--accent-strong)] px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90">
                Post for {b.user.name.split(" ")[0]}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HubCard>
  );
}

export function JournalCard({ j }: { j: NonNullable<Sections["journal"]> }) {
  return (
    <HubCard icon={BookOpen} title="Journal" to={j.url} open="Open">
      <div className="flex items-center gap-3 px-1">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-[var(--text)]">{j.wrote_today ? `Written today · ${j.words_today.toLocaleString()} words` : "Nothing written yet today"}</span>
          <span className="block text-xs text-[var(--text-muted)]">{j.streak ? `${j.streak} day streak` : j.total ? "Start a new streak" : "Your first entry starts a streak"}</span>
        </span>
        <Link to={j.url} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold", j.wrote_today ? "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]" : "bg-[var(--accent-strong)] text-white")}>
          {j.wrote_today ? "Add more" : "Write"}
        </Link>
      </div>
    </HubCard>
  );
}

// ------------------------------------------------------------------- people

export function PeopleCard({ p, today }: { p: NonNullable<Sections["people"]>; today: string }) {
  return (
    <HubCard icon={Users} title="People" to={p.url} open="Contacts">
      <ul>
        {p.dates.map((d) => (
          <li key={`${d.url}-${d.kind}`}>
            <Link to={d.url} className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
              <Cake className={cn("h-4 w-4 shrink-0", d.in_days === 0 ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]")} />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                {d.name}
                <span className="text-[var(--text-muted)]"> · {d.kind === "birthday" && d.turns ? `turns ${d.turns}` : d.label}</span>
              </span>
              <span className={cn("shrink-0 text-xs", d.in_days === 0 ? "font-semibold text-[var(--accent-text)]" : "text-[var(--text-muted)]")}>{dayName(d.date, today)}</span>
            </Link>
          </li>
        ))}
        {p.catchup.map((c) => (
          <li key={c.url}>
            <Link to={c.url} className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
              <MessageCircle className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">Catch up with {c.name}</span>
              {c.days_since != null && <span className="shrink-0 text-xs text-[var(--text-muted)]">{c.days_since} days</span>}
            </Link>
          </li>
        ))}
      </ul>
      {p.catchup_total > p.catchup.length && <p className="px-1 pt-1 text-xs text-[var(--text-muted)]">and {p.catchup_total - p.catchup.length} more to catch up with</p>}
    </HubCard>
  );
}

// --------------------------------------------------------------- week ahead

const COMING_ICON: Record<string, LucideIcon> = {
  event: CalendarDays,
  appointment: Stethoscope,
  person: Cake,
  bill: Receipt,
  shift: Clock,
  trip: Plane,
  task: ListChecks,
};

export function ComingCard({ coming, today }: { coming: TodayComing[]; today: string }) {
  const days: [string, TodayComing[]][] = [];
  for (const c of coming) {
    const last = days[days.length - 1];
    if (last && last[0] === c.date) last[1].push(c);
    else days.push([c.date, [c]]);
  }
  return (
    <HubCard icon={CalendarClock} title="Coming up" to="/calendar" open="Calendar">
      {days.length === 0 ? (
        <p className="px-1 py-1 text-sm text-[var(--text-muted)]">Nothing in the next seven days.</p>
      ) : (
        <div className="space-y-2">
          {days.map(([day, rows]) => (
            <div key={day}>
              <p className="px-1 text-xs font-semibold text-[var(--text-muted)]">{dayName(day, today)}</p>
              <ul>
                {rows.map((r, i) => {
                  const Icon = COMING_ICON[r.kind] ?? CalendarDays;
                  return (
                    <li key={i}>
                      <Link to={r.url} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-[var(--hover)]">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" style={r.color ? { color: r.color } : undefined} />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{r.title}</span>
                        {r.time && <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{hhmm(r.time)}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </HubCard>
  );
}

// -------------------------------------------------------------- notes

/** Notes (app/notes): your pinned notes — a list says how much is left —
 *  and voice notes whose words are still being worked out. */
export function NotesCard({ n }: { n: NonNullable<Sections["notes"]> }) {
  return (
    <HubCard icon={StickyNote} title="Notes" to={n.url} open={n.more_pinned ? "All pinned" : "Open"}>
      <ul aria-label="Pinned notes">
        {n.pinned.map((c) => {
          const detail = c.kind === "list" ? (c.total ? (c.left ? `${c.left} left` : "All ticked off") : "Empty list") : c.snippet;
          return (
            <li key={c.id}>
              <Link to={c.url} state={{ from: "/today" }} className="flex items-start gap-2.5 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
                {c.kind === "list" ? (
                  <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                ) : (
                  <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{c.title}</span>
                  {detail && <span className="block truncate text-xs text-[var(--text-muted)]">{detail}{c.shared ? " · shared with you" : ""}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {n.transcribing.length > 0 && (
        <ul aria-label="Voice notes being transcribed" className={cn(n.pinned.length > 0 && "mt-1 border-t border-[var(--border)] pt-1")}>
          {n.transcribing.map((t) => (
            <li key={t.id}>
              <Link to={t.url} state={{ from: "/today" }} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{t.title}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">Transcribing…</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HubCard>
  );
}

// -------------------------------------------------------------- passwords

/** Counts the person chose to post from their vault. Today has no keys, and never names. */
export function PasswordsCard({ p }: { p: NonNullable<Sections["passwords"]> }) {
  return (
    <a href="/passwords#/security" className="block">
      <p className="text-sm font-medium text-[var(--text-primary)]">
        {p.attention} password{p.attention === 1 ? "" : "s"} need{p.attention === 1 ? "s" : ""} attention
      </p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">Open the Security check in Passwords to see which.</p>
    </a>
  );
}

// -------------------------------------------------------------- automations

export function AutomationsCard({ a }: { a: NonNullable<Sections["automations"]> }) {
  return (
    <HubCard icon={Workflow} title="Automations" to={a.url} open="All">
      {a.failed_24h > 0 && (
        <Link to={a.url} className="mb-1 flex items-center gap-2 rounded-lg bg-[var(--danger-bg)] px-2 py-1.5 text-sm text-[var(--text)]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--danger)]" />
          {a.failed_24h} failed in the last day
        </Link>
      )}
      <ul>
        {a.next.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-1 py-1 text-sm">
            <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[var(--text)]">{t.title}</span>
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              {new Date(t.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
            </span>
          </li>
        ))}
      </ul>
    </HubCard>
  );
}

// ----------------------------------------------------------------- discover

export function DiscoverCard({ apps }: { apps: TodayData["discover"] }) {
  return (
    <HubCard icon={Sparkles} title="Bring more into Today" to="/apps/store" open="Get apps">
      <ul>
        {apps.map((a) => (
          <li key={a.kind}>
            <Link to="/apps/store" className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
              <Layers className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text)]">{a.name}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">{a.why}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </HubCard>
  );
}

// -------------------------------------------------------------- voice

/** Calls: who's hanging out in a voice channel of your spaces right now. */
export function VoiceCard({ v }: { v: NonNullable<Sections["voice"]> }) {
  const navigate = useNavigate();
  return (
    <HubCard icon={Volume2} title="Hanging out now" to="/rooms/" open="Rooms">
      <ul className="space-y-1">
        {v.channels.map((c) => (
          <li key={c.room_id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
            <Link to={c.url} className="min-w-0 flex-1">
              <span className="block truncate text-sm text-[var(--text)]">
                {namesList(c.people, 2)} {c.people.length === 1 ? "is" : "are"} in <b className="font-semibold">{c.name}</b>
              </span>
              <span className="block truncate text-xs text-[var(--text-muted)]">{c.space}</span>
            </Link>
            {c.here || v.in_voice === c.room_id ? (
              <span className="shrink-0 text-xs font-medium text-[var(--success)]">You're here</span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  navigate(c.url);
                  void joinVoice(c.room_id);
                }}
                className="shrink-0 rounded-lg bg-[var(--accent-strong)] px-2.5 py-1 text-xs font-semibold text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1"
                aria-label={`Join ${c.name}`}
              >
                Join
              </button>
            )}
          </li>
        ))}
      </ul>
    </HubCard>
  );
}
