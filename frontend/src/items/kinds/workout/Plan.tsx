import { ArrowDown, ArrowUp, CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Copy, Play, Plus, Repeat2, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, EmptyState, Field, IconButton, ItemButton, List, ListRow, Page, Section, Segmented, Select, Sheet, TextArea, TextInput, addDays, fmtDay, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { ExercisePicker } from "./ExercisePicker";

import { estimateMinutes, fmtW, fmtWeekRange, prefill, weekStartOf, weeklyVolume } from "./science";
import { ActiveBanner, ExerciseBadge, Pill, recentIds, useWorkoutCtx, type Ctx } from "./shared";
import { rxSummary, startWorkout } from "./Today";
import type { Exercise, PlannedSession, Prescription, Routine, Settings, WorkoutData } from "./types";
import { TemplatesSheet } from "./Templates";
import { VolumeBars } from "./Volume";

type Target = { kind: "session"; id: string } | { kind: "routine"; id: string };

function newRx(ex: Exercise): Prescription {
  const iso = !ex.compound;
  return {
    id: uid("x"),
    exercise_id: ex.id,
    sets: 3,
    reps_min: ex.log === "duration" || ex.log === "distance" ? 1 : iso ? 10 : 6,
    reps_max: ex.log === "duration" || ex.log === "distance" ? 1 : iso ? 15 : 10,
    seconds: ex.log === "duration" ? 45 : null,
    meters: ex.log === "distance" ? 1000 : null,
    load_kg: null,
    load_pct: null,
    rest_s: null,
    superset: null,
    warmup: null,
    drop_sets: 0,
    notes: "",
  };
}

export function Plan({ item, isPhone, ask, goTo }: ItemViewProps<WorkoutData>) {
  const { ctx } = useWorkoutCtx(item);
  const data = item.data;
  const s = data.settings;
  const [week, setWeek] = useState(() => weekStartOf(todayISO(), s));
  // undefined = nothing picked yet (desktop shows today's / the next session); null = closed.
  const [picked, setTarget] = useState<Target | null | undefined>(undefined);
  const [mode, setMode] = useState<"week" | "routines">("week");
  const [templates, setTemplates] = useState(false);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const planned = useMemo(() => (ctx ? weeklyVolume(data, ctx.lib, week, "planned") : {}), [data, ctx, week]);
  const { lib } = ctx;
  const program = data.programs.find((p) => p.status === "active");
  const today = todayISO();
  const weekSessions = data.planned.filter((p) => p.date >= week && p.date < addDays(week, 7));
  const totalSets = weekSessions.reduce((n, p) => n + p.exercises.reduce((m, rx) => m + rx.sets, 0), 0);
  const auto = !isPhone && picked === undefined ? (weekSessions.find((p) => p.date >= today && p.status === "planned") ?? weekSessions.find((p) => p.status === "planned") ?? null) : null;
  const target: Target | null = picked ?? (auto ? { kind: "session", id: auto.id } : null);

  const addSession = (date: string) => {
    const id = uid("s");
    item.update((d) => {
      d.planned.push({ id, date, time: null, name: "Workout", notes: "", exercises: [], program_id: null, week: null, deload: false, status: "planned", workout_id: null });
      d.planned.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
    });
    setTarget({ kind: "session", id });
  };
  const addRoutine = () => {
    const id = uid("r");
    item.update((d) => {
      d.routines.push({ id, name: "New routine", notes: "", exercises: [] });
    });
    setTarget({ kind: "routine", id });
  };

  const editor = target ? <Editor item={item} ctx={ctx} target={target} onClose={() => setTarget(null)} onStarted={() => goTo("today")} isPhone={isPhone} /> : null;
  const weekLabel = week === weekStartOf(today, s) ? `This week · ${fmtWeekRange(week)}` : fmtWeekRange(week);
  const progWeek = program ? Math.floor((new Date(week).getTime() - new Date(weekStartOf(program.start_date, s)).getTime()) / (7 * 86_400_000)) + 1 : null;

  const left = (
    <div className="flex flex-col gap-4">
      <ActiveBanner data={data} goTo={goTo} />
      <Segmented value={mode} onChange={setMode} options={[{ value: "week", label: "Calendar" }, { value: "routines", label: `Routines${data.routines.length ? ` (${data.routines.length})` : ""}` }]} />
      {mode === "week" ? (
        <>
          <div className="flex items-center gap-1">
            <IconButton label="Previous week" icon={ChevronLeft} onClick={() => setWeek(addDays(week, -7))} />
            <div className="min-w-0 flex-1 text-center">
              <div className="truncate text-sm font-semibold text-[var(--text)]">{weekLabel}</div>
              <div className="text-xs text-[var(--text-muted)]">
                {weekSessions.length} session{weekSessions.length === 1 ? "" : "s"} · {totalSets} sets
                {program && progWeek && progWeek >= 1 && progWeek <= program.weeks.length ? ` · ${program.name} ${program.weeks[progWeek - 1]?.deload ? "deload" : `wk ${progWeek}`}` : ""}
              </div>
            </div>
            <IconButton label="Next week" icon={ChevronRight} onClick={() => setWeek(addDays(week, 7))} />
          </div>
          {week !== weekStartOf(today, s) && (
            <ItemButton size="sm" variant="ghost" onClick={() => setWeek(weekStartOf(today, s))} className="self-center">
              Back to this week
            </ItemButton>
          )}
          {program && <ProgramCard item={item} ctx={ctx} programId={program.id} ask={ask} />}
          {/* The week as one list (Strong/Hevy-style): a date column, the
              session(s) beside it; rest days stay a single quiet line. */}
          <div className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]" role="list" aria-label="This week's plan">
            {days.map((d) => {
              const sessions = data.planned.filter((p) => p.date === d);
              const did = data.workouts.filter((w) => w.date === d && !sessions.some((p) => p.workout_id === w.id));
              const isToday = d === today;
              const rest = sessions.length === 0 && did.length === 0;
              return (
                <div key={d} role="listitem" className={cn("flex items-start gap-2 px-2", rest ? "py-1" : "py-1.5", isToday && "bg-[color-mix(in_srgb,var(--item-accent)_7%,transparent)]")}>
                  <div className={cn("flex w-11 shrink-0 flex-col items-center", rest ? "py-1" : "py-1.5")} aria-label={fmtDay(d, { long: true })}>
                    <span className={cn("text-[10px] font-semibold uppercase tracking-wide", isToday ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
                      {isToday ? "Today" : new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span className={cn("font-semibold tabular-nums leading-tight", rest ? "text-sm" : "text-lg", isToday ? "text-[var(--item-accent)]" : rest ? "text-[var(--text-muted)]" : "text-[var(--text)]")}>{Number(d.slice(8))}</span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    {rest && <p className="flex min-h-9 items-center text-xs text-[var(--text-muted)]">Rest day</p>}
                    {did.map((w) => (
                      <div key={w.id} className="flex min-h-11 items-center gap-2 px-2 text-sm text-[var(--text)]">
                        <span className="truncate font-semibold">{w.name}</span> <Pill tone="good">Done</Pill>
                      </div>
                    ))}
                    {sessions.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setTarget({ kind: "session", id: p.id })}
                        className={cn("flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-[var(--hover)]", target?.id === p.id && !isPhone && "bg-[var(--hover)]")}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={cn("truncate text-sm font-semibold", p.status === "skipped" ? "text-[var(--text-muted)] line-through" : "text-[var(--text)]")}>{p.name}</span>
                            {p.status === "done" && <Pill tone="good">Done</Pill>}
                            {p.status === "skipped" && <Pill>Skipped</Pill>}
                            {p.deload && <Pill tone="warn">Deload</Pill>}
                          </div>
                          <div className="truncate text-xs text-[var(--text-muted)]">
                            {p.time ? `${p.time} · ` : ""}
                            {p.exercises.length ? `${p.exercises.length} exercises · ${p.exercises.reduce((n, rx) => n + rx.sets, 0)} sets · ~${estimateMinutes(p.exercises, lib, s)} min` : "No exercises yet"}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                      </button>
                    ))}
                  </div>
                  {item.canEdit && d >= today && rest && (
                    <button type="button" onClick={() => addSession(d)} aria-label={`Add a session on ${fmtDay(d, { long: true })}`} className={cn("flex shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]", rest ? "h-9 w-9 mt-0.5" : "mt-1.5 h-10 w-10")}>
                      <Plus className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {weekSessions.length === 0 && (
            <EmptyState
              icon={CalendarDays}
              title="Nothing planned this week"
              text="Tap + on a day to build a session, start from a proven program, or let the coach plan the week with loads from your history."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {item.canEdit && (
                    <ItemButton icon={<ClipboardList className="h-4 w-4" />} onClick={() => setTemplates(true)}>
                      Use a template
                    </ItemButton>
                  )}
                  <ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(`Plan my training for the week of ${week} with the exact weights to use.`)}>
                    Plan this week
                  </ItemButton>
                </div>
              }
            />
          )}
          {weekSessions.length > 0 && (
            <Section title="Planned volume" hint="Sets per muscle this week vs landmarks" action={<ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask(`Check my plan for the week of ${week}: is the volume per muscle right for my goal and does each session fit my time? Fix what isn't.`)}>Check</ItemButton>}>
              <Card>
                <VolumeBars sets={planned} muscles={lib.catalog.muscles} only="trained" compact={isPhone} />
              </Card>
            </Section>
          )}
          <div className="flex flex-wrap gap-2">
            <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(`Plan my training for the week of ${week} with the exact weights to use.`)} className="flex-1">
              {weekSessions.length ? "Re-plan this week" : "Plan this week"}
            </ItemButton>
            {!program && (
              <ItemButton icon={<ClipboardList className="h-4 w-4" />} onClick={() => ask("Build me a mesocycle (4–6 weeks with a deload) for my goal, starting this week, with the weights to use.")} className="flex-1">
                Build a program
              </ItemButton>
            )}
          </div>
        </>
      ) : (
        <Routines item={item} ctx={ctx} onOpen={(id) => setTarget({ kind: "routine", id })} onAdd={addRoutine} onTemplates={() => setTemplates(true)} ask={ask} />
      )}
      <TemplatesSheet open={templates} onClose={() => setTemplates(false)} item={item} lib={lib} />
    </div>
  );

  if (isPhone)
    return (
      <Page>
        {left}
        {target && (
          <Sheet open onClose={() => setTarget(null)} title={target.kind === "routine" ? "Routine" : "Session"} size="full">
            {editor}
          </Sheet>
        )}
      </Page>
    );
  return (
    <Page wide>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-6">
        {left}
        <div className="sticky top-4">
          {editor ?? (
            <Card className="flex flex-col items-center gap-2 py-12 text-center">
              <CalendarDays className="h-8 w-8 text-[var(--text-muted)]" />
              <p className="text-sm font-medium text-[var(--text)]">Pick a session to edit it</p>
              <p className="max-w-xs text-xs text-[var(--text-muted)]">Sets × reps × load for every exercise — or press + on a day to add one.</p>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

function ProgramCard({ item, ctx, programId, ask }: { item: ItemHandle<WorkoutData>; ctx: Ctx; programId: string; ask: (p: string) => void }) {
  const p = item.data.programs.find((x) => x.id === programId)!;
  const s = item.data.settings;
  const cur = Math.floor((new Date(todayISO()).getTime() - new Date(weekStartOf(p.start_date, s)).getTime()) / (7 * 86_400_000)) + 1;
  const sessions = item.data.planned.filter((x) => x.program_id === p.id);
  const done = sessions.filter((x) => x.status === "done").length;
  const [confirm, setConfirm] = useState(false);
  void ctx;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-[var(--item-accent)]">Program</div>
          <div className="truncate font-semibold text-[var(--text)]">{p.name}</div>
          <div className="text-xs text-[var(--text-muted)]">
            From {fmtDay(p.start_date)} · {done}/{sessions.length} sessions done
          </div>
        </div>
        {item.canEdit && (
          <ItemButton size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            End
          </ItemButton>
        )}
      </div>
      <div className="flex gap-1" aria-label="Program weeks">
        {p.weeks.map((w) => (
          <div key={w.n} className="flex flex-1 flex-col items-center gap-1" title={w.label || `Week ${w.n}`}>
            <div className={cn("h-2 w-full rounded-full", w.deload ? "bg-[color-mix(in_srgb,var(--warning)_45%,transparent)]" : w.n < cur ? "bg-[var(--item-accent)]" : w.n === cur ? "bg-[color-mix(in_srgb,var(--item-accent)_55%,transparent)]" : "bg-[var(--surface-2)]")} />
            <span className={cn("text-[10px] tabular-nums", w.n === cur ? "font-semibold text-[var(--text)]" : "text-[var(--text-muted)]")}>{w.deload ? "DL" : w.n}</span>
          </div>
        ))}
      </div>
      {p.notes && <p className="text-xs text-[var(--text-muted)]">{p.notes}</p>}
      <Sheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="End this program?"
        size="sm"
        footer={
          <>
            <ItemButton block onClick={() => { setConfirm(false); ask(`My program "${p.name}" is ending. Review how it went and build the next block.`); }}>
              Review & plan next
            </ItemButton>
            <ItemButton
              variant="danger"
              block
              onClick={() => {
                const t = todayISO();
                item.update((d) => {
                  const x = d.programs.find((y) => y.id === p.id);
                  if (x) x.status = "done";
                  d.planned = d.planned.filter((y) => !(y.program_id === p.id && y.status === "planned" && y.date >= t));
                });
                setConfirm(false);
              }}
            >
              End & clear upcoming
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text-muted)]">Its upcoming sessions are removed; everything you've logged stays.</p>
      </Sheet>
    </Card>
  );
}

function Routines({ item, ctx, onOpen, onAdd, onTemplates, ask }: { item: ItemHandle<WorkoutData>; ctx: Ctx; onOpen: (id: string) => void; onAdd: () => void; onTemplates: () => void; ask: (p: string) => void }) {
  const s = item.data.settings;
  if (!item.data.routines.length)
    return (
      <EmptyState
        icon={ClipboardList}
        title="No routines yet"
        text="Routines are reusable workouts — Push, Pull, Legs, Full body A… Start one in a tap, or schedule it on days."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {item.canEdit && <ItemButton variant="primary" icon={<ClipboardList className="h-4 w-4" />} onClick={onTemplates}>Templates</ItemButton>}
            {item.canEdit && <ItemButton icon={<Plus className="h-4 w-4" />} onClick={onAdd}>New routine</ItemButton>}
            <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Create a set of routines for my goal and days per week (e.g. an upper/lower or push/pull/legs split).")}>
              Ask the coach
            </ItemButton>
          </div>
        }
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <List>
        {item.data.routines.map((r) => (
          <ListRow
            key={r.id}
            title={r.name}
            subtitle={`${r.exercises.length} exercises · ~${estimateMinutes(r.exercises, ctx.lib, s)} min · ${r.exercises.slice(0, 3).map((x) => ctx.lib.get(x.exercise_id).name.replace(/ \(.*\)$/, "")).join(", ")}`}
            onClick={() => onOpen(r.id)}
            trailing={<ChevronRight className="h-4 w-4" />}
          />
        ))}
      </List>
      {item.canEdit && (
        <div className="flex gap-2">
          <ItemButton icon={<Plus className="h-4 w-4" />} onClick={onAdd} className="flex-1">
            New routine
          </ItemButton>
          <ItemButton icon={<ClipboardList className="h-4 w-4" />} onClick={onTemplates} className="flex-1">
            Templates
          </ItemButton>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- editor */

function Editor({ item, ctx, target, onClose, onStarted, isPhone }: { item: ItemHandle<WorkoutData>; ctx: Ctx; target: Target; onClose: () => void; onStarted: () => void; isPhone: boolean }) {
  const data = item.data;
  const s = data.settings;
  const { lib } = ctx;
  const session = target.kind === "session" ? data.planned.find((p) => p.id === target.id) : undefined;
  const routine = target.kind === "routine" ? data.routines.find((r) => r.id === target.id) : undefined;
  const node: PlannedSession | Routine | undefined = session ?? routine;
  const [picker, setPicker] = useState<{ swap?: string } | null>(null);
  const [schedule, setSchedule] = useState(false);
  const [schedDate, setSchedDate] = useState(todayISO());
  const ro = !item.canEdit || session?.status === "done";
  if (!node) return null;

  const edit = (fn: (n: PlannedSession | Routine, d: WorkoutData) => void) =>
    item.update((d) => {
      const n = target.kind === "session" ? d.planned.find((p) => p.id === target.id) : d.routines.find((r) => r.id === target.id);
      if (n) fn(n, d);
      if (target.kind === "session") d.planned.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
    });
  const editRx = (rid: string, fn: (rx: Prescription) => void) =>
    edit((n) => {
      const rx = n.exercises.find((x) => x.id === rid);
      if (rx) fn(rx);
    });
  const mins = estimateMinutes(node.exercises, lib, s);

  return (
    // data-autofocus: a phone sheet opens on the session, not with the keyboard up on its name.
    <div tabIndex={-1} data-autofocus={isPhone ? "" : undefined} className={cn("flex flex-col gap-4 outline-none", !isPhone && "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4")}>
      {!isPhone && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{target.kind === "routine" ? "Routine" : session?.status === "done" ? "Done session" : "Session"}</span>
          <IconButton label="Close editor" icon={X} onClick={onClose} />
        </div>
      )}
      <Field label="Name">
        <TextInput value={node.name} disabled={ro} maxLength={80} onChange={(e) => { const v = e.target.value.slice(0, 80); edit((n) => { n.name = v; }); }} />
      </Field>
      {session && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" value={session.date} disabled={ro} onChange={(e) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) edit((n) => { (n as PlannedSession).date = v; }); }} />
          </Field>
          <Field label="Time (for the reminder)">
            <TextInput type="time" value={session.time ?? ""} disabled={ro} onChange={(e) => { const v = e.target.value; edit((n) => { (n as PlannedSession).time = /^\d{2}:\d{2}$/.test(v) ? v : null; }); }} />
          </Field>
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>
          {node.exercises.length} exercises · {node.exercises.reduce((n, x) => n + x.sets, 0)} sets · ~{mins} min
          {mins > s.session_minutes + 5 && <span className="text-[var(--warning)]"> · over your {s.session_minutes} min</span>}
        </span>
        {session?.deload && <Pill tone="warn">Deload</Pill>}
      </div>

      <div className="flex flex-col gap-2">
        {node.exercises.map((rx, i) => (
          <RxEditor
            key={rx.id}
            rx={rx}
            ex={lib.get(rx.exercise_id)}
            lib={ctx}
            s={s}
            ro={ro}
            first={i === 0}
            last={i === node.exercises.length - 1}
            onChange={(fn) => editRx(rx.id, fn)}
            onMove={(dir) => edit((n) => { const j = n.exercises.findIndex((x) => x.id === rx.id); const k = j + dir; if (k < 0 || k >= n.exercises.length) return; [n.exercises[j], n.exercises[k]] = [n.exercises[k], n.exercises[j]]; })}
            onRemove={() => edit((n) => { n.exercises = n.exercises.filter((x) => x.id !== rx.id); })}
            onSwap={() => setPicker({ swap: rx.id })}
          />
        ))}
        {!ro && (
          <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => setPicker({})}>
            Add exercises
          </ItemButton>
        )}
      </div>
      <Field label="Notes">
        <TextArea value={node.notes ?? ""} disabled={ro} maxLength={1000} onChange={(e) => { const v = e.target.value.slice(0, 1000); edit((n) => { n.notes = v; }); }} placeholder="Focus, cues, how to warm up…" />
      </Field>

      {item.canEdit && (
        <div className="flex flex-wrap gap-2">
          {session && session.status !== "done" && !data.active && (
            <ItemButton variant="primary" icon={<Play className="h-4 w-4" />} onClick={() => { startWorkout(item, { session }); onClose(); onStarted(); }}>
              Start now
            </ItemButton>
          )}
          {routine && !data.active && (
            <ItemButton variant="primary" icon={<Play className="h-4 w-4" />} onClick={() => { startWorkout(item, { routine }); onClose(); onStarted(); }}>
              Start
            </ItemButton>
          )}
          {routine && (
            <ItemButton icon={<CalendarDays className="h-4 w-4" />} onClick={() => setSchedule(true)}>
              Schedule
            </ItemButton>
          )}
          {session && (
            <ItemButton
              icon={<Copy className="h-4 w-4" />}
              onClick={() => {
                const id = uid("r");
                const ex = session.exercises.map((x) => ({ ...x, id: uid("x"), load_kg: null }));
                item.update((d) => { d.routines.push({ id, name: session.name.replace(/ \(deload\)$/, ""), notes: session.notes ?? "", exercises: ex.map((x) => ({ ...x })) }); });
              }}
            >
              Save as routine
            </ItemButton>
          )}
          {session && session.status === "planned" && (
            <ItemButton onClick={() => edit((n) => { (n as PlannedSession).status = "skipped"; })}>Skip</ItemButton>
          )}
          {session && session.status === "skipped" && (
            <ItemButton onClick={() => edit((n) => { (n as PlannedSession).status = "planned"; })}>Un-skip</ItemButton>
          )}
          <ItemButton
            variant="ghost"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => {
              item.update((d) => {
                if (target.kind === "session") d.planned = d.planned.filter((p) => p.id !== target.id);
                else d.routines = d.routines.filter((r) => r.id !== target.id);
              });
              onClose();
            }}
          >
            Delete
          </ItemButton>
        </div>
      )}

      <ExercisePicker
        open={!!picker}
        onClose={() => setPicker(null)}
        recent={recentIds(ctx)}
        lib={lib}
        settings={s}
        multi={!picker?.swap}
        title={picker?.swap ? "Swap exercise" : "Add exercises"}
        onCreate={(c) => item.update((d) => { if (!d.exercises.some((x) => x.id === c.id)) d.exercises.push(c); })}
        onPick={(exs) => {
          if (picker?.swap) {
            const sid = picker.swap;
            editRx(sid, (rx) => { rx.exercise_id = exs[0].id; rx.load_kg = null; rx.load_pct = null; });
          } else {
            const rows = exs.map(newRx);
            edit((n) => { n.exercises.push(...rows.map((r) => ({ ...r }))); });
          }
        }}
      />
      {routine && (
        <Sheet
          open={schedule}
          onClose={() => setSchedule(false)}
          title={`Schedule ${routine.name}`}
          size="sm"
          footer={
            <ItemButton
              variant="primary"
              block
              onClick={() => {
                const id = uid("s");
                const ex = routine.exercises.map((x) => ({ ...x, id: uid("x") }));
                item.update((d) => {
                  d.planned.push({ id, date: schedDate, time: null, name: routine.name, notes: routine.notes, exercises: ex.map((x) => ({ ...x })), program_id: null, week: null, deload: false, status: "planned", workout_id: null });
                  d.planned.sort((a, b) => a.date.localeCompare(b.date));
                });
                setSchedule(false);
              }}
            >
              Add to {fmtDay(schedDate)}
            </ItemButton>
          }
        >
          <Field label="Day">
            <TextInput type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
          </Field>
        </Sheet>
      )}
    </div>
  );
}

/** A number box that can be cleared and retyped: it saves on blur / Enter
 *  (clamped), not per keystroke — typing "8" into a cleared "Reps" box used
 *  to snap to the minimum first and end up as "18". */
function NumField({ label, value, onChange, step = 1, min = 0, max = 999, disabled, suffix, placeholder, required }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; disabled?: boolean; suffix?: string; placeholder?: string; required?: boolean }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value == null ? "" : String(value));
  }, [value, focused]);
  const commit = () => {
    const t = text.replace(",", ".").trim();
    const n = t === "" ? null : Number(t);
    if (n === null && !required) return onChange(null);
    if (n === null || !Number.isFinite(n)) return setText(value == null ? "" : String(value));
    const v = Math.min(max, Math.max(min, n));
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <span className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--bg)] focus-within:border-[var(--item-accent)]">
        <input
          inputMode={step % 1 === 0 && min >= 0 && !suffix ? "numeric" : "decimal"}
          disabled={disabled}
          value={text}
          placeholder={placeholder ?? "–"}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onChange={(e) => setText(e.target.value)}
          aria-valuemin={min}
          aria-valuemax={max}
          className="h-10 w-full min-w-0 bg-transparent px-2 text-sm font-semibold tabular-nums text-[var(--text)] outline-none"
        />
        {suffix && <span className="pr-2 text-[11px] text-[var(--text-muted)]">{suffix}</span>}
      </span>
    </label>
  );
}

function RxEditor({ rx, ex, lib, s, ro, first, last, onChange, onMove, onRemove, onSwap }: { rx: Prescription; ex: Exercise; lib: Ctx; s: Settings; ro: boolean; first: boolean; last: boolean; onChange: (fn: (rx: Prescription) => void) => void; onMove: (d: 1 | -1) => void; onRemove: () => void; onSwap: () => void }) {
  const [more, setMore] = useState(false);
  // Plans are sets × reps — the weight is whatever they actually lift. Show
  // what the logger will suggest (real numbers only, never a guess).
  const sug = ex.log === "weight_reps" || ex.log === "assisted" || ex.log === "bodyweight_reps" ? prefill(ex, rx, lib.hist.get(ex.id), s, false, false) : null;
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center gap-2">
        <ExerciseBadge ex={ex} lib={lib.lib} size={32} />
        <div className="min-w-0 flex-1">
          {/* The name gets the whole row (long names wrap); the tools sit on the last row. */}
          <div className="line-clamp-2 break-words text-sm font-semibold leading-snug text-[var(--text)]">
            {rx.superset && <span className="mr-1 text-[var(--item-accent)]">{rx.superset}</span>}
            {ex.name}
          </div>
          <div className="truncate text-[11px] text-[var(--text-muted)]">{rxSummary(rx, s, ex.log)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <NumField required label="Sets" value={rx.sets} min={1} max={20} disabled={ro} onChange={(v) => onChange((x) => { x.sets = v ?? 1; })} />
        {ex.log === "duration" ? (
          <NumField label="Seconds" value={rx.seconds} min={1} max={86400} step={5} disabled={ro} onChange={(v) => onChange((x) => { x.seconds = v; })} />
        ) : ex.log === "distance" ? (
          <NumField label="Meters" value={rx.meters} min={1} max={1_000_000} step={100} disabled={ro} onChange={(v) => onChange((x) => { x.meters = v; })} />
        ) : (
          <>
            <NumField required label="Reps min" value={rx.reps_min} min={1} max={100} disabled={ro} onChange={(v) => onChange((x) => { x.reps_min = v ?? 1; if (x.reps_max < x.reps_min) x.reps_max = x.reps_min; })} />
            <NumField required label="Reps max" value={rx.reps_max} min={1} max={100} disabled={ro} onChange={(v) => onChange((x) => { x.reps_max = v ?? 1; if (x.reps_min > x.reps_max) x.reps_min = x.reps_max; })} />
          </>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <button type="button" onClick={() => setMore((m) => !m)} className="min-h-9 min-w-0 flex-1 truncate text-left text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]" aria-expanded={more}>
          {more ? "Less" : `Rest, superset, notes${rx.rest_s ? ` · ${rx.rest_s}s rest` : ""}${rx.notes ? " · note" : ""}`}
        </button>
        {!ro && (
          <>
            <IconButton label={`Move ${ex.name} up`} icon={ArrowUp} onClick={() => onMove(-1)} disabled={first} className="h-9 w-9" />
            <IconButton label={`Move ${ex.name} down`} icon={ArrowDown} onClick={() => onMove(1)} disabled={last} className="h-9 w-9" />
            <IconButton label={`Swap ${ex.name}`} icon={Repeat2} onClick={onSwap} className="h-9 w-9" />
            <IconButton label={`Remove ${ex.name}`} icon={Trash2} onClick={onRemove} className="h-9 w-9" />
          </>
        )}
      </div>
      {more && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <NumField label="Rest (s)" value={rx.rest_s} min={0} max={900} step={15} disabled={ro} onChange={(v) => onChange((x) => { x.rest_s = v; })} placeholder="auto" />
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Superset</span>
            <Select value={rx.superset ?? ""} disabled={ro} onChange={(e) => onChange((x) => { x.superset = e.target.value || null; })} className="h-10">
              <option value="">—</option>
              {"ABCDE".split("").map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>
          <NumField label="Drop sets" value={rx.drop_sets ?? 0} min={0} max={3} disabled={ro} onChange={(v) => onChange((x) => { x.drop_sets = v ?? 0; })} />
          <div className="col-span-3">
            <TextInput value={rx.notes ?? ""} disabled={ro} maxLength={300} onChange={(e) => { const v = e.target.value.slice(0, 300); onChange((x) => { x.notes = v; }); }} placeholder="Cue, tempo, setup…" aria-label="Exercise notes" />
          </div>
        </div>
      )}
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
        {sug != null ? `Suggested ${ex.log === "assisted" ? "assistance " : ""}${fmtW(sug, s)} — from what you've lifted` : "No weight yet — log what you lift and it'll suggest the next one"}
      </p>
    </div>
  );
}

