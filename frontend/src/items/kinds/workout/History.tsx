import { CalendarPlus, ChevronLeft, ChevronRight, ClipboardList, Clock, Dumbbell, History as HistoryIcon, Play, Plus, Sparkles, Trash2, Trophy, Weight, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, EmptyState, Field, IconButton, ItemButton, Page, Sheet, TextArea, TextInput, fmtDay, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { ExercisePicker } from "./ExercisePicker";
import { fmtSet } from "./Logger";
import { ArchiveCard, nearlyFull } from "./Archive";
import { MAX_WORKOUTS, PR_LABEL, bestSet, dayAt, fmtBig, fmtMinutes, fmtRecord, fromUnit, isHard, isoWithOffset, newSetsFor, setType, toUnit } from "./science";
import { ActiveBanner, ExerciseBadge, Pill, SetBadge, recentIds, useWorkoutCtx, type Ctx } from "./shared";
import { startWorkout } from "./Today";
import type { SetLog, Workout, WorkoutData } from "./types";

const PAGE = 30;
const TYPES: SetLog["type"][] = ["working", "warmup", "drop", "failure"];

function volumeOf(w: Workout, ctx: Ctx): number {
  return w.exercises.reduce((n, we) => (ctx.lib.get(we.exercise_id).log === "weight_reps" ? n + we.sets.filter(isHard).reduce((m, x) => m + (x.kg ?? 0) * (x.reps ?? 0), 0) : n), 0);
}

export function History({ item, isPhone, ask, goTo }: ItemViewProps<WorkoutData>) {
  const { ctx } = useWorkoutCtx(item);
  // undefined = nothing picked yet (desktop shows the latest workout); null = closed.
  const [picked, setOpen] = useState<string | null | undefined>(undefined);
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const [day, setDay] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const data = item.data;
  const list = useMemo(() => [...data.workouts].reverse(), [data.workouts]);
  const s = data.settings;
  const filtered = day ? list.filter((w) => w.date === day) : list;
  const open = picked !== undefined ? picked : !isPhone ? filtered[0]?.id ?? null : null;

  const full = data.workouts.length >= MAX_WORKOUTS;
  const logPast = () => {
    if (full) return;
    const id = uid("w");
    const date = day ?? todayISO();
    // Moments carry the device's offset for that day (never naive times).
    const startedAt = dayAt(date, 12);
    const endedAt = dayAt(date, 13);
    item.update((d) => {
      d.workouts.push({ id, name: "Workout", date, started_at: startedAt, ended_at: endedAt, duration_s: 3600, exercises: [], notes: "", session_id: null, program_id: null, bodyweight_kg: d.settings.bodyweight_kg, rest_until: null, rest_total_s: null });
      d.workouts.sort((a, b) => (a.date + (a.started_at ?? "")).localeCompare(b.date + (b.started_at ?? "")));
    });
    setOpen(id);
  };

  /** Closing a "Log past workout" that never got an exercise drops it — an
   *  empty workout shouldn't count towards streaks and stats. */
  const close = () => {
    const id = open;
    const w = id ? data.workouts.find((x) => x.id === id) : null;
    if (w && item.canEdit && w.exercises.length === 0 && !w.notes?.trim())
      item.update((d) => {
        const x = d.workouts.find((y) => y.id === id);
        if (x && x.exercises.length === 0 && !x.notes?.trim()) d.workouts = d.workouts.filter((y) => y.id !== id);
      });
    setOpen(null);
  };
  const detail = open ? <WorkoutDetail item={item} ctx={ctx} id={open} onClose={close} onStarted={() => goTo("today")} ask={ask} isPhone={isPhone} /> : null;

  const left = (
    <div className="flex flex-col gap-4">
      <ActiveBanner data={data} goTo={goTo} />
      {item.canEdit && nearlyFull(data) && <ArchiveCard item={item} />}
      <MonthCalendar data={data} ctx={ctx} month={month} setMonth={setMonth} day={day} setDay={(d) => { setDay(d === day ? null : d); setShown(PAGE); }} />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">
          {day ? fmtDay(day, { long: true }) : `${list.length} workout${list.length === 1 ? "" : "s"}`}
        </h2>
        <div className="flex gap-1">
          {day && <ItemButton size="sm" variant="ghost" onClick={() => setDay(null)}>All</ItemButton>}
          {item.canEdit && (
            <ItemButton size="sm" icon={<CalendarPlus className="h-3.5 w-3.5" />} onClick={logPast} disabled={full} title={full ? "This file is full — archive older workouts first" : undefined}>
              Log past workout
            </ItemButton>
          )}
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState
          icon={HistoryIcon}
          title="No workouts logged yet"
          text="Finish a live workout, log a past one here — or just tell the coach: “I did 3×8 bench at 80 today”."
          action={<ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Log my workout from today: ")}>Log by chat</ItemButton>}
        />
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">Nothing logged on this day.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.slice(0, shown).map((w, i) => {
            const prev = filtered[i - 1];
            const header = !prev || prev.date.slice(0, 7) !== w.date.slice(0, 7);
            const prs = ctx.prs.get(w.id)?.length ?? 0;
            const sets = w.exercises.reduce((n, we) => n + we.sets.filter(isHard).length, 0);
            return (
              <div key={w.id}>
                {header && !day && <h3 className="px-1 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{new Date(w.date + "T12:00").toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>}
                {/* Strong's history card: stats, then each exercise with its best set. */}
                <Card onClick={() => setOpen(w.id)} className={cn("flex flex-col gap-2", open === w.id && !isPhone && "border-[var(--item-accent)]")}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold text-[var(--text)]">{w.name}</span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">{fmtDay(w.date)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-[var(--text-muted)]">
                    {w.duration_s ? <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{fmtMinutes(w.duration_s)}</span> : null}
                    <span className="inline-flex items-center gap-1"><Dumbbell className="h-3.5 w-3.5" aria-hidden />{sets} sets</span>
                    <span className="inline-flex items-center gap-1"><Weight className="h-3.5 w-3.5" aria-hidden />{fmtBig(volumeOf(w, ctx), s)} {s.units}</span>
                    {prs > 0 && <span className="inline-flex items-center gap-1 font-semibold text-[var(--item-accent)]"><Trophy className="h-3.5 w-3.5" aria-hidden />{prs} PR{prs === 1 ? "" : "s"}</span>}
                  </div>
                  <div className="mt-0.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-[var(--border)] pt-2 text-xs">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Exercise</span>
                    <span className="text-right text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Best set</span>
                    {w.exercises.slice(0, 4).map((we) => {
                      const ex = ctx.lib.get(we.exercise_id);
                      const best = bestSet(we, ex, s);
                      return (
                        <div key={we.id} className="contents">
                          <span className="truncate text-[var(--text)]">
                            {we.sets.filter(isHard).length ? `${we.sets.filter(isHard).length} × ` : ""}
                            {ex.name.replace(/ \(.*\)$/, "")}
                            {!we.sets.some(isHard) && <span className="text-[var(--text-muted)]"> · warm-up</span>}
                          </span>
                          <span className="text-right tabular-nums text-[var(--text-muted)]">{best ? fmtSet(best, ex, s) : "—"}</span>
                        </div>
                      );
                    })}
                    {w.exercises.length > 4 && <span className="col-span-2 text-[var(--text-muted)]">+ {w.exercises.length - 4} more</span>}
                  </div>
                </Card>
              </div>
            );
          })}
          {filtered.length > shown && (
            <ItemButton onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</ItemButton>
          )}
        </div>
      )}
    </div>
  );

  if (isPhone)
    return (
      <Page>
        {left}
        {open && (
          <Sheet open onClose={close} title="Workout" size="full">
            {detail}
          </Sheet>
        )}
      </Page>
    );
  return (
    <Page wide>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-start gap-6">
        {left}
        <div className="sticky top-4">
          {detail ?? (
            <Card className="flex flex-col items-center gap-2 py-12 text-center">
              <HistoryIcon className="h-8 w-8 text-[var(--text-muted)]" />
              <p className="text-sm font-medium text-[var(--text)]">Pick a workout to see every set</p>
              <p className="max-w-xs text-xs text-[var(--text-muted)]">Fix a typo in a set, repeat the workout, or save it as a routine.</p>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

function MonthCalendar({ data, ctx, month, setMonth, day, setDay }: { data: WorkoutData; ctx: Ctx; month: string; setMonth: (m: string) => void; day: string | null; setDay: (d: string) => void }) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const startDow = data.settings.week_start === "sun" ? first.getDay() : (first.getDay() + 6) % 7;
  const byDay = useMemo(() => {
    const out: Record<string, { n: number; pr: boolean }> = {};
    for (const w of data.workouts) {
      if (!w.date.startsWith(month)) continue;
      const cur = out[w.date] ?? { n: 0, pr: false };
      cur.n++;
      cur.pr = cur.pr || (ctx.prs.get(w.id)?.length ?? 0) > 0;
      out[w.date] = cur;
    }
    return out;
  }, [data.workouts, month, ctx.prs]);
  const planned = new Set(data.planned.filter((p) => p.status === "planned" && p.date.startsWith(month)).map((p) => p.date));
  const shift = (k: number) => {
    const d = new Date(y, m - 1 + k, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const today = todayISO();
  const labels = data.settings.week_start === "sun" ? ["S", "M", "T", "W", "T", "F", "S"] : ["M", "T", "W", "T", "F", "S", "S"];
  const count = Object.values(byDay).reduce((n, x) => n + x.n, 0);
  return (
    <Card>
      <div className="mb-2 flex items-center gap-1">
        <IconButton label="Previous month" icon={ChevronLeft} onClick={() => shift(-1)} />
        <div className="flex-1 text-center">
          <div className="text-sm font-semibold text-[var(--text)]">{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
          <div className="text-[11px] text-[var(--text-muted)]">{count} workout{count === 1 ? "" : "s"}</div>
        </div>
        <IconButton label="Next month" icon={ChevronRight} onClick={() => shift(1)} />
      </div>
      <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label="Workouts this month">
        {labels.map((l, i) => (
          <span key={i} className="text-[10px] font-medium text-[var(--text-muted)]">{l}</span>
        ))}
        {Array.from({ length: startDow }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const d = `${month}-${String(i + 1).padStart(2, "0")}`;
          const info = byDay[d];
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDay(d)}
              aria-pressed={day === d}
              aria-label={`${fmtDay(d, { long: true })}${info ? `: ${info.n} workout${info.n === 1 ? "" : "s"}${info.pr ? ", with a PR" : ""}` : planned.has(d) ? ": planned" : ""}`}
              className={cn(
                "relative flex aspect-square items-center justify-center rounded-lg text-xs tabular-nums transition",
                info ? "bg-[var(--item-accent-fill)] font-semibold text-white" : planned.has(d) ? "border border-dashed border-[var(--item-accent)] text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]",
                d === today && !info && "ring-1 ring-[var(--item-accent)]",
                day === d && "ring-2 ring-[var(--text)] ring-offset-1 ring-offset-[var(--surface)]",
              )}
            >
              {i + 1}
              {info?.pr && <Trophy className="absolute right-0.5 top-0.5 h-2.5 w-2.5" aria-hidden />}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function WorkoutDetail({ item, ctx, id, onClose, onStarted, ask, isPhone }: { item: ItemHandle<WorkoutData>; ctx: Ctx; id: string; onClose: () => void; onStarted: () => void; ask: (p: string) => void; isPhone: boolean }) {
  const w = item.data.workouts.find((x) => x.id === id);
  const s = item.data.settings;
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ro = !item.canEdit;
  if (!w) return null;
  const prs = ctx.prs.get(w.id) ?? [];
  const edit = (fn: (x: Workout) => void) =>
    item.update((d) => {
      const x = d.workouts.find((y) => y.id === id);
      if (x) fn(x);
      d.workouts.sort((a, b) => (a.date + (a.started_at ?? "")).localeCompare(b.date + (b.started_at ?? "")));
    });
  const editSet = (weId: string, setId: string, fn: (st: SetLog) => void) =>
    edit((x) => {
      const st = x.exercises.find((e) => e.id === weId)?.sets.find((t) => t.id === setId);
      if (st) fn(st);
    });
  const asRoutine = () => {
    const rid = uid("r");
    const rxs = w.exercises.map((we) => {
      const hard = we.sets.filter((x) => setType(x) === "working");
      const reps = hard.map((x) => x.reps ?? 0).filter(Boolean);
      return { id: uid("x"), exercise_id: we.exercise_id, sets: Math.max(1, hard.length), reps_min: reps.length ? Math.min(...reps) : 8, reps_max: reps.length ? Math.max(...reps) : 12, load_kg: null, load_pct: null, rest_s: we.rest_s ?? null, superset: we.superset ?? null, warmup: null, drop_sets: 0, notes: "", seconds: hard[0]?.seconds ?? null, meters: hard[0]?.meters ?? null };
    });
    item.update((d) => { d.routines.push({ id: rid, name: w.name, notes: "", exercises: rxs.map((r) => ({ ...r })) }); });
  };
  return (
    // data-autofocus: a phone sheet opens on the workout, not with the keyboard up on its name.
    <div tabIndex={-1} data-autofocus={isPhone ? "" : undefined} className={cn("flex flex-col gap-4 outline-none", !isPhone && "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TextInput value={w.name} disabled={ro} maxLength={80} onChange={(e) => { const v = e.target.value.slice(0, 80); edit((x) => { x.name = v; }); }} aria-label="Workout name" className="font-semibold" />
        </div>
        {!isPhone && <IconButton label="Close" icon={X} onClick={onClose} />}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Date">
          <TextInput type="date" value={w.date} disabled={ro} onChange={(e) => {
            const v = e.target.value;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
            // Keep the start / end moments on the new day (same clock time, that day's offset).
            const days = Math.round((new Date(v + "T12:00").getTime() - new Date(w.date + "T12:00").getTime()) / 86_400_000);
            const move = (iso: string | null | undefined) => (iso ? isoWithOffset(new Date(new Date(iso).getTime() + days * 86_400_000)) : iso ?? null);
            const startedAt = move(w.started_at);
            const endedAt = move(w.ended_at);
            edit((x) => { x.date = v; x.started_at = startedAt; x.ended_at = endedAt; });
          }} />
        </Field>
        <Field label="Minutes">
          <TextInput inputMode="numeric" disabled={ro} value={w.duration_s ? String(Math.round(w.duration_s / 60)) : ""} onChange={(e) => { const n = parseInt(e.target.value, 10); edit((x) => { x.duration_s = Number.isFinite(n) ? Math.min(1440, Math.max(0, n)) * 60 : null; }); }} />
        </Field>
      </div>
      {prs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {prs.map((p, i) => (
            <Pill key={i} tone="accent">
              <Trophy className="h-3 w-3" /> {ctx.lib.get(p.exerciseId).name.replace(/ \(.*\)$/, "")} {PR_LABEL[p.kind]} {fmtRecord(p.kind, p.value, s)}
            </Pill>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {w.exercises.map((we) => {
          const ex = ctx.lib.get(we.exercise_id);
          let n = 0;
          return (
            <div key={we.id} className="rounded-2xl border border-[var(--border)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <ExerciseBadge ex={ex} lib={ctx.lib} size={30} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{ex.name}</span>
                {!ro && <IconButton label={`Remove ${ex.name}`} icon={Trash2} className="h-8 w-8" onClick={() => edit((x) => { x.exercises = x.exercises.filter((e) => e.id !== we.id); })} />}
              </div>
              <ul className="flex flex-col gap-1">
                {we.sets.map((st) => {
                  if (setType(st) === "working") n++;
                  return (
                    <li key={st.id} className="flex items-center gap-2">
                      <SetBadge
                        s={st}
                        n={n}
                        onClick={ro ? undefined : () => { const next = TYPES[(TYPES.indexOf(setType(st)) + 1) % TYPES.length]; editSet(we.id, st.id, (x) => { x.type = next; }); }}
                      />
                      {ro ? (
                        <span className="text-sm tabular-nums text-[var(--text)]">{fmtSet(st, ex, s)}</span>
                      ) : (
                        <SetEditor st={st} log={ex.log} cardio={ex.pattern === "cardio"} s={s} onChange={(fn) => editSet(we.id, st.id, fn)} onRemove={() => edit((x) => { const e = x.exercises.find((y) => y.id === we.id); if (e) e.sets = e.sets.filter((t) => t.id !== st.id); })} />
                      )}
                    </li>
                  );
                })}
              </ul>
              {!ro && (
                <button
                  type="button"
                  onClick={() => {
                    const sid = uid("t");
                    edit((x) => {
                      const e = x.exercises.find((y) => y.id === we.id);
                      const last = e?.sets[e.sets.length - 1];
                      e?.sets.push({ id: sid, type: "working", kg: last?.kg ?? null, reps: last?.reps ?? null, seconds: last?.seconds ?? null, meters: last?.meters ?? null, done: true });
                    });
                  }}
                  className="mt-1 flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add set
                </button>
              )}
            </div>
          );
        })}
        {!ro && (
          <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => setPicker(true)}>
            Add exercise
          </ItemButton>
        )}
      </div>
      <Field label="Notes">
        <TextArea value={w.notes ?? ""} disabled={ro} maxLength={2000} onChange={(e) => { const v = e.target.value.slice(0, 2000); edit((x) => { x.notes = v; }); }} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {!ro && !item.data.active && (
          <ItemButton
            variant="primary"
            icon={<Play className="h-4 w-4" />}
            onClick={() => {
              const rxs = w.exercises.map((we) => {
                const hard = we.sets.filter((x) => setType(x) === "working");
                const reps = hard.map((x) => x.reps ?? 0).filter(Boolean);
                return { id: uid("x"), exercise_id: we.exercise_id, sets: Math.max(1, hard.length), reps_min: reps.length ? Math.min(...reps) : 8, reps_max: reps.length ? Math.max(...reps) : 10, load_kg: null, load_pct: null, rest_s: we.rest_s ?? null, superset: we.superset ?? null, warmup: null, drop_sets: 0, notes: "" };
              });
              startWorkout(item, { routine: { id: "repeat", name: w.name, notes: "", exercises: rxs } });
              onClose();
              onStarted();
            }}
          >
            Repeat
          </ItemButton>
        )}
        {!ro && <ItemButton icon={<ClipboardList className="h-4 w-4" />} onClick={asRoutine}>Save as routine</ItemButton>}
        <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(`Review my workout "${w.name}" on ${w.date}: what went well, and what should I lift next time?`)}>
          Review
        </ItemButton>
        {!ro && (
          <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm(true)}>
            Delete
          </ItemButton>
        )}
      </div>
      <ExercisePicker
        open={picker}
        onClose={() => setPicker(false)}
        recent={recentIds(ctx)}
        lib={ctx.lib}
        settings={s}
        multi
        onCreate={(c) => item.update((d) => { if (!d.exercises.some((x) => x.id === c.id)) d.exercises.push(c); })}
        onPick={(exs) => {
          const made = exs.map((ex) => ({ id: uid("e"), exercise_id: ex.id, sets: newSetsFor(ex, null, ctx.hist.get(ex.id), s, uid, { warm: false }).map((x) => ({ ...x, done: true })), notes: "", superset: null, rest_s: null, rx: null }));
          edit((x) => { x.exercises.push(...made.map((m) => structuredClone(m))); });
        }}
      />
      <Sheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this workout?"
        size="sm"
        footer={
          <>
            <ItemButton block onClick={() => setConfirm(false)}>Cancel</ItemButton>
            <ItemButton
              variant="danger"
              block
              onClick={() => {
                item.update((d) => {
                  d.workouts = d.workouts.filter((x) => x.id !== id);
                  for (const p of d.planned) if (p.workout_id === id) { p.workout_id = null; p.status = "planned"; }
                });
                setConfirm(false);
                onClose();
              }}
            >
              Delete
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text-muted)]">Its sets leave your history and records. You can undo from the ⋯ menu or version history.</p>
      </Sheet>
    </div>
  );
}

function SetEditor({ st, log, cardio, s, onChange, onRemove }: { st: SetLog; log: string; cardio: boolean; s: WorkoutData["settings"]; onChange: (fn: (x: SetLog) => void) => void; onRemove: () => void }) {
  const loadLabel = log === "assisted" ? `−${s.units} assist ×` : log === "bodyweight_reps" ? `+${s.units} ×` : `${s.units} ×`;
  const box = "h-9 w-16 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-1 text-center text-sm font-semibold tabular-nums text-[var(--text)] outline-none focus:border-[var(--item-accent)]";
  const num = (v: string) => {
    const n = parseFloat(v.replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5">
      {log !== "duration" && log !== "distance" ? (
        <>
          <input aria-label={`Load (${s.units})`} inputMode="decimal" className={box} defaultValue={toUnit(st.kg, s) ?? ""} onBlur={(e) => { const v = num(e.target.value); onChange((x) => { x.kg = v === null ? null : fromUnit(v, s); }); }} />
          <span className="text-xs text-[var(--text-muted)]">{loadLabel}</span>
          <input aria-label="Reps" inputMode="numeric" className={box} defaultValue={st.reps ?? ""} onBlur={(e) => { const v = num(e.target.value); onChange((x) => { x.reps = v === null ? null : Math.round(v); }); }} />
        </>
      ) : log === "duration" && cardio ? (
        <>
          <input aria-label="Minutes" inputMode="decimal" className={box} defaultValue={st.seconds != null ? Math.round((st.seconds / 60) * 10) / 10 : ""} onBlur={(e) => { const v = num(e.target.value); onChange((x) => { x.seconds = v === null ? null : Math.round(v * 60); }); }} />
          <span className="text-xs text-[var(--text-muted)]">min</span>
        </>
      ) : log === "duration" ? (
        <>
          <input aria-label="Seconds" inputMode="numeric" className={box} defaultValue={st.seconds ?? ""} onBlur={(e) => { const v = num(e.target.value); onChange((x) => { x.seconds = v === null ? null : Math.round(v); }); }} />
          <span className="text-xs text-[var(--text-muted)]">s</span>
        </>
      ) : (
        <>
          <input aria-label="Meters" inputMode="decimal" className={box} defaultValue={st.meters ?? ""} onBlur={(e) => { const v = num(e.target.value); onChange((x) => { x.meters = v; }); }} />
          <span className="text-xs text-[var(--text-muted)]">m in</span>
          <input aria-label="Seconds" inputMode="numeric" className={box} defaultValue={st.seconds ?? ""} onBlur={(e) => { const v = num(e.target.value); onChange((x) => { x.seconds = v === null ? null : Math.round(v); }); }} />
          <span className="text-xs text-[var(--text-muted)]">s</span>
        </>
      )}
      <button type="button" aria-label="Delete set" onClick={onRemove} className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)]">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export { volumeOf };
