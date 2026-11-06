import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CalendarDays,
  Check,
  Clock,
  Plus,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Dumbbell,
  Hash,
  Images,
  LayoutGrid,
  Link2,
  ListChecks,
  MessageCircle,
  Repeat,
  SlidersHorizontal,
  UtensilsCrossed,
} from "lucide-react";

import { todayApi, type TodayData, type TodayHabit, type TodayTask } from "@/api/today";
import { itemsApi } from "@/items/api";
import { workspacesApi } from "@/api/workspaces";
import { TopNav } from "@/components/layout/TopNav";
import { Skeleton } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";
import { RecentStrip } from "@/components/today/RecentStrip";
import {
  AttentionStrip,
  AutomationsCard,
  BudgetCard,
  ComingCard,
  DiscoverCard,
  GlanceRow,
  HealthCard,
  JournalCard, MailCard, PasswordsCard,
  MedsCard,
  NutritionCard,
  PeopleCard,
  Ring,
  ScheduleCard,
  StudyCard,
  TripCard,
  hhmm,
  nextUp,
  MapsCard,
} from "@/components/today/HubCards";
import { useUIStore } from "@/store/uiStore";
import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";

/**
 * Today — what your day holds across Promptly, on one page: events, tasks
 * due, habits to tick, the workout and meals planned, "on this day" photos,
 * unread rooms, and your cards and shifts. Each section is there only when
 * you use that app, and links into it; tasks and habits tick off right here
 * (through each app's own actions). One backend call (``/api/today``).
 */

const QUERY_KEY = ["today"];

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
    // Often enough that a dose coming due shows without a reload.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  return (
    <>
      <TopNav title="Today" actions={<CustomiseToday />} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl px-4 py-5 md:py-8">
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

/** Every card Today can show, in the default order. ``recent`` sits at the
 *  top and ``morning`` at the bottom; the rest are the grid, in your order. */
const SECTIONS: { key: string; label: string; grid: boolean }[] = [
  { key: "attention", label: "Needs you", grid: false },
  { key: "glance", label: "At a glance", grid: false },
  { key: "recent", label: "Recently opened", grid: false },
  { key: "events", label: "Schedule", grid: true },
  { key: "mail", label: "Mail", grid: true },
  { key: "passwords", label: "Passwords", grid: true },
  { key: "meds", label: "Medication", grid: true },
  { key: "tasks", label: "Tasks", grid: true },
  { key: "habits", label: "Habits", grid: true },
  { key: "nutrition", label: "Food and water", grid: true },
  { key: "health", label: "Body & Health", grid: true },
  { key: "workout", label: "Workout", grid: true },
  { key: "meals", label: "Meal plan", grid: true },
  { key: "coming", label: "Coming up", grid: true },
  { key: "budget", label: "Budget and bills", grid: true },
  { key: "trip", label: "Next trip", grid: true },
  { key: "maps", label: "Getting there", grid: true },
  { key: "study", label: "Flashcards", grid: true },
  { key: "journal", label: "Journal", grid: true },
  { key: "people", label: "People", grid: true },
  { key: "work", label: "Workspace cards and shifts", grid: true },
  { key: "rooms", label: "Unread rooms", grid: true },
  { key: "automations", label: "Automations", grid: true },
  { key: "photos", label: "On this day", grid: true },
  { key: "discover", label: "Suggested apps", grid: true },
  { key: "morning", label: "Morning summary", grid: false },
];
const GRID_KEYS = SECTIONS.filter((x) => x.grid).map((x) => x.key);
const TOP_SECTIONS = SECTIONS.filter((x) => !x.grid && x.key !== "morning");

/** Your Today layout — hidden cards and the grid order — from your settings. */
function useTodayLayout() {
  const settings = useAuthStore((st) => st.user?.settings);
  const patchSettings = useAuthStore((st) => st.patchSettings);
  const setUser = useAuthStore((st) => st.setUser);
  const hidden = new Set(settings?.today_hidden ?? []);
  const saved = settings?.today_order ?? [];
  const order = [...saved.filter((k) => GRID_KEYS.includes(k)), ...GRID_KEYS.filter((k) => !saved.includes(k))];
  const save = async (patch: { today_hidden?: string[]; today_order?: string[] }) => {
    const before = { today_hidden: settings?.today_hidden, today_order: settings?.today_order };
    patchSettings(patch);
    try {
      setUser(await authApi.updatePreferences(patch));
    } catch (err) {
      patchSettings(before);
      toast.error(apiErrorMessage(err, "Couldn't save your layout."));
    }
  };
  return { hidden, order, save };
}

function TodayBody({ data }: { data: TodayData }) {
  const s = data.sections;
  const summary = summaryLine(data);
  const next = nextUp(data);
  const { hidden, order } = useTodayLayout();
  const cards: Record<string, ReactNode> = {
    events: (s.events || data.schedule.items.length > 0 || data.schedule.all_day.length > 0) && <ScheduleCard data={data} />,
    mail: s.mail && <MailCard m={s.mail} />,
    passwords: s.passwords && <PasswordsCard p={s.passwords} />,
    meds: s.health && s.health.doses.length > 0 && <MedsCard health={s.health} />,
    health: s.health && <HealthCard health={s.health} today={data.date} hideWater={!!s.nutrition} />,
    nutrition: s.nutrition && <NutritionCard n={s.nutrition} />,
    coming: data.coming.length > 0 && <ComingCard coming={data.coming} today={data.date} />,
    budget: s.budget && <BudgetCard b={s.budget} today={data.date} />,
    trip: s.trip && <TripCard t={s.trip} />,
    maps: s.maps && <MapsCard m={s.maps} />,
    study: s.study && <StudyCard s={s.study} />,
    journal: s.journal && <JournalCard j={s.journal} />,
    people: s.people && <PeopleCard p={s.people} today={data.date} />,
    automations: s.automations && <AutomationsCard a={s.automations} />,
    discover: data.discover.length > 0 && <DiscoverCard apps={data.discover} />,
    tasks: s.tasks && <TasksCard tasks={s.tasks} />,
    habits: s.habits && <HabitsCard habits={s.habits} />,
    workout: s.workout && (
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
        ),
    meals: s.meals && (
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
        ),
    work: s.work && <WorkCard work={s.work} />,
    rooms: s.rooms && (
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
        ),
    photos: s.photos && (
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
        ),
  };
  const shown = order.filter((k) => !hidden.has(k) && cards[k]);
  const anyData = Object.values(cards).some(Boolean);
  return (
    <>
      <header className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 md:mb-5">
        {data.progress && (
          <Ring pct={data.progress.pct} size={64} stroke={6}>
            <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{data.progress.pct}%</span>
          </Ring>
        )}
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)] md:text-3xl">{data.greeting}</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {longDate(data.date)}
            {summary ? ` · ${summary}` : ""}
          </p>
          {next && (
            <Link to={next.url} className="mt-1 inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-[var(--accent-text)] hover:underline">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{next.due ? "Due now" : `Next at ${hhmm(next.time)}`}: {next.title}</span>
            </Link>
          )}
        </div>
        <QuickAdd />
      </header>

      {!hidden.has("attention") && <AttentionStrip items={data.attention} />}
      {!hidden.has("glance") && <GlanceRow data={data} />}
      {!hidden.has("recent") && <RecentStrip />}

      {/* Masonry: cards keep your order, top to bottom, and leave no gaps. */}
      <div className="columns-1 gap-3 md:columns-2 md:gap-4 xl:columns-3">
        {shown.map((k) => (
          <div key={k} id={`today-${k}`} className="mb-3 scroll-mt-4 break-inside-avoid md:mb-4">
            {cards[k]}
          </div>
        ))}
      </div>

      {!anyData ? (
        <p className="mt-6 text-center text-sm text-[var(--text-muted)]">
          A clear day. Add events in Calendar, or apps like Tasks, Habits and Meal planner from Apps — they'll show up here.
        </p>
      ) : !shown.length ? (
        <p className="mt-6 text-center text-sm text-[var(--text-muted)]">Every card is hidden — use Customise to bring some back.</p>
      ) : null}

      {!hidden.has("morning") && <MorningCard data={data} />}
    </>
  );
}

/** Pick which cards Today shows and the order they come in. */
function CustomiseToday() {
  const { hidden, order, save } = useTodayLayout();
  const [open, setOpen] = useState(false);
  const rows = [...TOP_SECTIONS, ...order.map((k) => SECTIONS.find((x) => x.key === k)!), SECTIONS[SECTIONS.length - 1]];
  const toggle = (key: string) => {
    const next = hidden.has(key) ? [...hidden].filter((k) => k !== key) : [...hidden, key];
    void save({ today_hidden: next });
  };
  const move = (key: string, by: number) => {
    const i = order.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    void save({ today_order: next });
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--hover)]"
      >
        <SlidersHorizontal className="h-4 w-4" />
        <span className="hidden sm:inline">Customise</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 max-h-[75vh] w-72 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg">
            <p className="px-2 pb-2 pt-1 text-xs text-[var(--text-muted)]">Choose what Today shows. A card only appears when there's something in it.</p>
            <ul>
              {rows.map((r) => {
                const i = order.indexOf(r.key);
                return (
                  <li key={r.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
                      <input type="checkbox" checked={!hidden.has(r.key)} onChange={() => toggle(r.key)} />
                      <span className="truncate">{r.label}</span>
                    </label>
                    {r.grid && (
                      <span className="flex shrink-0">
                        <button type="button" aria-label={`Move ${r.label} up`} disabled={i <= 0} onClick={() => move(r.key, -1)} className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30">
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" aria-label={`Move ${r.label} down`} disabled={i >= order.length - 1} onClick={() => move(r.key, 1)} className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30">
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={() => void save({ today_hidden: [], today_order: [] })}
              className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-[var(--accent-text)] hover:bg-[var(--hover)]"
            >
              Reset to default
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function summaryLine(data: TodayData): string {
  const s = data.sections;
  const bits: string[] = [];
  const doses = s.health?.doses_due ?? 0;
  if (doses) bits.push(`${plural(doses, "dose")} due`);
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

/** Add anything from here: the Ctrl+K box understands "new event lunch fri
 *  1pm", "add task buy milk tomorrow", "log $40 fuel", "note ...". */
function QuickAdd() {
  const open = useUIStore((st) => st.openSearchPalette);
  return (
    <button
      type="button"
      onClick={open}
      title="Try: new event lunch fri 1pm, add task buy milk tomorrow, log $40 fuel"
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] transition hover:bg-[var(--hover)]"
    >
      <Plus className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
      Add anything
      <kbd className="hidden rounded border border-[var(--border)] px-1 text-[10px] text-[var(--text-muted)] md:inline">Ctrl K</kbd>
    </button>
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

type WorkShift = NonNullable<TodayData["sections"]["work"]>["shifts"][number];

function shiftTime(s: WorkShift): string {
  return s.start && s.end ? `${s.start}–${s.end}` : s.hours ? `${s.hours}h` : "";
}

/** Your workspace cards and shifts — what the My work page used to hold:
 *  today's shifts, the week's coming ones, then every open card assigned to
 *  you (overdue first), six at a time. */
function WorkCard({ work }: { work: NonNullable<TodayData["sections"]["work"]> }) {
  const [all, setAll] = useState(false);
  const upcoming = work.upcoming ?? [];
  const cards = all ? work.cards : work.cards.slice(0, 6);
  const copyFeed = async () => {
    try {
      const url = await workspacesApi.shiftsCalendarLink();
      await navigator.clipboard.writeText(url);
      toast.success("Calendar link copied — add it to your calendar app as a subscription.");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't get the calendar link."));
    }
  };
  const title = work.due_count ? `Workspaces · ${work.due_count} due` : work.open_count ? `Workspaces · ${work.open_count} open` : "Workspaces";
  return (
    <Card icon={<LayoutGrid className="h-4 w-4" />} title={title} to={work.url} open="Workspaces">
      <ul className="space-y-0.5">
        {work.shifts.map((s, i) => (
          <li key={`shift-${i}`}>
            <Link to={s.url} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">Shift today{shiftTime(s) ? ` · ${shiftTime(s)}` : ""}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {s.workspace} · {s.roster}
                  {s.note ? ` · ${s.note}` : ""}
                </span>
              </span>
            </Link>
          </li>
        ))}
        {upcoming.map((s, i) => (
          <li key={`up-${i}`}>
            <Link to={s.url} className="flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-[var(--hover)]">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
                <span className="text-[var(--text)]">
                  {new Date(`${s.date}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
                </span>
                {shiftTime(s) ? ` · ${shiftTime(s)}` : ""} · {s.roster}
              </span>
            </Link>
          </li>
        ))}
        {cards.map((c) => (
          <li key={c.id}>
            <Link to={c.url} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--hover)]">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", c.overdue ? "bg-[var(--danger)]" : c.due ? "bg-[var(--accent)]" : "bg-[var(--border)]")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.title}</span>
                <span className={cn("block truncate text-xs", c.overdue ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                  {[c.overdue ? "Overdue" : c.due ? `Due ${c.due === todayIso() ? "today" : new Date(`${c.due}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}` : "", c.workspace, c.board].filter(Boolean).join(" · ")}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {(work.cards.length > 6 || work.shifts.length + upcoming.length > 0) && (
        <div className="mt-1 flex items-center justify-between px-2 text-xs">
          {work.cards.length > 6 ? (
            <button type="button" onClick={() => setAll((v) => !v)} className="font-medium text-[var(--accent-text)] hover:underline">
              {all ? "Show fewer" : `Show all ${work.cards.length} cards`}
            </button>
          ) : (
            <span />
          )}
          {work.shifts.length + upcoming.length > 0 && (
            <button type="button" onClick={() => void copyFeed()} className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline">
              <Link2 className="h-3 w-3" />
              Shifts calendar link
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
