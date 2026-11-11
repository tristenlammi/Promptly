import { CalendarDays, ChevronRight, ClipboardList, Clock, Dumbbell, Flame, Play, Plus, Settings2, Sparkles, Trophy } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, EmptyState, IconButton, ItemButton, List, ListRow, Page, Section, Sheet, Stat, StatGrid, addDays, fmtDay, fmtDuration, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { libraryFor } from "./catalog";
import { Logger, fmtSet } from "./Logger";
import { ArchiveCard, nearlyFull } from "./Archive";
import { TemplatesSheet } from "./Templates";
import { PR_LABEL, bestSet, buildActive, estimateMinutes, fmtBig, fmtMinutes, fmtRecord, historyIndex, isHard, isoWithOffset, streakWeeks, weekStartOf } from "./science";
import { ExerciseBadge, Pill, useWorkoutCtx, type Ctx } from "./shared";
import type { PlannedSession, Prescription, Routine, Settings, WorkoutData } from "./types";

/** Start the live logger (prefilled sets, warm-ups). Works from any tab and
 *  offline: the library is bundled and the history is in the file. */
export function startWorkout(item: ItemHandle<WorkoutData>, opts: { session?: PlannedSession | null; routine?: Routine | null; name?: string } = {}) {
  if (item.data.active || !item.canEdit) return;
  const rxs = opts.session?.exercises ?? opts.routine?.exercises ?? [];
  const name = opts.name ?? opts.session?.name ?? opts.routine?.name ?? "Workout";
  const lib = libraryFor(item.data);
  const w = buildActive(item.data, lib, historyIndex(item.data), uid, {
    name,
    rxs,
    sessionId: opts.session?.id,
    programId: opts.session?.program_id,
    deload: !!opts.session?.deload,
    startedAt: isoWithOffset(new Date()),
  });
  item.update((d) => {
    if (!d.active) d.active = structuredClone(w);
  });
}

export function todaysSession(data: WorkoutData): PlannedSession | null {
  const t = todayISO();
  return data.planned.find((p) => p.date === t && p.status === "planned") ?? null;
}

/** "3×8–10" — plans are sets × reps; weights are only ever suggested in the
 *  logger (an older plan's stored load still feeds that suggestion). */
export function rxSummary(rx: Prescription, _s: Settings, log: string): string {
  const reps = log === "duration" ? `${rx.seconds ?? "?"}s` : log === "distance" ? `${rx.meters ?? "?"} m` : rx.reps_min === rx.reps_max ? `${rx.reps_min}` : `${rx.reps_min}–${rx.reps_max}`;
  return `${rx.sets}×${reps}`;
}

export function Today({ item, isPhone, ask, goTo }: ItemViewProps<WorkoutData>) {
  const { ctx } = useWorkoutCtx(item);
  const [summary, setSummary] = useState<string | null>(null);
  const data = item.data;

  return (
    <Page wide={!isPhone && !data.active} className={data.active ? "max-w-3xl" : undefined}>
      {data.active ? (
        <Logger item={item} ctx={ctx} isPhone={isPhone} ask={ask} onFinished={(id) => setSummary(id)} />
      ) : (
        <Home item={item} ctx={ctx} isPhone={isPhone} ask={ask} goTo={goTo} />
      )}
      <SummarySheet id={summary} onClose={() => setSummary(null)} data={data} ctx={ctx} ask={ask} />
    </Page>
  );
}

function Home({ item, ctx, isPhone, ask, goTo }: { item: ItemHandle<WorkoutData>; ctx: Ctx; isPhone: boolean; ask: (p: string) => void; goTo: (t: string) => void }) {
  const [templates, setTemplates] = useState(false);
  const data = item.data;
  const s = data.settings;
  const { lib } = ctx;
  const today = todayISO();
  const session = todaysSession(data);
  const next = data.planned.find((p) => p.status === "planned" && p.date > today) ?? null;
  const missed = data.planned.filter((p) => p.status === "planned" && p.date < today && p.date >= addDays(today, -6));
  const ws = weekStartOf(today, s);
  const week = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const stats = useMemo(() => {
    const inWeek = data.workouts.filter((w) => w.date >= ws && w.date < addDays(ws, 7));
    const sets = inWeek.reduce((n, w) => n + w.exercises.reduce((m, we) => m + we.sets.filter(isHard).length, 0), 0);
    const vol = inWeek.reduce((n, w) => n + w.exercises.reduce((m, we) => (lib.get(we.exercise_id).log === "weight_reps" ? m + we.sets.filter(isHard).reduce((k, x) => k + (x.kg ?? 0) * (x.reps ?? 0), 0) : m), 0), 0);
    return { count: inWeek.length, sets, vol, streak: streakWeeks(data) };
  }, [data, ws, lib]);
  const last = data.workouts[data.workouts.length - 1];
  const program = data.programs.find((p) => p.status === "active");
  const programWeek = program ? Math.floor((new Date(today).getTime() - new Date(weekStartOf(program.start_date, s)).getTime()) / (7 * 86_400_000)) + 1 : null;

  const hero = session ?? null;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{fmtDay(today, { long: true })}</p>
          <h2 className="truncate text-xl font-semibold text-[var(--text)]">{hero ? "Today's workout" : next ? "Rest day" : "Ready when you are"}</h2>
          {program && programWeek && programWeek <= program.weeks.length && (
            <p className="text-xs text-[var(--text-muted)]">
              {program.name} · {program.weeks[programWeek - 1]?.deload ? "deload week" : `week ${programWeek} of ${program.weeks.length}`}
            </p>
          )}
        </div>
        <IconButton label="Settings" icon={Settings2} onClick={() => goTo("settings")} />
      </div>

      <div className={cn("grid gap-5", isPhone ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")}>
        <div className="flex flex-col gap-5">
          {/* Week strip */}
          <div className="grid grid-cols-7 gap-1" role="list" aria-label="This week">
            {week.map((d) => {
              const planned = data.planned.filter((p) => p.date === d);
              const did = data.workouts.some((w) => w.date === d);
              const isToday = d === today;
              return (
                <button
                  key={d}
                  type="button"
                  role="listitem"
                  onClick={() => goTo(did ? "history" : "plan")}
                  aria-label={`${fmtDay(d, { long: true })}: ${did ? "trained" : planned.length ? planned.map((p) => p.name).join(", ") : "nothing planned"}`}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl py-2 transition hover:bg-[var(--hover)]",
                    isToday && "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]",
                  )}
                >
                  <span className="text-[10px] font-medium uppercase text-[var(--text-muted)]">{new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "narrow" })}</span>
                  <span className={cn("text-sm font-semibold tabular-nums", isToday ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{Number(d.slice(8))}</span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      did ? "bg-[var(--success)]" : planned.some((p) => p.status === "planned") ? "bg-[var(--item-accent-fill)]" : planned.some((p) => p.status === "skipped") ? "bg-[var(--text-muted)]" : "bg-transparent",
                    )}
                  />
                </button>
              );
            })}
          </div>

          {hero ? (
            <SessionHero item={item} ctx={ctx} session={hero} />
          ) : (
            <Card className="flex flex-col gap-3">
              {next ? (
                <button type="button" onClick={() => goTo("plan")} className="flex items-center gap-3 text-left">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text-muted)]">
                    <CalendarDays className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-[var(--text-muted)]">Next · {fmtDay(next.date)}{next.time ? ` at ${next.time}` : ""}</span>
                    <span className="block truncate font-semibold text-[var(--text)]">{next.name}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">{next.exercises.map((rx) => lib.get(rx.exercise_id).name).join(" · ")}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />
                </button>
              ) : (
                <EmptyState
                  icon={Sparkles}
                  title="No plan yet"
                  text="Pick a proven program (full body, upper/lower, PPL…) fitted to your equipment — or ask the coach for a week with the weights to use."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {item.canEdit && (
                        <ItemButton variant="primary" icon={<ClipboardList className="h-4 w-4" />} onClick={() => setTemplates(true)}>
                          Pick a program
                        </ItemButton>
                      )}
                      <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Plan my training week with the exact weights to use, based on my goal and history")}>
                        Plan my week
                      </ItemButton>
                    </div>
                  }
                  className="border-none py-4"
                />
              )}
              {item.canEdit && (
                <div className="flex flex-wrap gap-2">
                  {next && next.date !== today && (
                    <ItemButton icon={<Play className="h-4 w-4" />} onClick={() => startWorkout(item, { session: next })} className="min-w-[10rem] flex-1 whitespace-nowrap">
                      <span className="truncate">Do {next.name} now</span>
                    </ItemButton>
                  )}
                  <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => startWorkout(item)} className="min-w-[10rem] flex-1 whitespace-nowrap">
                    Empty workout
                  </ItemButton>
                </div>
              )}
            </Card>
          )}

          {item.canEdit && nearlyFull(data) && <ArchiveCard item={item} />}

          {missed.length > 0 && item.canEdit && (
            <Card className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium text-[var(--text)]">Missed {missed.length === 1 ? missed[0].name : `${missed.length} sessions`}</span>
                <span className="block text-xs text-[var(--text-muted)]">From {fmtDay(missed[0].date)} — do it today or let the coach re-plan.</span>
              </div>
              <ItemButton size="sm" onClick={() => ask(`I missed ${missed.map((m) => `${m.name} on ${m.date}`).join(", ")}. Re-plan the rest of my week sensibly.`)}>
                Re-plan
              </ItemButton>
            </Card>
          )}

          {data.routines.length > 0 && item.canEdit && (
            <Section title="Start a routine">
              <List>
                {data.routines.slice(0, 6).map((r) => (
                  <ListRow
                    key={r.id}
                    title={r.name}
                    subtitle={`${r.exercises.length} exercises · ~${estimateMinutes(r.exercises, lib, s)} min`}
                    trailing={<Play className="h-4 w-4 text-[var(--item-accent)]" />}
                    onClick={() => startWorkout(item, { routine: r })}
                  />
                ))}
              </List>
            </Section>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <Section title="This week">
            <StatGrid className="md:grid-cols-2">
              <Stat label="Workouts" value={stats.count} unit={`/ ${s.days_per_week}`} icon={Dumbbell} tone="accent" />
              <Stat label="Week streak" value={stats.streak} unit={stats.streak === 1 ? "week" : "weeks"} icon={Flame} />
              <Stat label="Hard sets" value={stats.sets} icon={Trophy} />
              <Stat label="Volume" value={fmtBig(stats.vol, s)} unit={s.units} />
            </StatGrid>
          </Section>
          {last && (
            <Section title="Last workout" action={<ItemButton size="sm" variant="ghost" onClick={() => goTo("history")}>History</ItemButton>}>
              <Card onClick={() => goTo("history")} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-[var(--text)]">{last.name}</span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">{fmtDay(last.date)}{last.duration_s ? ` · ${fmtMinutes(last.duration_s)}` : ""}</span>
                </div>
                <ul className="flex flex-col gap-1">
                  {last.exercises.slice(0, 5).map((we) => {
                    const ex = lib.get(we.exercise_id);
                    const hard = we.sets.filter(isHard);
                    const best = bestSet(we, ex, s);
                    return (
                      <li key={we.id} className="flex justify-between gap-2 text-xs">
                        <span className="truncate text-[var(--text)]">{hard.length} × {ex.name}</span>
                        <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{best ? fmtSet(best, ex, s) : ""}</span>
                      </li>
                    );
                  })}
                </ul>
                {(ctx.prs.get(last.id)?.length ?? 0) > 0 && <Pill tone="accent" className="self-start"><Trophy className="h-3 w-3" /> {ctx.prs.get(last.id)!.length} PR{ctx.prs.get(last.id)!.length === 1 ? "" : "s"}</Pill>}
              </Card>
            </Section>
          )}
          <Section title="Coach">
            <div className="flex flex-col gap-2">
              {[
                ["Plan my training week with the weights to use", "Plan my week"],
                ["Review my last 4 weeks: consistency, volume per muscle vs landmarks, PRs and stalled lifts. What should I change?", "Review my training"],
                [`I have ${s.session_minutes} minutes today — what should I do?`, "What should I do today?"],
              ].map(([prompt, label]) => (
                <button key={label} type="button" onClick={() => ask(prompt)} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left text-sm text-[var(--text)] hover:border-[var(--item-accent)]">
                  <Sparkles className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
                  {label}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>
      <TemplatesSheet open={templates} onClose={() => setTemplates(false)} item={item} lib={lib} />
      {/* No Fab: the card above already starts a workout, and a floating
          button covered the routine list's start buttons on a phone. */}
    </>
  );
}

function SessionHero({ item, ctx, session }: { item: ItemHandle<WorkoutData>; ctx: Ctx; session: PlannedSession }) {
  const s = item.data.settings;
  const { lib, hist } = ctx;
  const mins = estimateMinutes(session.exercises, lib, s);
  return (
    <Card className="flex flex-col gap-3 border-[color-mix(in_srgb,var(--item-accent)_40%,var(--border))]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold text-[var(--text)]">{session.name}</h3>
          <p className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <Clock className="h-3.5 w-3.5" /> ~{mins} min · {session.exercises.length} exercises
            {session.time && ` · ${session.time}`}
            {session.deload && " · deload"}
          </p>
        </div>
        {session.deload && <Pill tone="warn">Deload</Pill>}
      </div>
      {session.notes && <p className="text-sm text-[var(--text-muted)]">{session.notes}</p>}
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {session.exercises.map((rx) => {
          const ex = lib.get(rx.exercise_id);
          const last = hist.get(ex.id)?.slice(-1)[0];
          return (
            <li key={rx.id} className="flex items-center gap-3 py-2">
              <ExerciseBadge ex={ex} lib={lib} size={34} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text)]">
                  {rx.superset && <span className="mr-1 text-[var(--item-accent)]">{rx.superset}</span>}
                  {ex.name}
                </div>
                <div className="truncate text-xs tabular-nums text-[var(--text-muted)]">
                  {rxSummary(rx, s, ex.log)}
                  {last && last.we.sets.some(isHard) && ` · last ${fmtSet(last.we.sets.filter(isHard)[0], ex, s)}`}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {item.canEdit && (
        <div className="flex gap-2">
          <ItemButton variant="primary" size="lg" block icon={<Play className="h-5 w-5" />} onClick={() => startWorkout(item, { session })} className="flex-1">
            Start workout
          </ItemButton>
          <ItemButton
            size="lg"
            onClick={() => {
              const target = addDays(session.date, 1); // the day after the one on screen
              item.update((d) => {
                const p = d.planned.find((x) => x.id === session.id);
                if (p) p.date = target;
              });
            }}
          >
            Tomorrow
          </ItemButton>
        </div>
      )}
    </Card>
  );
}

function SummarySheet({ id, onClose, data, ctx, ask }: { id: string | null; onClose: () => void; data: WorkoutData; ctx: Ctx; ask: (p: string) => void }) {
  const w = id ? data.workouts.find((x) => x.id === id) : null;
  const s = data.settings;
  if (!w) return null;
  const prs = ctx.prs.get(w.id) ?? [];
  const sets = w.exercises.reduce((n, we) => n + we.sets.filter(isHard).length, 0);
  const vol = w.exercises.reduce((n, we) => (ctx.lib.get(we.exercise_id).log === "weight_reps" ? n + we.sets.filter(isHard).reduce((m, x) => m + (x.kg ?? 0) * (x.reps ?? 0), 0) : n), 0);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Workout complete"
      footer={
        <>
          <ItemButton block onClick={() => { onClose(); ask(`Review the workout I just finished (${w.name}) and tell me what to change next time.`); }} icon={<Sparkles className="h-4 w-4" />}>
            Coach review
          </ItemButton>
          <ItemButton variant="primary" block onClick={onClose}>
            Done
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4" aria-live="polite">
        <div className="flex flex-col items-center gap-1 py-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] text-[var(--item-accent)]">
            <Trophy className="h-7 w-7" />
          </span>
          <p className="text-lg font-semibold text-[var(--text)]">{w.name}</p>
          <p className="text-xs text-[var(--text-muted)]">{fmtDay(w.date, { long: true })}</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Time" value={fmtDuration(w.duration_s ?? 0)} />
          <Stat label="Sets" value={sets} />
          <Stat label="Volume" value={fmtBig(vol, s)} unit={s.units} />
        </div>
        {/* Strong's summary: every exercise with its sets and best set. */}
        <div className="flex flex-col divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)]">
          {w.exercises.map((we) => {
            const ex = ctx.lib.get(we.exercise_id);
            const hard = we.sets.filter(isHard);
            const best = bestSet(we, ex, s);
            const pr = prs.some((p) => p.exerciseId === ex.id);
            return (
              <div key={we.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                  {hard.length ? `${hard.length} × ` : ""}
                  {ex.name}
                  {!hard.length && <span className="text-[var(--text-muted)]"> · warm-up only</span>}
                </span>
                {pr && <Trophy className="h-3.5 w-3.5 shrink-0 text-[var(--item-accent)]" aria-label="Personal record" />}
                <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{best ? fmtSet(best, ex, s) : "—"}</span>
              </div>
            );
          })}
        </div>
        {prs.length > 0 ? (
          <Section title={`${prs.length} personal record${prs.length === 1 ? "" : "s"}`}>
            <List>
              {prs.map((p, i) => (
                <ListRow
                  key={i}
                  leading={<Trophy className="h-4 w-4 text-[var(--item-accent)]" />}
                  title={ctx.lib.get(p.exerciseId).name}
                  subtitle={p.previous != null ? `was ${fmtRecord(p.kind, p.previous, s)}` : "new"}
                  trailing={<span className="font-semibold tabular-nums text-[var(--text)]">{PR_LABEL[p.kind]} {fmtRecord(p.kind, p.value, s)}</span>}
                />
              ))}
            </List>
          </Section>
        ) : (
          <p className="text-center text-sm text-[var(--text-muted)]">No new records this time — consistency is what builds them.</p>
        )}
      </div>
    </Sheet>
  );
}
