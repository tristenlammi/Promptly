import { ArrowLeft, CalendarDays, ClipboardList, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { ItemButton, Sheet, addDays, fmtDay, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import type { Library } from "./catalog";
import { estimateMinutes, isAvailable } from "./science";
import { ExerciseBadge, WEEKDAYS } from "./shared";
import type { PlannedSession, Prescription, Routine, Settings, WorkoutData } from "./types";

/*
 * Ready-made programs — the no-AI way to get a sensible plan (Strong's and
 * Hevy's template libraries). Each slot lists exercises in order of
 * preference; the first one their equipment allows is used, so the same
 * template works in a full gym, a home gym, with dumbbells only or with
 * nothing. Loads are left to the logger (history, else a calibration start).
 */

type Slot = { pick: string[]; sets: number; reps: [number, number]; seconds?: number; optional?: boolean };
type Day = { name: string; slots: Slot[] };
interface Template {
  id: string;
  name: string;
  days: number;
  level: string;
  blurb: string;
  routines: Day[];
}

const S = {
  squat: ["back_squat", "hack_squat", "goblet_squat", "bodyweight_squat"],
  hinge: ["rdl", "db_rdl", "single_leg_glute_bridge"],
  deadlift: ["deadlift", "trap_bar_deadlift", "db_rdl", "back_extension"],
  hpush: ["bench_press", "db_bench", "machine_chest_press", "pushup"],
  incline: ["incline_bench", "db_incline_bench", "smith_incline_press", "pushup"],
  vpush: ["ohp", "db_shoulder_press", "machine_shoulder_press", "band_overhead_press", "pike_pushup"],
  hpull: ["barbell_row", "db_row", "seated_cable_row", "inverted_row", "band_row"],
  row2: ["seated_cable_row", "chest_supported_row", "db_row", "inverted_row", "band_row"],
  vpull: ["lat_pulldown", "pullup", "assisted_pullup", "band_pulldown"],
  chin: ["chinup", "close_grip_pulldown", "lat_pulldown", "band_pulldown"],
  lunge: ["bulgarian_split_squat", "db_walking_lunge", "barbell_lunge", "walking_lunge"],
  legcurl: ["lying_leg_curl", "seated_leg_curl", "nordic_curl", "single_leg_glute_bridge"],
  legext: ["leg_extension", "cossack_squat"],
  hipthrust: ["hip_thrust", "db_hip_thrust", "glute_drive", "glute_bridge"],
  lateral: ["db_lateral_raise", "cable_lateral_raise", "machine_lateral_raise", "band_lateral_raise"],
  rear: ["face_pull", "reverse_pec_deck", "db_rear_delt_fly", "band_pull_apart"],
  fly: ["cable_fly", "pec_deck", "db_fly"],
  curl: ["db_curl", "ez_curl", "barbell_curl", "cable_curl", "band_curl"],
  hammer: ["hammer_curl", "cable_curl", "band_curl"],
  triceps: ["triceps_pushdown", "db_overhead_ext", "skull_crusher", "band_pushdown", "diamond_pushup"],
  calves: ["standing_calf_raise", "db_calf_raise", "bw_calf_raise"],
  core: ["hanging_leg_raise", "cable_crunch", "ab_wheel", "reverse_crunch"],
  plank: ["plank"],
};

const sl = (pick: string[], sets: number, reps: [number, number], extra: Partial<Slot> = {}): Slot => ({ pick, sets, reps, ...extra });

export const TEMPLATES: Template[] = [
  {
    id: "fb3",
    name: "Full body",
    days: 3,
    level: "Beginner",
    blurb: "Two alternating sessions (A/B), every big movement each time. The best start, and plenty for most people.",
    routines: [
      { name: "Full body A", slots: [sl(S.squat, 3, [5, 8]), sl(S.hpush, 3, [5, 8]), sl(S.hpull, 3, [8, 10]), sl(S.lateral, 2, [12, 15]), sl(S.plank, 2, [1, 1], { seconds: 45 })] },
      { name: "Full body B", slots: [sl(S.hinge, 3, [6, 10]), sl(S.vpush, 3, [6, 10]), sl(S.vpull, 3, [8, 12]), sl(S.lunge, 2, [8, 12]), sl(S.curl, 2, [10, 15])] },
    ],
  },
  {
    id: "ul4",
    name: "Upper / Lower",
    days: 4,
    level: "Intermediate",
    blurb: "Each muscle twice a week with room for more sets — the classic next step after full body.",
    routines: [
      { name: "Upper A", slots: [sl(S.hpush, 4, [5, 8]), sl(S.hpull, 4, [6, 10]), sl(S.vpush, 3, [8, 10]), sl(S.vpull, 3, [8, 12]), sl(S.curl, 2, [10, 15]), sl(S.triceps, 2, [10, 15])] },
      { name: "Lower A", slots: [sl(S.squat, 4, [5, 8]), sl(S.hinge, 3, [6, 10]), sl(S.legcurl, 3, [10, 12]), sl(S.calves, 3, [10, 15]), sl(S.core, 3, [10, 15])] },
      { name: "Upper B", slots: [sl(S.incline, 3, [8, 12]), sl(S.chin, 4, [6, 10]), sl(S.row2, 3, [8, 12]), sl(S.lateral, 3, [12, 20]), sl(S.rear, 2, [12, 20]), sl(S.hammer, 2, [10, 15])] },
      { name: "Lower B", slots: [sl(S.deadlift, 3, [3, 5]), sl(S.lunge, 3, [8, 12]), sl(S.legext, 3, [10, 15], { optional: true }), sl(S.hipthrust, 3, [8, 12]), sl(S.calves, 3, [10, 15])] },
    ],
  },
  {
    id: "ppl",
    name: "Push / Pull / Legs",
    days: 6,
    level: "Intermediate",
    blurb: "Run it twice a week (6 days) for high volume, or once (3 days) for a lighter week.",
    routines: [
      { name: "Push", slots: [sl(S.hpush, 4, [6, 10]), sl(S.vpush, 3, [8, 10]), sl(S.incline, 3, [8, 12]), sl(S.lateral, 3, [12, 20]), sl(S.triceps, 3, [10, 15])] },
      { name: "Pull", slots: [sl(S.vpull, 4, [6, 10]), sl(S.hpull, 3, [8, 12]), sl(S.rear, 3, [12, 20]), sl(S.curl, 3, [10, 15]), sl(S.hammer, 2, [10, 15])] },
      { name: "Legs", slots: [sl(S.squat, 4, [5, 8]), sl(S.hinge, 3, [6, 10]), sl(S.legcurl, 3, [10, 12]), sl(S.legext, 3, [10, 15], { optional: true }), sl(S.calves, 3, [10, 15])] },
    ],
  },
  {
    id: "5x5",
    name: "5×5 strength",
    days: 3,
    level: "Beginner · barbell",
    blurb: "Squat every session, alternate A/B, add weight whenever all 5×5 are done. Simple linear strength.",
    routines: [
      { name: "5×5 A", slots: [sl(S.squat, 5, [5, 5]), sl(S.hpush, 5, [5, 5]), sl(S.hpull, 5, [5, 5])] },
      { name: "5×5 B", slots: [sl(S.squat, 5, [5, 5]), sl(S.vpush, 5, [5, 5]), sl(S.deadlift, 1, [5, 5])] },
    ],
  },
  {
    id: "min2",
    name: "Minimalist",
    days: 2,
    level: "Busy weeks",
    blurb: "Two 45-minute full-body sessions — about 80% of the results for a third of the time.",
    routines: [
      { name: "Minimal A", slots: [sl(S.squat, 3, [6, 10]), sl(S.hpush, 3, [6, 10]), sl(S.vpull, 3, [8, 12]), sl(S.fly, 2, [12, 15], { optional: true })] },
      { name: "Minimal B", slots: [sl(S.hinge, 3, [6, 10]), sl(S.vpush, 3, [8, 12]), sl(S.hpull, 3, [8, 12]), sl(S.calves, 2, [10, 15])] },
    ],
  },
];

/** The template's routines, with each slot resolved to their equipment. */
export function resolveTemplate(t: Template, lib: Library, s: Settings): Routine[] {
  return t.routines.map((day) => {
    const exercises: Prescription[] = [];
    const used = new Set<string>();
    for (const slot of day.slots) {
      const ok = slot.pick.filter((id) => lib.byId[id] && !used.has(id));
      const id = ok.find((x) => isAvailable(lib.get(x), s)) ?? (slot.optional ? null : ok[0]);
      if (!id) continue;
      used.add(id);
      const ex = lib.get(id);
      exercises.push({
        id: uid("x"),
        exercise_id: id,
        sets: slot.sets,
        reps_min: ex.log === "duration" ? 1 : slot.reps[0],
        reps_max: ex.log === "duration" ? 1 : slot.reps[1],
        seconds: ex.log === "duration" ? slot.seconds ?? 45 : null,
        meters: null,
        load_kg: null,
        load_pct: null,
        rest_s: null,
        superset: null,
        warmup: null,
        drop_sets: 0,
        notes: "",
      });
    }
    return { id: uid("r"), name: day.name, notes: "", exercises };
  });
}

/** Weekdays (0 = Mon) to train on: their preferred days, else a spread. */
function trainingDays(s: Settings, n: number): number[] {
  const pref = [...new Set(s.training_days ?? [])].sort((a, b) => a - b);
  if (pref.length >= n) return pref.slice(0, n);
  const spread: Record<number, number[]> = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5], 7: [0, 1, 2, 3, 4, 5, 6] };
  // Their days first, topped up from an even spread (then any free day).
  const out = [...pref];
  for (const d of [...spread[Math.min(7, Math.max(1, n))], 0, 1, 2, 3, 4, 5, 6]) if (out.length < n && !out.includes(d)) out.push(d);
  return out.sort((a, b) => a - b);
}

/** Planned sessions rotating through the routines on their days, from today for ``weeks``. */
function scheduleFor(routines: Routine[], s: Settings, perWeek: number, weeks: number, taken: Set<string>): PlannedSession[] {
  const days = new Set(trainingDays(s, perWeek));
  const out: PlannedSession[] = [];
  const today = todayISO();
  let k = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(today, i);
    const dow = (new Date(d + "T12:00").getDay() + 6) % 7;
    if (!days.has(dow) || taken.has(d)) continue;
    const r = routines[k++ % routines.length];
    out.push({ id: uid("s"), date: d, time: null, name: r.name, notes: r.notes, exercises: r.exercises.map((x) => ({ ...x, id: uid("x") })), program_id: null, week: null, deload: false, status: "planned", workout_id: null });
  }
  return out;
}

export function TemplatesSheet({ open, onClose, item, lib, onAdded }: { open: boolean; onClose: () => void; item: ItemHandle<WorkoutData>; lib: Library; onAdded?: () => void }) {
  const s = item.data.settings;
  const [pick, setPick] = useState<string | null>(null);
  const [perWeek, setPerWeek] = useState<number | null>(null);
  const t = TEMPLATES.find((x) => x.id === pick) ?? null;
  // Resolved once per pick, so the ids shown are the ids saved.
  const resolved = useMemo(() => (t ? resolveTemplate(t, lib, s) : []), [t, lib, s]);
  const days = perWeek ?? (t ? (t.id === "ppl" ? Math.min(6, Math.max(3, s.days_per_week)) : t.days) : 3);
  const sched = trainingDays(s, days);
  const close = () => {
    setPick(null);
    setPerWeek(null);
    onClose();
  };

  const add = (schedule: boolean) => {
    if (!t) return;
    const room = 100 - item.data.routines.length;
    if (room < resolved.length) {
      toast.error(`There's room for ${room} more routine${room === 1 ? "" : "s"} — delete some first.`);
      return;
    }
    const taken = new Set(item.data.planned.filter((p) => p.status === "planned").map((p) => p.date));
    const sessions = schedule ? scheduleFor(resolved, s, days, 4, taken) : [];
    const routines = resolved.map((r) => ({ ...r, exercises: r.exercises.map((x) => ({ ...x })) }));
    item.update((d) => {
      d.routines.push(...structuredClone(routines));
      if (sessions.length) {
        d.planned.push(...structuredClone(sessions));
        d.planned.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
      }
    });
    toast.success(schedule ? `Added ${t.name}: ${resolved.length} routines, ${sessions.length} sessions over 4 weeks` : `Added ${resolved.length} routines from ${t.name}`);
    close();
    onAdded?.();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t ? t.name : "Program templates"}
      size="lg"
      footer={
        t && item.canEdit ? (
          <>
            <ItemButton block icon={<ClipboardList className="h-4 w-4" />} onClick={() => add(false)}>
              Just routines
            </ItemButton>
            <ItemButton variant="primary" block icon={<CalendarDays className="h-4 w-4" />} onClick={() => add(true)}>
              Plan 4 weeks
            </ItemButton>
          </>
        ) : undefined
      }
    >
      {!t ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[var(--text-muted)]">Proven splits, fitted to your equipment. They become routines you can edit — and, if you like, sessions on your calendar.</p>
          {TEMPLATES.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setPick(x.id)}
              className="flex flex-col gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition hover:border-[var(--item-accent)]"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[var(--text)]">{x.name}</span>
                <span className="shrink-0 text-xs font-medium text-[var(--item-accent)]">
                  {x.id === "ppl" ? "3 or 6" : x.days} days/week
                </span>
              </span>
              <span className="text-xs text-[var(--text-muted)]">{x.level} · {x.routines.map((r) => r.name).join(" · ")}</span>
              <span className="text-sm text-[var(--text-muted)]">{x.blurb}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <button type="button" onClick={() => setPick(null)} className="inline-flex items-center gap-1 self-start rounded-lg px-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
            <ArrowLeft className="h-4 w-4" /> All templates
          </button>
          <p className="text-sm text-[var(--text-muted)]">{t.blurb}</p>
          {t.id === "ppl" && (
            <div className="flex gap-2" role="group" aria-label="Days per week">
              {[3, 6].map((n) => (
                <button key={n} type="button" aria-pressed={days === n} onClick={() => setPerWeek(n)} className={cn("h-10 flex-1 rounded-xl border text-sm font-medium", days === n ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]")}>
                  {n} days a week
                </button>
              ))}
            </div>
          )}
          {resolved.map((r) => (
            <div key={r.id} className="rounded-2xl border border-[var(--border)] p-3">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="font-semibold text-[var(--text)]">{r.name}</span>
                <span className="text-xs text-[var(--text-muted)]">~{estimateMinutes(r.exercises, lib, s)} min</span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {r.exercises.map((rx) => {
                  const ex = lib.get(rx.exercise_id);
                  return (
                    <li key={rx.id} className="flex items-center gap-2 text-sm">
                      <ExerciseBadge ex={ex} lib={lib} size={28} />
                      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{ex.name}</span>
                      <span className="shrink-0 tabular-nums text-xs text-[var(--text-muted)]">
                        {rx.sets} × {ex.log === "duration" ? `${rx.seconds}s` : rx.reps_min === rx.reps_max ? rx.reps_min : `${rx.reps_min}–${rx.reps_max}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="flex items-start gap-2 rounded-xl bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
            <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Schedule puts {days} sessions a week on {sched.map((d) => WEEKDAYS[d]).join(", ")} for 4 weeks from {fmtDay(todayISO())} (days that already have a session are skipped). Weights come from your history — the first time, start light and the logger calibrates.
            </span>
          </p>
        </div>
      )}
    </Sheet>
  );
}
