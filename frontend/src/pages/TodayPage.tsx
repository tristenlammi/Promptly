import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  Dumbbell,
  Hash,
  Images,
  LayoutGrid,
  ListChecks,
  MessageCircle,
  Repeat,
  UtensilsCrossed,
} from "lucide-react";

import { todayApi, type TodayData, type TodayEvent, type TodayHabit, type TodayTask } from "@/api/today";
import { itemsApi } from "@/items/api";
import { TopNav } from "@/components/layout/TopNav";
import { Skeleton } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Today — what your day holds across Promptly, on one page: events, tasks
 * due, habits to tick, the workout and meals planned, "on this day" photos,
 * unread rooms, and your cards and shifts. Each section is there only when
 * you use that app, and links into it; tasks and habits tick off right here
 * (through each app's own actions). One backend call (``/api/today``).
 */

const QUERY_KEY = ["today"];

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function longDate(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function TodayPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: todayApi.get,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  return (
    <>
      <TopNav title="Today" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 md:py-8">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-64" />
              <div className="grid gap-3 md:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-36 w-full" />
                ))}
              </div>
            </div>
          ) : isError || !data ? (
            <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--text-muted)]">
              Couldn't load your day.{" "}
              <button type="button" className="font-medium text-[var(--accent-text)]" onClick={() => void refetch()}>
                Try again
              </button>
            </div>
          ) : (
            <TodayBody data={data} />
          )}
        </div>
      </div>
    </>
  );
}

function TodayBody({ data }: { data: TodayData }) {
  const s = data.sections;
  const summary = summaryLine(data);
  const empty = !s.events?.events.length && !s.tasks && !s.habits && !s.workout && !s.meals && !s.photos && !s.rooms && !s.work;
  return (
    <>
      <header className="mb-5 md:mb-7">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)] md:text-3xl">{data.greeting}</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {longDate(data.date)}
          {summary ? ` · ${summary}` : ""}
        </p>
      </header>

      <div className="grid items-start gap-3 md:grid-cols-2 md:gap-4">
        {s.events && <EventsCard events={s.events.events} url={s.events.url} />}
        {s.tasks && <TasksCard tasks={s.tasks} />}
        {s.habits && <HabitsCard habits={s.habits} />}
        {s.workout && (
          <Card icon={<Dumbbell className="h-4 w-4" />} title="Workout" to={s.workout.url} open="Open logger">
            <ul className="space-y-1">
              {s.workout.sessions.map((w) => (
                <li key={w.id}>
                  <Link to={s.workout!.url} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm font-medium", w.status === "done" && "text-[var(--text-muted)] line-through")}>{w.name}</span>
                      <span className="block text-xs text-[var(--text-muted)]">
                        {[w.time, w.exercises ? plural(w.exercises, "exercise") : "", w.status === "done" ? "Done" : ""].filter(Boolean).join(" · ") || "Planned for today"}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {s.meals && (
          <Card icon={<UtensilsCrossed className="h-4 w-4" />} title="Meals" to={s.meals.url} open="Meal plan">
            <ul className="space-y-0.5">
              {s.meals.meals.map((m) => (
                <li key={m.id} className="flex items-baseline gap-3 px-2 py-1 text-sm">
                  <span className="w-20 shrink-0 text-xs capitalize text-[var(--text-muted)]">{m.slot}</span>
                  <span className={cn("min-w-0 flex-1 truncate", m.cooked && "text-[var(--text-muted)] line-through")}>
                    {m.title}
                    {m.leftovers ? <span className="text-[var(--text-muted)]"> · leftovers</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {s.work && <WorkCard work={s.work} />}
        {s.rooms && (
          <Card icon={<MessageCircle className="h-4 w-4" />} title={`Unread · ${s.rooms.total}`} to={s.rooms.url} open="Rooms">
            <ul className="space-y-0.5">
              {s.rooms.rooms.map((r) => (
                <li key={r.id}>
                  <Link to={r.url} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
                    {r.dm ? <MessageCircle className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" /> : <Hash className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {r.name}
                      {r.where && !r.dm ? <span className="text-[var(--text-muted)]"> · {r.where}</span> : null}
                    </span>
                    <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold leading-5 text-white">{r.unread > 99 ? "99+" : r.unread}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {s.photos && (
          <Card icon={<Images className="h-4 w-4" />} title="On this day" to={s.photos.url} open="Photos">
            <p className="mb-2 px-2 text-xs text-[var(--text-muted)]">
              {plural(s.photos.count, "photo")} from {s.photos.years.map((y) => new Date(data.date).getFullYear() - y).filter((n) => n > 0).map((n) => plural(n, "year")).join(", ")} ago
            </p>
            <div className="grid grid-cols-3 gap-1.5 px-2">
              {s.photos.items.map((p) => (
                <Link key={p.id} to={s.photos!.url} className="block aspect-square overflow-hidden rounded-lg bg-[var(--surface-2)]">
                  {p.thumb && <img src={p.thumb} alt={p.filename} loading="lazy" className="h-full w-full object-cover" />}
                </Link>
              ))}
            </div>
          </Card>
        )}
      </div>

      {empty && (
        <p className="mt-6 text-center text-sm text-[var(--text-muted)]">
          A clear day. Add events in Calendar, or apps like Tasks, Habits and Meal planner from Apps — they'll show up here.
        </p>
      )}

      <MorningCard data={data} />
    </>
  );
}

function summaryLine(data: TodayData): string {
  const s = data.sections;
  const bits: string[] = [];
  const ev = s.events?.events.length ?? 0;
  if (ev) bits.push(plural(ev, "event"));
  const due = (s.tasks?.today_count ?? 0) + (s.tasks?.overdue_count ?? 0);
  if (due) bits.push(`${plural(due, "task")} due`);
  const w = s.workout?.sessions.find((x) => x.status === "planned");
  if (w) bits.push(w.name);
  return bits.join(" · ");
}

function Card({ icon, title, to, open, children }: { icon: ReactNode; title: string; to: string; open: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-2 pb-3 md:p-3">
      <div className="mb-1 flex items-center gap-2 px-2 pt-1">
        <span className="text-[var(--accent-text)]">{icon}</span>
        <h2 className="flex-1 text-sm font-semibold text-[var(--text)]">{title}</h2>
        <Link to={to} className="inline-flex items-center gap-0.5 text-xs font-medium text-[var(--accent-text)] hover:underline">
          {open}
          <ChevronRight className="h-3 w-3" />
        </Link>
      </div>
      {children}
    </section>
  );
}

function EventsCard({ events, url }: { events: TodayEvent[]; url: string }) {
  return (
    <Card icon={<CalendarDays className="h-4 w-4" />} title="Calendar" to={url} open="Calendar">
      {events.length === 0 ? (
        <p className="px-2 py-1 text-sm text-[var(--text-muted)]">Nothing on your calendar today.</p>
      ) : (
        <ul className="space-y-0.5">
          {events.map((e) => (
            <li key={e.id}>
              <Link to={e.url} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
                <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: e.color || "var(--accent)" }} />
                <span className="w-16 shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{e.all_day ? "All day" : clock(e.start)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{e.title}</span>
                  {e.location && <span className="block truncate text-xs text-[var(--text-muted)]">{e.location}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function useTick() {
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

function TickBox({ done, busy, label, onClick }: { done: boolean; busy: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition",
        done ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--border-strong,var(--border))] hover:border-[var(--accent)]",
        busy && "opacity-50",
      )}
    >
      {done && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  );
}

function TasksCard({ tasks }: { tasks: NonNullable<TodayData["sections"]["tasks"]> }) {
  const { busy, run } = useTick();
  const total = tasks.today_count + tasks.overdue_count;
  const row = (t: TodayTask, overdue: boolean) => (
    <li key={t.id} className="flex items-center gap-3 px-2 py-1.5">
      <TickBox
        done={false}
        busy={busy === t.id}
        label={`Mark "${t.title}" done`}
        onClick={() => void run(t.id, () => itemsApi.action(tasks.file_id, "complete_tasks", { tasks: [t.id] }), `Done: ${t.title}`)}
      />
      <Link to={tasks.url} className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--text)]">{t.title}</span>
        <span className={cn("block truncate text-xs", overdue ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
          {[overdue && t.due ? `Due ${new Date(`${t.due}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}` : "", t.time, t.list].filter(Boolean).join(" · ") || "Today"}
        </span>
      </Link>
    </li>
  );
  return (
    <Card icon={<ListChecks className="h-4 w-4" />} title={total ? `Tasks · ${total} due` : "Tasks"} to={tasks.url} open="Tasks">
      {total === 0 ? (
        <p className="px-2 py-1 text-sm text-[var(--text-muted)]">Nothing due today.</p>
      ) : (
        <ul>
          {tasks.overdue.map((t) => row(t, true))}
          {tasks.today.map((t) => row(t, false))}
          {total > tasks.overdue.length + tasks.today.length && (
            <li className="px-2 pt-1 text-xs text-[var(--text-muted)]">
              <Link to={tasks.url} className="hover:underline">
                and {total - tasks.overdue.length - tasks.today.length} more
              </Link>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

function HabitsCard({ habits }: { habits: NonNullable<TodayData["sections"]["habits"]> }) {
  const { busy, run } = useTick();
  const tick = (h: TodayHabit) =>
    run(h.id, () =>
      h.done
        ? itemsApi.action(habits.file_id, "unlog_habit", { habit: h.id, day: habits.day })
        : itemsApi.action(habits.file_id, "log_habit", { habit: h.id, day: habits.day }),
    );
  return (
    <Card
      icon={<Repeat className="h-4 w-4" />}
      title={habits.left ? `Habits · ${habits.left} to go` : "Habits · all done"}
      to={habits.url}
      open="Habits"
    >
      <ul>
        {habits.habits.map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-2 py-1.5">
            <TickBox done={h.done} busy={busy === h.id} label={h.done ? `Undo ${h.name}` : `Tick ${h.name}`} onClick={() => void tick(h)} />
            <span className={cn("min-w-0 flex-1 truncate text-sm", h.done && "text-[var(--text-muted)]")}>
              {h.emoji ? `${h.emoji} ` : ""}
              {h.name}
              {h.type !== "yes_no" && h.type !== "avoid" && (
                <span className="text-xs text-[var(--text-muted)]">
                  {" "}
                  · {h.value || 0}/{h.target}
                  {h.unit ? ` ${h.unit}` : ""}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function WorkCard({ work }: { work: NonNullable<TodayData["sections"]["work"]> }) {
  return (
    <Card icon={<LayoutGrid className="h-4 w-4" />} title={work.due_count ? `My work · ${work.due_count} due` : `My work · ${work.open_count} open`} to={work.url} open="My work">
      <ul className="space-y-0.5">
        {work.shifts.map((s, i) => (
          <li key={`shift-${i}`}>
            <Link to={s.url} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  Shift {s.start && s.end ? `${s.start}–${s.end}` : s.hours ? `· ${s.hours}h` : "today"}
                </span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {s.workspace} · {s.roster}
                  {s.note ? ` · ${s.note}` : ""}
                </span>
              </span>
            </Link>
          </li>
        ))}
        {work.cards.map((c) => (
          <li key={c.id}>
            <Link to={c.url} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", c.overdue ? "bg-[var(--danger)]" : "bg-[var(--accent)]")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.title}</span>
                <span className={cn("block truncate text-xs", c.overdue ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                  {[c.overdue ? "Overdue" : c.due ? "Due today" : "", c.workspace, c.board].filter(Boolean).join(" · ")}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The one morning push: on/off and when. Lives in Tasks' settings when
 *  you have Tasks (so both places stay in step), else on your account. */
function MorningCard({ data }: { data: TodayData }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const m = data.morning;
  const save = async (on: boolean, time: string) => {
    setSaving(true);
    try {
      const next = await todayApi.setMorning(on, time);
      qc.setQueryData<TodayData>(QUERY_KEY, (old) => (old ? { ...old, morning: next } : old));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save that."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="mt-5 flex flex-wrap items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <Bell className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--text)]">Morning summary</div>
        <div className="text-xs text-[var(--text-muted)]">
          One push each morning with your day — events, tasks due, your workout.
          {m.source === "tasks" && m.file_id ? (
            <>
              {" "}Also in{" "}
              <button type="button" className="text-[var(--accent-text)] hover:underline" onClick={() => navigate(`/apps/tasks/${m.file_id}?tab=settings`)}>
                Tasks settings
              </button>
              .
            </>
          ) : null}
        </div>
      </div>
      {m.on && (
        <input
          type="time"
          aria-label="Morning summary time"
          value={m.time}
          disabled={saving}
          onChange={(e) => e.target.value && void save(true, e.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
        />
      )}
      <button
        type="button"
        role="switch"
        aria-checked={m.on}
        aria-label="Morning summary"
        disabled={saving}
        onClick={() => void save(!m.on, m.time)}
        className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition", m.on ? "bg-[var(--accent)]" : "bg-[var(--surface-2)]")}
      >
        <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition", m.on ? "translate-x-5" : "translate-x-0.5")} />
      </button>
    </section>
  );
}
