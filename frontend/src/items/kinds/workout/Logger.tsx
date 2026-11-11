import {
  ArrowDown,
  ArrowUp,
  Calculator,
  Check,
  Flame,
  LineChart,
  MoreVertical,
  NotebookPen,
  Plus,
  Repeat2,
  Sparkles,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, Field, ItemButton, Sheet, Stepper, TextArea, TextInput, fmtDay, fmtDuration, uid } from "@/items/ui";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { ExercisePicker } from "./ExercisePicker";
import { PlateCalc } from "./PlateCalc";
import { ExerciseDetail } from "./Progress";
import { RestTimer, cancelRestAlert, primeAudio, useNow } from "./RestTimer";
import {
  MAX_WORKOUTS,
  achievable,
  finishActive,
  fmtBig,
  fmtMeters,
  fmtSecs,
  fmtW,
  fromUnit,
  isHard,
  isoWithOffset,
  loadEquipment,
  newSetsFor,
  restFor,
  setType,
  stepLoad,
  toUnit,
  rampWarmups,
  warmups,
  warmupsBlank,
} from "./science";
import { ExerciseBadge, Pill, SET_NAME, SetBadge, muscleLine, recentIds, type Ctx } from "./shared";
import type { Exercise, SetLog, SetType, Settings, WorkoutData, WorkoutExercise } from "./types";

const TYPES: SetType[] = ["working", "warmup", "drop", "failure"];

/* ------------------------------------------------------------- columns */

type Col = "kg" | "reps" | "seconds" | "km" | "meters" | "minutes";

function columns(ex: Exercise, s: Settings): Col[] {
  const loaded = !!achievable(ex, s);
  switch (ex.log) {
    case "duration":
      // Cardio is minutes (a 20-minute bike, not 1200 s); holds stay seconds.
      return loaded ? ["kg", "seconds"] : ex.pattern === "cardio" ? ["minutes"] : ["seconds"];
    case "distance":
      return loaded ? ["kg", "meters"] : ["km", "minutes"];
    default:
      return ["kg", "reps"];
  }
}

function colLabel(c: Col, ex: Exercise, s: Settings): string {
  if (c === "kg") return ex.log === "assisted" ? `−${s.units}` : ex.log === "bodyweight_reps" ? `+${s.units}` : s.units;
  return { reps: "Reps", seconds: "Sec", km: "Km", meters: "M", minutes: "Min" }[c];
}

function getVal(st: SetLog, c: Col, s: Settings): number | null {
  switch (c) {
    case "kg":
      return toUnit(st.kg, s);
    case "reps":
      return st.reps ?? null;
    case "seconds":
      return st.seconds ?? null;
    case "meters":
      return st.meters ?? null;
    case "km":
      return st.meters != null ? Math.round((st.meters / 1000) * 100) / 100 : null;
    case "minutes":
      return st.seconds != null ? Math.round((st.seconds / 60) * 10) / 10 : null;
  }
}

function setVal(st: SetLog, c: Col, v: number | null, s: Settings) {
  switch (c) {
    case "kg":
      st.kg = v === null ? null : fromUnit(v, s);
      break;
    case "reps":
      st.reps = v === null ? null : Math.round(v);
      break;
    case "seconds":
      st.seconds = v === null ? null : Math.round(v);
      break;
    case "meters":
      st.meters = v;
      break;
    case "km":
      st.meters = v === null ? null : v * 1000;
      break;
    case "minutes":
      st.seconds = v === null ? null : Math.round(v * 60);
      break;
  }
}

export function fmtSet(st: SetLog, ex: Exercise, s: Settings): string {
  switch (ex.log) {
    case "duration":
      return (st.kg ? `${fmtW(st.kg, s, false)} × ` : "") + fmtSecs(st.seconds ?? 0);
    case "distance":
      return (st.kg ? `${fmtW(st.kg, s, false)} · ` : "") + fmtMeters(st.meters ?? 0) + (st.seconds ? ` in ${fmtSecs(st.seconds)}` : "");
    case "bodyweight_reps":
      return `${st.reps ?? 0}${st.kg ? ` +${fmtW(st.kg, s, false)}` : ""}`;
    case "assisted":
      return `${st.reps ?? 0} (−${fmtW(st.kg ?? 0, s, false)})`;
    default:
      return `${fmtW(st.kg, s, false)} × ${st.reps ?? 0}`;
  }
}

/** A number box that lets you type "82." without fighting you. */
function NumBox({
  value,
  onCommit,
  label,
  dataKey,
  onEnter,
  className,
  decimal = true,
  placeholder,
  readOnly,
}: {
  placeholder?: number | null;
  readOnly?: boolean;
  value: number | null;
  onCommit: (v: number | null) => void;
  label: string;
  dataKey: string;
  onEnter?: (v: number | null) => void;
  className?: string;
  decimal?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value === null ? "" : String(value));
  }, [value]);
  /** Saves the box; returns what it now holds. */
  const commit = (): number | null => {
    const t = text.replace(",", ".").trim();
    if (t === "") {
      onCommit(null);
      return null;
    }
    const n = parseFloat(t);
    if (Number.isFinite(n) && n >= 0) {
      onCommit(n);
      return n;
    }
    setText(value === null ? "" : String(value));
    return value;
  };
  return (
    <input
      inputMode={decimal ? "decimal" : "numeric"}
      aria-label={label}
      data-set-input={dataKey}
      value={text}
      readOnly={readOnly}
      tabIndex={readOnly ? -1 : undefined}
      placeholder={placeholder != null ? String(placeholder) : "–"}
      onFocus={(e) => {
        if (readOnly) return;
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter?.(commit());
        }
      }}
      className={cn(
        "h-10 w-full min-w-0 rounded-lg border border-transparent bg-[var(--surface-2)] px-1 text-center text-[15px] font-semibold tabular-nums text-[var(--text)] outline-none transition placeholder:font-medium placeholder:text-[var(--text-muted)] placeholder:opacity-70 focus:border-[var(--item-accent)] focus:bg-[var(--surface)]",
        className,
      )}
    />
  );
}

/** Keep the screen on while a workout is live (where the browser allows). */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on) return;
    type Lock = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } };
    let lock: Lock | null = null;
    let live = true;
    const get = () => {
      if (document.visibilityState !== "visible" || !nav.wakeLock) return;
      nav.wakeLock.request("screen").then((l) => {
        if (live) lock = l;
        else void l.release();
      }).catch(() => undefined);
    };
    get();
    document.addEventListener("visibilitychange", get);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", get);
      void lock?.release().catch(() => undefined);
    };
  }, [on]);
}

/* --------------------------------------------------------------- logger */

export function Logger({ item, ctx, isPhone, ask, onFinished }: { item: ItemHandle<WorkoutData>; ctx: Ctx; isPhone: boolean; ask: (p: string) => void; onFinished: (workoutId: string) => void }) {
  const a = item.data.active!;
  const s = item.data.settings;
  const { lib, hist } = ctx;
  const now = useNow(1000);
  const [focus, setFocus] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ mode: "add" } | { mode: "swap"; weId: string } | null>(null);
  const [plates, setPlates] = useState<{ weId: string; setId: string; kg: number | null; bar: string } | null>(null);
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const ro = !item.canEdit;
  useWakeLock(!ro);

  const elapsed = a.started_at ? Math.max(0, (now - new Date(a.started_at).getTime()) / 1000) : 0;
  const allSets = a.exercises.flatMap((we) => we.sets);
  const done = allSets.filter((x) => x.done && setType(x) !== "warmup");
  const volume = a.exercises.reduce(
    (n, we) => n + (lib.get(we.exercise_id).log === "weight_reps" ? we.sets.filter((x) => x.done && setType(x) !== "warmup").reduce((m, x) => m + (x.kg ?? 0) * (x.reps ?? 0), 0) : 0),
    0,
  );
  const firstOpen = useMemo(() => {
    for (const we of a.exercises) for (const st of we.sets) if (!st.done) return st.id;
    return null;
  }, [a.exercises]);
  const focused = focus && allSets.some((x) => x.id === focus && !x.done) ? focus : firstOpen;

  const mutate = (fn: (w: NonNullable<WorkoutData["active"]>, d: WorkoutData) => void) =>
    item.update((d) => {
      if (d.active) fn(d.active, d);
    });

  const nextOpenAfter = (w: NonNullable<WorkoutData["active"]>, weIdx: number, setId: string): string | null => {
    // In a superset, go to the partner's next set first.
    const we = w.exercises[weIdx];
    if (we.superset) {
      const group = w.exercises.map((x, i) => ({ x, i })).filter(({ x }) => x.superset === we.superset);
      const pos = group.findIndex(({ i }) => i === weIdx);
      for (let k = 1; k <= group.length; k++) {
        const g = group[(pos + k) % group.length].x;
        const open = g.sets.find((x) => !x.done && x.id !== setId);
        if (open) return open.id;
      }
    }
    // The next open set below this one (then later exercises), and only then
    // anything skipped above — ticking set 1 shouldn't jump back to a warm-up.
    const at = we.sets.findIndex((x) => x.id === setId);
    const below = we.sets.slice(at + 1).find((x) => !x.done);
    if (below) return below.id;
    for (let i = weIdx + 1; i < w.exercises.length; i++) {
      const open = w.exercises[i].sets.find((x) => !x.done);
      if (open) return open.id;
    }
    for (let i = 0; i <= weIdx; i++) {
      const open = w.exercises[i].sets.find((x) => !x.done && x.id !== setId);
      if (open) return open.id;
    }
    return null;
  };

  /** Tick (or untick) a set. ``fill`` holds what the empty boxes showed as
   *  greyed hints (last time's numbers / the plan's target) — ticking takes
   *  them, like Strong. With nothing to go on the set isn't ticked: a blank
   *  rep count used to be saved as 1 rep (a fake 1RM). */
  const tick = (weId: string, setId: string, fill: Partial<SetLog> = {}) => {
    primeAudio();
    // Mutator rule: everything decided from what the person saw — the
    // target state, the tick time, the rest end — is made out here; the
    // mutator only applies it (it may be replayed on newer state).
    const at = isoWithOffset(new Date());
    const t0 = Date.now();
    const cur = item.data.active;
    const curIdx = cur ? cur.exercises.findIndex((x) => x.id === weId) : -1;
    const curWe = cur?.exercises[curIdx];
    const curSet = curWe?.sets.find((x) => x.id === setId);
    if (!cur || !curWe || !curSet) return;
    const target = !curSet.done; // tick → done; tick a done set → undo it
    const ex = lib.get(curWe.exercise_id);
    if (target) {
      const merged: SetLog = { ...curSet, ...Object.fromEntries(Object.entries(fill).filter(([k]) => (curSet as unknown as Record<string, unknown>)[k] == null)) };
      const cols = columns(ex, s);
      const amounts = cols.filter((c) => c !== "kg");
      let missing = -1;
      if (!amounts.some((c) => getVal(merged, c, s) != null)) missing = cols.indexOf(amounts[0]);
      else if (ex.log === "weight_reps" && cols[0] === "kg" && merged.kg == null) missing = 0;
      if (missing >= 0) {
        const what = cols[missing] === "kg" ? "the weight" : cols[missing] === "reps" ? "the reps" : "a value";
        toast.info(`Enter ${what} first — then tick the set.`);
        setFocus(setId);
        window.setTimeout(() => document.querySelector<HTMLInputElement>(`[data-set-input="${setId}-${missing}"]`)?.focus(), 30);
        return;
      }
    }
    const next = target ? nextOpenAfter(cur, curIdx, setId) : null;
    const partnerOpen = !!curWe.superset && cur.exercises.some((x, i) => i !== curIdx && x.superset === curWe.superset && x.sets.some((y) => !y.done));
    const rest = setType(curSet) === "warmup" ? Math.min(60, restFor(curWe, ex, s)) : restFor(curWe, ex, s);
    const restUntil = target && !partnerOpen && rest > 0 && s.rest_timer !== false ? new Date(t0 + rest * 1000).toISOString() : null;
    mutate((w) => {
      const we = w.exercises.find((x) => x.id === weId);
      const st = we?.sets.find((x) => x.id === setId);
      if (!we || !st) return;
      if (!target) {
        st.done = false;
        st.at = null;
        return;
      }
      if (st.done) return; // already ticked (elsewhere) — nothing to add
      st.done = true;
      st.at = at;
      // Empty boxes take the hints they showed (only boxes still empty).
      for (const k of ["kg", "reps", "seconds", "meters"] as const) if (st[k] == null && fill[k] != null) st[k] = fill[k];
      // The next unticked set of the same type suggests what they just used.
      const after = we.sets.slice(we.sets.indexOf(st) + 1).find((x) => !x.done && setType(x) === setType(st));
      if (after && after.kg == null && st.kg != null) after.suggest_kg = st.kg;
      if (restUntil) {
        w.rest_total_s = rest;
        w.rest_until = restUntil;
      }
    });
    setFocus(next);
    if (!isPhone && next) window.setTimeout(() => document.querySelector<HTMLInputElement>(`[data-set-input="${next}-0"]`)?.focus(), 30);
    // Phone: bring the next set (and its big editor) into view above the rest bar.
    if (isPhone && next) window.setTimeout(() => document.querySelector(`[data-set-row="${next}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
  };

  const addExercises = (exs: Exercise[]) => {
    const patterns = new Set(a.exercises.map((x) => lib.get(x.exercise_id).pattern));
    // An empty workout (nothing planned in it): new exercises start with no
    // sets — they add the ones they do. Planned workouts keep the prefill.
    const adHoc = a.exercises.every((x) => !x.rx);
    const made: WorkoutExercise[] = exs.map((ex) => {
      if (adHoc) return { id: uid("e"), exercise_id: ex.id, sets: [], notes: "", superset: null, rest_s: null, rx: null };
      const warm = s.warmups && ex.compound && ex.log === "weight_reps" && !patterns.has(ex.pattern);
      patterns.add(ex.pattern);
      let sets = newSetsFor(ex, null, hist.get(ex.id), s, uid, { warm });
      // Cardio added ad hoc with no history: one bout (20 min for a timed
      // machine), not three 30-second "sets".
      if (ex.pattern === "cardio" && !hist.get(ex.id)?.length) sets = sets.slice(0, 1).map((x) => (ex.log === "duration" && (x.seconds ?? 0) <= 60 ? { ...x, seconds: 1200 } : x));
      return { id: uid("e"), exercise_id: ex.id, sets, notes: "", superset: null, rest_s: null, rx: null };
    });
    mutate((w) => {
      w.exercises.push(...made.map((m) => structuredClone(m)));
    });
  };

  const swap = (weId: string, ex: Exercise) => {
    const old = a.exercises.find((x) => x.id === weId);
    const rx = old?.rx ? { ...old.rx, exercise_id: ex.id, load_kg: null } : null;
    const kg = newSetsFor(ex, rx, hist.get(ex.id), s, uid, { warm: false, deload: !!a.deload }).find((x) => setType(x) === "working")?.suggest_kg ?? null;
    mutate((w) => {
      const we = w.exercises.find((x) => x.id === weId);
      if (!we) return;
      we.exercise_id = ex.id;
      we.rx = rx ? { ...rx } : null;
      we.sets = we.sets.filter((x) => x.done || setType(x) !== "warmup").map((x) => (x.done ? x : { ...x, kg: null, suggest_kg: kg }));
    });
  };

  const recent = useMemo(() => recentIds(ctx), [ctx]);
  const summaryLine = a.session_id ? item.data.planned.find((p) => p.id === a.session_id) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Session header */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--item-accent)]">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--item-accent-fill)] opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--item-accent-fill)]" />
              </span>
              Live workout{summaryLine?.week ? ` · week ${summaryLine.week}` : ""}
            </div>
            {ro ? (
              <h2 className="truncate text-lg font-semibold text-[var(--text)]">{a.name}</h2>
            ) : (
              <input
                aria-label="Workout name"
                value={a.name}
                onChange={(e) => {
                  const v = e.target.value.slice(0, 80);
                  mutate((w) => {
                    w.name = v;
                  });
                }}
                className="-ml-1 w-full rounded-lg bg-transparent px-1 text-lg font-semibold text-[var(--text)] outline-none focus:bg-[var(--surface-2)]"
              />
            )}
          </div>
          {!ro && (
            <ItemButton variant="primary" icon={<Check className="h-4 w-4" />} onClick={() => setFinishing(true)}>
              Finish
            </ItemButton>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-lg font-semibold tabular-nums text-[var(--text)]" aria-label="Elapsed time">{fmtDuration(elapsed)}</div>
            <div className="text-[11px] text-[var(--text-muted)]">Time</div>
          </div>
          <div>
            <div className="text-lg font-semibold tabular-nums text-[var(--text)]">
              {done.length}
              <span className="text-sm text-[var(--text-muted)]">/{allSets.filter((x) => setType(x) !== "warmup").length}</span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">Sets</div>
          </div>
          <div>
            <div className="text-lg font-semibold tabular-nums text-[var(--text)]">{fmtBig(volume, s)}</div>
            <div className="text-[11px] text-[var(--text-muted)]">Volume ({s.units})</div>
          </div>
        </div>
      </Card>

      {a.exercises.length === 0 && (
        <Card className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-[var(--text-muted)]">An empty workout. Add the exercises as you go.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setPicker({ mode: "add" })}>
              Add exercises
            </ItemButton>
            <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Fill my live workout with a session that fits my plan and the time I have")}>
              Ask the coach
            </ItemButton>
          </div>
        </Card>
      )}

      {a.exercises.map((we, i) => (
        <ExerciseCard
          key={we.id}
          we={we}
          index={i}
          count={a.exercises.length}
          ctx={{ ...ctx, deload: !!a.deload }}
          s={s}
          ro={ro}
          focused={focused}
          setFocus={setFocus}
          onTick={tick}
          mutate={mutate}
          onSwap={() => setPicker({ mode: "swap", weId: we.id })}
          onPlates={(setId, kg) => setPlates({ weId: we.id, setId, kg, bar: loadEquipment(lib.get(we.exercise_id), s) })}
          onNotes={() => setNotesFor(we.id)}
          onHistory={() => setHistoryFor(we.exercise_id)}
          isPhone={isPhone}
        />
      ))}

      {!ro && a.exercises.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => setPicker({ mode: "add" })} className="flex-1">
            Add exercise
          </ItemButton>
          <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDiscard(true)}>
            Discard
          </ItemButton>
        </div>
      )}

      <RestTimer item={item} />

      <ExercisePicker
        open={!!picker}
        onClose={() => setPicker(null)}
        recent={recent}
        lib={lib}
        settings={s}
        multi={picker?.mode === "add"}
        title={picker?.mode === "swap" ? "Swap exercise" : "Add exercises"}
        hint={picker?.mode === "swap" ? "Unticked sets move to the new exercise with a fresh load." : undefined}
        onCreate={(c) =>
          item.update((d) => {
            if (!d.exercises.some((x) => x.id === c.id)) d.exercises.push(c);
          })
        }
        onPick={(exs) => {
          if (picker?.mode === "swap" && exs[0]) swap(picker.weId, exs[0]);
          else addExercises(exs);
        }}
      />
      {plates && (
        <PlateCalc
          open
          onClose={() => setPlates(null)}
          s={s}
          initialKg={plates.kg}
          bar={plates.bar}
          onUse={
            ro
              ? undefined
              : (kg) =>
                  mutate((w) => {
                    const st = w.exercises.find((x) => x.id === plates.weId)?.sets.find((x) => x.id === plates.setId);
                    if (st) st.kg = kg;
                  })
          }
        />
      )}
      {historyFor && (
        <Sheet open onClose={() => setHistoryFor(null)} title={lib.get(historyFor).name} size="lg">
          <ExerciseDetail ctx={ctx} data={item.data} id={historyFor} ask={(q) => { setHistoryFor(null); ask(q); }} />
        </Sheet>
      )}
      <NotesSheet
        we={a.exercises.find((x) => x.id === notesFor) ?? null}
        ex={notesFor ? lib.get(a.exercises.find((x) => x.id === notesFor)?.exercise_id ?? "") : null}
        s={s}
        onClose={() => setNotesFor(null)}
        onSave={(notes, rest) =>
          mutate((w) => {
            const we = w.exercises.find((x) => x.id === notesFor);
            if (we) {
              we.notes = notes;
              we.rest_s = rest;
            }
          })
        }
      />
      <FinishSheet
        open={finishing}
        onClose={() => setFinishing(false)}
        unticked={allSets.filter((x) => !x.done && setType(x) !== "warmup").length}
        hasAny={allSets.some((x) => x.done)}
        full={item.data.workouts.length >= MAX_WORKOUTS}
        onFinish={(notes) => {
          const id = a.id;
          const endedAt = isoWithOffset(new Date());
          item.update((d) => {
            const sid = d.active?.session_id;
            const day = d.active?.date;
            finishActive(d, notes, endedAt);
            // A planned session done on another day moves to the day it was
            // done (the calendar shows what happened; its old day frees up).
            const p = sid && day && !d.active ? d.planned.find((x) => x.id === sid && x.status === "done") : null;
            if (p && day && p.date !== day) {
              p.date = day;
              d.planned.sort((x, y) => (x.date + (x.time ?? "")).localeCompare(y.date + (y.time ?? "")));
            }
          });
          void cancelRestAlert();
          setFinishing(false);
          onFinished(id);
        }}
        onDiscard={() => setConfirmDiscard(true)}
      />
      <Sheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this workout?"
        size="sm"
        footer={
          <>
            <ItemButton block onClick={() => setConfirmDiscard(false)}>
              Keep going
            </ItemButton>
            <ItemButton
              variant="danger"
              block
              onClick={() => {
                item.update((d) => {
                  d.active = null;
                });
                void cancelRestAlert();
                setConfirmDiscard(false);
                setFinishing(false);
              }}
            >
              Discard
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text-muted)]">Nothing from it is saved to your history. (You can undo from the ⋯ menu.)</p>
      </Sheet>
    </div>
  );
}

/* ----------------------------------------------------------- exercise */

function ExerciseCard({
  we,
  index,
  count,
  ctx,
  s,
  ro,
  focused,
  setFocus,
  onTick,
  mutate,
  onSwap,
  onPlates,
  onNotes,
  onHistory,
  isPhone,
}: {
  we: WorkoutExercise;
  index: number;
  count: number;
  ctx: Ctx & { deload?: boolean };
  s: Settings;
  ro: boolean;
  focused: string | null;
  setFocus: (id: string | null) => void;
  onTick: (weId: string, setId: string, fill?: Partial<SetLog>) => void;
  mutate: (fn: (w: NonNullable<WorkoutData["active"]>, d: WorkoutData) => void) => void;
  onSwap: () => void;
  onPlates: (setId: string, kg: number | null) => void;
  onNotes: () => void;
  onHistory: () => void;
  isPhone: boolean;
}) {
  const { lib, hist } = ctx;
  const ex = lib.get(we.exercise_id);
  const cols = columns(ex, s);
  const last = hist.get(ex.id)?.slice(-1)[0];
  const lastByType = useMemo(() => {
    const m: Record<string, SetLog[]> = {};
    for (const st of last?.we.sets.filter((x) => x.done ?? true) ?? []) (m[setType(st)] ??= []).push(st);
    return m;
  }, [last]);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(menu, menuRef, () => setMenu(false));
  const rx = we.rx;
  const barbellish = ["barbell", "ez_bar", "trap_bar"].includes(loadEquipment(ex, s)) && ex.log === "weight_reps";
  const rest = restFor(we, ex, s);
  const allDone = we.sets.length > 0 && we.sets.every((x) => x.done);

  const editSet = (setId: string, fn: (st: SetLog) => void) =>
    mutate((w) => {
      const target = w.exercises.find((x) => x.id === we.id);
      const st = target?.sets.find((x) => x.id === setId);
      if (!target || !st) return;
      const before = st.kg;
      fn(st);
      // A working weight on the first working set: the warm-ups ramp to it.
      if (st.kg && st.kg !== before && ex.log === "weight_reps" && target.sets.find((x) => setType(x) === "working") === st) rampWarmups(target.sets, st.kg, ex, s);
    });
  const counters: Record<string, number> = {};
  // A phone has the "Last time" line and the editor's "Use" instead — the boxes get the width.
  const showPrev = !!last && !isPhone;
  const grid = setGrid(cols.length, showPrev);
  const rxLine = rx
    ? [
        `${rx.sets} × ${ex.log === "duration" ? fmtSecs(rx.seconds ?? 0) : ex.log === "distance" ? fmtMeters(rx.meters ?? 0) : rx.reps_min === rx.reps_max ? rx.reps_min : `${rx.reps_min}–${rx.reps_max}`}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <Card padded={false} className={cn("overflow-visible", allDone && "opacity-90")}>
      <div className="flex items-start gap-3 p-3 pb-2">
        <ExerciseBadge ex={ex} lib={lib} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-snug text-[var(--text)]">{ex.name}</h3>
            {we.superset && <Pill tone="accent" className="shrink-0">Superset {we.superset}</Pill>}
            {allDone && <Check className="h-4 w-4 text-[var(--success)]" aria-label="All sets done" />}
          </div>
          <div className="truncate text-xs text-[var(--text-muted)]">
            {rxLine ?? muscleLine(ex, lib)}
            <span className="ml-1 inline-flex items-center gap-0.5">
              · <Timer className="h-3 w-3" /> {fmtSecs(rest)}
            </span>
          </div>
          {(rx?.notes || we.notes) && <p className="mt-1 text-xs italic text-[var(--text-muted)]">{[rx?.notes, we.notes].filter(Boolean).join(" · ")}</p>}
        </div>
        {!ro && (
          <div className="relative" ref={menuRef}>
            <button type="button" aria-label={`${ex.name} options`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
              <MoreVertical className="h-5 w-5" />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 top-11 z-30 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]">
                <MenuBtn icon={Repeat2} label="Swap exercise" onClick={() => { setMenu(false); onSwap(); }} />
                {ex.log === "weight_reps" && (
                  <MenuBtn
                    icon={Flame}
                    label="Add warm-up sets"
                    onClick={() => {
                      setMenu(false);
                      const first = we.sets.find((x) => setType(x) === "working");
                      const work = first?.kg ?? first?.suggest_kg;
                      // No working weight yet: the ramp's reps; entering one fills in the weights.
                      const ws = (work ? warmups(work, ex, s) : warmupsBlank(ex, s)).map((x) => ({ id: uid("t"), type: "warmup" as const, kg: null, suggest_kg: x.kg, reps: x.reps, done: false }));
                      mutate((w) => {
                        const target = w.exercises.find((x) => x.id === we.id);
                        if (!target) return;
                        target.sets = [...ws.map((x) => ({ ...x })), ...target.sets.filter((x) => setType(x) !== "warmup" || x.done)];
                      });
                    }}
                  />
                )}
                {barbellish && <MenuBtn icon={Calculator} label="Plate calculator" onClick={() => { setMenu(false); onPlates(focused && we.sets.some((x) => x.id === focused) ? focused : we.sets[0]?.id ?? "", (() => { const o = we.sets.find((x) => !x.done); return o?.kg ?? o?.suggest_kg ?? null; })()); }} />}
                <MenuBtn icon={NotebookPen} label="Notes & rest time" onClick={() => { setMenu(false); onNotes(); }} />
                {hist.get(ex.id)?.length ? <MenuBtn icon={LineChart} label="History & records" onClick={() => { setMenu(false); onHistory(); }} /> : null}
                <MenuBtn
                  icon={Repeat2}
                  label={we.superset ? "Remove from superset" : index < count - 1 ? "Superset with next" : "Superset with previous"}
                  onClick={() => {
                    setMenu(false);
                    const leave = !!we.superset; // decided from what's on screen
                    mutate((w) => {
                      const i = w.exercises.findIndex((x) => x.id === we.id);
                      if (i < 0) return;
                      if (leave) {
                        w.exercises[i].superset = null;
                        return;
                      }
                      if (w.exercises[i].superset) return;
                      const j = i < w.exercises.length - 1 ? i + 1 : i - 1;
                      if (j < 0) return;
                      const used = new Set(w.exercises.map((x) => x.superset).filter(Boolean));
                      const letter = w.exercises[j].superset ?? "ABCDEFGH".split("").find((c) => !used.has(c)) ?? "A";
                      w.exercises[i].superset = letter;
                      w.exercises[j].superset = letter;
                    });
                  }}
                />
                {index > 0 && <MenuBtn icon={ArrowUp} label="Move up" onClick={() => { setMenu(false); mutate((w) => { const i = w.exercises.findIndex((x) => x.id === we.id); if (i > 0) [w.exercises[i - 1], w.exercises[i]] = [w.exercises[i], w.exercises[i - 1]]; }); }} />}
                {index < count - 1 && <MenuBtn icon={ArrowDown} label="Move down" onClick={() => { setMenu(false); mutate((w) => { const i = w.exercises.findIndex((x) => x.id === we.id); if (i >= 0 && i < w.exercises.length - 1) [w.exercises[i + 1], w.exercises[i]] = [w.exercises[i], w.exercises[i + 1]]; }); }} />}
                <MenuBtn icon={Trash2} label="Remove exercise" danger onClick={() => { setMenu(false); mutate((w) => { w.exercises = w.exercises.filter((x) => x.id !== we.id); }); }} />
              </div>
            )}
          </div>
        )}
      </div>
      {last && (
        <p className="px-3 pb-1 text-[11px] text-[var(--text-muted)]">
          Last time ({fmtDay(last.workout.date)}): {last.we.sets.filter(isHard).map((x) => fmtSet(x, ex, s)).join(", ")}
        </p>
      )}

      <div className="px-2 pb-2" role="group" aria-label={`${ex.name} sets`}>
        <div aria-hidden className="grid items-center gap-1.5 px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]" style={{ gridTemplateColumns: grid }}>
          <span>Set</span>
          {showPrev && <span>Previous</span>}
          {cols.map((c) => (
            <span key={c} className="text-center">
              {colLabel(c, ex, s)}
            </span>
          ))}
          <span />
        </div>
        {we.sets.map((st) => {
          const t = setType(st);
          counters[t] = (counters[t] ?? 0) + 1;
          const n = counters[t];
          const prev = lastByType[t]?.[n - 1];
          const isFocus = focused === st.id && !ro;
          const removeSet = () => mutate((w) => { const target = w.exercises.find((x) => x.id === we.id); if (target) target.sets = target.sets.filter((x) => x.id !== st.id); });
          const fill = fillFrom(st, cols, prev, rx, s);
          return (
            <div key={st.id} data-set-row={st.id} className="scroll-mb-32">
              <div
                role="group"
                aria-label={`${t === "working" ? `Set ${n}` : `${SET_NAME[t]} ${n}`}${st.done ? ", done" : ""}`}
                onClick={() => !ro && (isPhone || !st.done) && setFocus(isPhone && isFocus ? null : st.id)}
                className={cn(
                  "grid items-center gap-1.5 rounded-xl px-1 py-1 transition",
                  st.done && "bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
                  isFocus && (isPhone || !st.done) && "ring-1 ring-[var(--item-accent)]",
                )}
                style={{ gridTemplateColumns: grid }}
              >
                <SetBadge
                  s={st}
                  n={t === "working" ? n : 0}
                  onClick={ro || isPhone ? undefined : () => { const nextType = TYPES[(TYPES.indexOf(t) + 1) % TYPES.length]; editSet(st.id, (x) => { x.type = nextType; }); }}
                />
                {showPrev && (
                <button
                  type="button"
                  disabled={ro || !prev}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (prev) editSet(st.id, (x) => { x.kg = prev.kg ?? x.kg; x.reps = prev.reps ?? x.reps; x.seconds = prev.seconds ?? x.seconds; x.meters = prev.meters ?? x.meters; });
                  }}
                  className="truncate rounded-lg px-1 text-left text-xs tabular-nums text-[var(--text-muted)] enabled:hover:text-[var(--text)]"
                  aria-label={prev ? `Previous: ${fmtSet(prev, ex, s)} — copy` : "No previous set"}
                >
                  {prev ? fmtSet(prev, ex, s) : "—"}
                </button>
                )}
                {cols.map((c, ci) => (
                  <NumBox
                    key={c}
                    dataKey={`${st.id}-${ci}`}
                    label={`${t === "working" ? "Set" : SET_NAME[t]} ${n} ${colLabel(c, ex, s)}`}
                    value={getVal(st, c, s)}
                    placeholder={st.done ? null : hintFor(c, prev, rx, s, st)}
                    decimal={c !== "reps" && c !== "seconds"}
                    onCommit={(v) => {
                      // A new number also replaces the same old number in the sets
                      // below that aren't done yet (change 60→62.5 once, not 3×).
                      const was = getVal(st, c, s);
                      if (v === was) return;
                      mutate((w) => {
                        const target = w.exercises.find((x) => x.id === we.id);
                        const i = target ? target.sets.findIndex((x) => x.id === st.id) : -1;
                        if (!target || i < 0) return;
                        setVal(target.sets[i], c, v, s);
                        const typedKg = target.sets[i].kg;
                        if (c === "kg" && typedKg && ex.log === "weight_reps" && target.sets.find((x) => setType(x) === "working") === target.sets[i]) rampWarmups(target.sets, typedKg, ex, s);
                        if (st.done || v === null) return;
                        for (const x of target.sets.slice(i + 1)) {
                          if (x.done || setType(x) !== t) continue;
                          if (getVal(x, c, s) === was) setVal(x, c, v, s);
                          else break;
                        }
                      });
                    }}
                    onEnter={(v) => {
                      if (ci < cols.length - 1) document.querySelector<HTMLInputElement>(`[data-set-input="${st.id}-${ci + 1}"]`)?.focus();
                      else if (!st.done) {
                        // The box just typed counts even before the re-render.
                        const typed: SetLog = { id: st.id };
                        if (v != null) setVal(typed, c, v, s);
                        const { id: _id, ...own } = typed;
                        onTick(we.id, st.id, { ...fillFrom(st, cols, prev, rx, s), ...own });
                      }
                    }}
                    readOnly={isPhone}
                    className={cn((ro || isPhone) && "pointer-events-none", st.done && "bg-transparent")}
                  />
                ))}
                <button
                  type="button"
                  disabled={ro}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTick(we.id, st.id, fill);
                  }}
                  aria-pressed={!!st.done}
                  aria-label={`${st.done ? "Untick" : "Done —"} ${t === "working" ? `set ${n}` : `${SET_NAME[t].toLowerCase()} ${n}`}`}
                  className={cn(
                    "flex h-10 w-11 items-center justify-center rounded-xl transition active:scale-95",
                    st.done ? "bg-[var(--success)] text-white" : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]",
                  )}
                >
                  <Check className="h-5 w-5" />
                </button>
              </div>
              {isFocus && isPhone && (
                <FocusEditor
                  st={st}
                  ex={ex}
                  s={s}
                  cols={cols}
                  prev={prev}
                  hint={(c) => hintFor(c, prev, rx, s, st)}
                  onChange={(fn) => editSet(st.id, fn)}
                  onDone={() => (st.done ? setFocus(null) : onTick(we.id, st.id, fill))}
                  onPlates={barbellish ? () => onPlates(st.id, st.kg ?? st.suggest_kg ?? null) : undefined}
                  onDelete={removeSet}
                />
              )}
              {isFocus && !st.done && !isPhone && (
                <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1 pl-11">
                  <span className="text-[11px] text-[var(--text-muted)]">Enter moves on · Enter on the last box ticks the set</span>
                  {barbellish && st.kg ? (
                    <button type="button" onClick={() => onPlates(st.id, st.kg ?? null)} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                      <Calculator className="h-3.5 w-3.5" /> Plates
                    </button>
                  ) : null}
                  <button type="button" aria-label="Delete set" onClick={removeSet} className={cn("inline-flex items-center rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--danger)]", !(barbellish && st.kg) && "ml-auto")}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!ro && (
          <button
            type="button"
            onClick={() => {
              const id = uid("t");
              if (isPhone) setFocus(id);
              mutate((w) => {
                const target = w.exercises.find((x) => x.id === we.id);
                if (!target) return;
                // Copy the last set; the first set of an empty exercise starts
                // from the suggestion (last time / progression), like a planned one.
                const lastSet = [...target.sets].reverse().find((x) => setType(x) !== "warmup") ?? target.sets[target.sets.length - 1] ?? newSetsFor(ex, rx ?? null, hist.get(ex.id), s, uid, { warm: false }).find((x) => setType(x) === "working");
                target.sets.push({ id, type: "working", kg: null, suggest_kg: lastSet?.kg ?? lastSet?.suggest_kg ?? null, reps: lastSet?.reps ?? null, seconds: lastSet?.seconds ?? null, meters: lastSet?.meters ?? null, done: false });
              });
            }}
            className="mt-1 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <Plus className="h-4 w-4" /> Add set
          </button>
        )}
      </div>
    </Card>
  );
}

/** The greyed hint an empty box shows — for the weight, the suggested load
 *  (progression on what they've lifted / a stated best); else last time's
 *  number for this set, else the plan's target — and what ticking the set
 *  saves into it. Nothing known → no weight hint: they enter what they did. */
function hintFor(c: Col, prev: SetLog | undefined, rx: WorkoutExercise["rx"], s: Settings, st?: SetLog): number | null {
  if (c === "kg" && st?.suggest_kg != null) return getVal({ id: "", kg: st.suggest_kg }, c, s);
  const fromPrev = prev ? getVal(prev, c, s) : null;
  if (fromPrev != null) return fromPrev;
  if (!rx) return null;
  const plan: SetLog = { id: "", reps: rx.reps_min ?? null, seconds: rx.seconds ?? null, meters: rx.meters ?? null };
  return c === "kg" ? null : getVal(plan, c, s);
}

function fillFrom(st: SetLog, cols: Col[], prev: SetLog | undefined, rx: WorkoutExercise["rx"], s: Settings): Partial<SetLog> {
  const out: SetLog = { id: st.id };
  for (const c of cols) {
    if (getVal(st, c, s) != null) continue;
    const h = hintFor(c, prev, rx, s, st);
    if (h != null) setVal(out, c, h, s);
  }
  const { id: _id, ...rest } = out;
  return rest;
}

/** The set table's columns: badge · previous · the value boxes · tick. The
 *  value boxes share the width with "previous" (Strong's layout), so a wide
 *  screen doesn't strand the numbers at the far right. No history for the
 *  lift → no "previous" column, and the boxes get the room. */
function setGrid(n: number, prev = true): string {
  return `2rem ${prev ? "minmax(4.5rem,1.1fr) " : ""}${Array.from({ length: n }, () => "minmax(3.6rem,1fr)").join(" ")} 2.75rem`;
}

/** The phone's big editor under the tapped set — the only place a phone
 *  edits a set (the rows don't pop the keyboard): steppers (tap the number
 *  to type it), the set type, last time's set, done. Empty boxes start from
 *  their greyed hint, so + on "last time 8" makes 9. */
function FocusEditor({ st, ex, s, cols, prev, hint, onChange, onDone, onPlates, onDelete }: { st: SetLog; ex: Exercise; s: Settings; cols: Col[]; prev?: SetLog; hint: (c: Col) => number | null; onChange: (fn: (x: SetLog) => void) => void; onDone: () => void; onPlates?: () => void; onDelete: () => void }) {
  const t = setType(st);
  return (
    <div className="mx-1 mb-2 mt-1 flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="grid grid-cols-4 gap-1 rounded-xl bg-[var(--surface-2)] p-1" role="radiogroup" aria-label="Set type">
        {(["warmup", "working", "drop", "failure"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={t === k}
            onClick={() => onChange((x) => { x.type = k; })}
            className={cn("h-9 rounded-lg text-xs font-medium transition", t === k ? "bg-[var(--surface)] text-[var(--text)] shadow-sm" : "text-[var(--text-muted)]")}
          >
            {SET_NAME[k]}
          </button>
        ))}
      </div>
      {prev && (
        <button
          type="button"
          onClick={() => onChange((x) => { x.kg = prev.kg ?? x.kg; x.reps = prev.reps ?? x.reps; x.seconds = prev.seconds ?? x.seconds; x.meters = prev.meters ?? x.meters; })}
          className="-my-1 flex items-center justify-between rounded-lg px-1 py-1 text-xs text-[var(--text-muted)]"
        >
          <span>Last time: <span className="font-medium tabular-nums text-[var(--text)]">{fmtSet(prev, ex, s)}</span></span>
          <span className="font-medium text-[var(--item-accent)]">Use</span>
        </button>
      )}
      <div className={cn("grid gap-2", cols.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {cols.map((c) => {
          const shown = getVal(st, c, s) ?? hint(c);
          if (c === "kg") {
            const base = st.kg ?? (shown != null ? fromUnit(shown, s) : null);
            return (
              <div key={c} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--text-muted)]">{colLabel(c, ex, s)}</span>
                <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                  <button type="button" aria-label="Lighter" onClick={() => onChange((x) => { x.kg = stepLoad(x.kg ?? base, ex, s, -1); })} className="flex h-12 w-11 items-center justify-center text-lg font-semibold text-[var(--text-muted)] active:bg-[var(--hover-strong)]">−</button>
                  <NumBox
                    dataKey={`${st.id}-big`}
                    label={colLabel(c, ex, s)}
                    value={getVal(st, c, s)}
                    placeholder={hint(c)}
                    onCommit={(v) => onChange((x) => setVal(x, c, v, s))}
                    className="h-12 flex-1 bg-transparent text-xl focus:bg-transparent"
                  />
                  <button type="button" aria-label="Heavier" onClick={() => onChange((x) => { x.kg = stepLoad(x.kg ?? base, ex, s, 1); })} className="flex h-12 w-11 items-center justify-center text-lg font-semibold text-[var(--text-muted)] active:bg-[var(--hover-strong)]">+</button>
                </div>
              </div>
            );
          }
          return (
            <Stepper
              key={c}
              label={colLabel(c, ex, s)}
              value={shown ?? 0}
              step={c === "reps" ? 1 : c === "seconds" ? 5 : c === "km" ? 0.1 : c === "minutes" ? 1 : 10}
              min={0}
              onChange={(v) => onChange((x) => setVal(x, c, v, s))}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        {onPlates && (
          <button type="button" aria-label="Plate calculator" onClick={onPlates} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
            <Calculator className="h-4 w-4" />
          </button>
        )}
        <button type="button" aria-label="Delete set" onClick={onDelete} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-[var(--danger)]">
          <Trash2 className="h-4 w-4" />
        </button>
        <ItemButton variant="primary" size="lg" block icon={<Check className="h-5 w-5" />} onClick={onDone} className="min-w-0 flex-1 whitespace-nowrap">
          {st.done ? "Save" : t === "working" ? "Done" : `Done · ${SET_NAME[t]}`}
        </ItemButton>
      </div>
    </div>
  );
}

function MenuBtn({ icon: Icon, label, onClick, danger }: { icon: typeof Plus; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={cn("flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-[var(--hover)]", danger ? "text-[var(--danger)]" : "text-[var(--text)]")}>
      <Icon className="h-4 w-4 opacity-70" />
      {label}
    </button>
  );
}

function NotesSheet({ we, ex, s, onClose, onSave }: { we: WorkoutExercise | null; ex: Exercise | null; s: Settings; onClose: () => void; onSave: (notes: string, rest: number | null) => void }) {
  const [notes, setNotes] = useState("");
  const [rest, setRest] = useState(90);
  useEffect(() => {
    if (we && ex) {
      setNotes(we.notes ?? "");
      setRest(restFor(we, ex, s));
    }
  }, [we, ex, s]);
  return (
    <Sheet
      open={!!we}
      onClose={onClose}
      title={ex?.name ?? "Notes"}
      footer={
        <ItemButton variant="primary" block onClick={() => { onSave(notes.slice(0, 500), rest); onClose(); }}>
          Save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Notes">
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Seat height 4, grip width…" maxLength={500} />
        </Field>
        <Stepper label="Rest after each set (seconds)" value={rest} onChange={setRest} step={15} min={0} max={900} />
        <div className="flex flex-wrap gap-1.5">
          {[60, 90, 120, 180, 240, 300].map((r) => (
            <Chip key={r} active={rest === r} onClick={() => setRest(r)}>
              {fmtSecs(r)}
            </Chip>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function FinishSheet({ open, onClose, unticked, hasAny, full, onFinish, onDiscard }: { open: boolean; onClose: () => void; unticked: number; hasAny: boolean; full: boolean; onFinish: (notes: string) => void; onDiscard: () => void }) {
  const [notes, setNotes] = useState("");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Finish workout"
      footer={
        <ItemButton data-autofocus variant="primary" block size="lg" disabled={!hasAny || full} onClick={() => onFinish(notes.slice(0, 2000))} icon={<Check className="h-5 w-5" />}>
          Finish & save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        {full && (
          <p role="alert" className="rounded-xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] p-3 text-sm text-[var(--text)]">
            This file holds {MAX_WORKOUTS.toLocaleString()} workouts, its limit, so this one can't be saved yet. Use <b>Archive older data</b> in the file menu to move older workouts to a new file, then finish — your live workout is kept meanwhile.
          </p>
        )}
        {!hasAny ? (
          <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm text-[var(--text-muted)]">
            No sets are ticked yet. Tick what you did — or{" "}
            <button type="button" className="font-medium text-[var(--danger)] underline" onClick={onDiscard}>
              discard the workout
            </button>
            .
          </p>
        ) : (
          unticked > 0 && <p className="rounded-xl bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] p-3 text-sm text-[var(--text)]">{unticked} unticked set{unticked === 1 ? "" : "s"} won't be saved.</p>
        )}
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Slept badly, PR on bench…" />
        </Field>
      </div>
    </Sheet>
  );
}
