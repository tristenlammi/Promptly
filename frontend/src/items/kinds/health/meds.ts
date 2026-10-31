import { addDays, parseDay, uid } from "@/items/ui";

import type { Dose, HealthData, Medication, PlanStep, Schedule } from "./types";
import { momentAt, todayISO } from "./zone";

/* Medication schedules — mirrors backend meds.py (plans with history,
 * stop / resume that keep the past, per-time doses, as-needed limits). */

export const GRACE_MS = 3 * 3600_000;
export const LATE_MS = 3600_000;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday = 0 … Sunday = 6 (as stored). */
export function weekdayOf(day: string): number {
  return (parseDay(day).getDay() + 6) % 7;
}

// ------------------------------------------------------------------ plans

export interface Plan {
  schedule: Schedule;
  dose: string;
  per_dose: number;
  stopped: boolean;
}

export function ownPlan(m: Medication): Plan {
  return { schedule: m.schedule, dose: m.dose, per_dose: m.per_dose || 1, stopped: false };
}

/** The plan in effect on ``day``: the first history step that reaches it, else the medicine's own. */
export function planOn(m: Medication, day: string): Plan {
  const steps = [...(m.schedule_history ?? [])].sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
  for (const st of steps) if (day <= st.until) return { schedule: st.schedule, dose: st.dose, per_dose: st.per_dose || 1, stopped: !!st.stopped };
  return ownPlan(m);
}

function planKey(p: Plan): string {
  const s = p.schedule;
  const sd = Object.entries(s.slot_doses ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v.dose}/${v.per_dose ?? ""}`);
  return JSON.stringify([
    s.type,
    [...new Set(s.times)].sort(),
    [...new Set(s.weekdays)].sort(),
    s.every_days || 1,
    s.type === "interval" ? (s.anchor ?? null) : null,
    sd,
    p.dose,
    p.per_dose || 1,
    !!p.stopped,
  ]);
}

const samePlan = (a: Plan, b: Plan) => planKey(a) === planKey(b);

function step(p: Plan, until: string): PlanStep {
  return { until, schedule: structuredClone(p.schedule), dose: p.dose, per_dose: p.per_dose || 1, stopped: !!p.stopped };
}

/** Make ``next`` the plan from ``fromDay`` on (a mutator helper): earlier days keep
 *  the plan they had, later steps are replaced. Mirrors ``meds.change_plan``. */
export function changePlan(m: Medication, fromDay: string, next: { schedule: Schedule; dose: string; per_dose: number }): boolean {
  const sch: Schedule = structuredClone(next.schedule);
  if (sch.type === "interval" && !sch.anchor) sch.anchor = (m.start ?? "") < fromDay ? fromDay : m.start;
  const target: Plan = { schedule: sch, dose: next.dose, per_dose: next.per_dose || 1, stopped: false };
  const hist = [...(m.schedule_history ?? [])].sort((a, b) => (a.until < b.until ? -1 : 1));
  const future = hist.filter((s) => s.until >= fromDay);
  if (samePlan(planOn(m, fromDay), target) && !future.length && samePlan(ownPlan(m), target)) return false;
  const prev = addDays(fromDay, -1);
  let kept = hist.filter((s) => s.until < fromDay);
  if (!m.start || prev >= m.start) {
    const before = planOn(m, prev);
    const lastUntil = kept.length ? kept[kept.length - 1].until : null;
    if ((lastUntil === null || lastUntil < prev) && !samePlan(before, target)) kept.push(step(before, prev));
  } else kept = [];
  m.schedule_history = kept.slice(-120);
  m.schedule = target.schedule;
  m.dose = target.dose;
  m.per_dose = target.per_dose;
  return true;
}

/** Stop from now: today's later slots and every later day stop being due. */
export function stopMed(m: Medication, nowIso: string) {
  m.active = false;
  m.end = nowIso.slice(0, 10);
  m.stopped_at = nowIso;
}

/** Take it again from ``today``; the stopped days stay a break. */
export function resumeMed(m: Medication, today: string, doses: Dose[]) {
  const end = m.end;
  if (!m.active && end && end < today) {
    const loggedEnd = doses.some((d) => d.med_id === m.id && d.day === end);
    const lastFull = loggedEnd ? end : addDays(end, -1);
    const hist = [...(m.schedule_history ?? [])].sort((a, b) => (a.until < b.until ? -1 : 1));
    const kept = hist.filter((s) => s.until <= lastFull);
    const later = hist.filter((s) => s.until >= today);
    if ((!m.start || lastFull >= m.start) && (!kept.length || kept[kept.length - 1].until < lastFull)) kept.push(step(planOn(m, lastFull), lastFull));
    kept.push(step({ ...planOn(m, end), stopped: true }, addDays(today, -1)));
    m.schedule_history = [...kept, ...later].slice(-120);
  }
  m.active = true;
  m.end = null;
  m.stopped_at = null;
}

// --------------------------------------------------------------- schedule

export function isActiveOn(m: Medication, day: string): boolean {
  if (!m.active && !m.end) return false;
  if (m.start && day < m.start) return false;
  if (m.end && day > m.end) return false;
  return true;
}

/** Currently being taken (not stopped, not past its end). */
export function isCurrent(m: Medication, today = todayISO()): boolean {
  return m.active && (!m.end || m.end >= today);
}

export function timesOn(m: Medication, day: string): string[] {
  if (!isActiveOn(m, day)) return [];
  const p = planOn(m, day);
  if (p.stopped) return [];
  const s = p.schedule;
  if (s.type === "as_needed") return [];
  if (s.type === "days" && !s.weekdays.includes(weekdayOf(day))) return [];
  if (s.type === "interval") {
    const anchor = s.anchor || m.start;
    if (!anchor) return [];
    const diff = Math.round((parseDay(day).getTime() - parseDay(anchor).getTime()) / 86_400_000);
    if (((diff % Math.max(1, s.every_days)) + Math.max(1, s.every_days)) % Math.max(1, s.every_days) !== 0) return [];
  }
  return [...new Set(s.times)].sort();
}

export function isAsNeededOn(m: Medication, day: string): boolean {
  return planOn(m, day).schedule.type === "as_needed";
}

/** Units one dose uses at ``slot`` on ``day``. */
export function slotUnits(m: Medication, day: string, slot: string | null): number {
  const p = planOn(m, day);
  return (slot && p.schedule.slot_doses?.[slot]?.per_dose) || p.per_dose || 1;
}

/** The dose text at ``slot`` on ``day``. */
export function slotDose(m: Medication, day: string, slot: string | null): string {
  const p = planOn(m, day);
  return (slot && p.schedule.slot_doses?.[slot]?.dose) || p.dose || "";
}

export function doseKey(medId: string, day: string, slot: string | null) {
  return `${medId}|${day}|${slot ?? ""}`;
}

export function doseIndex(doses: Dose[]): Map<string, Dose> {
  const m = new Map<string, Dose>();
  for (const d of doses) m.set(doseKey(d.med_id, d.day, d.slot), d);
  return m;
}

export type SlotState = "taken" | "late" | "skipped" | "due" | "missed" | "upcoming";

export interface Slot {
  med: Medication;
  day: string;
  time: string;
  dose: string;
  state: SlotState;
  record?: Dose;
}

function afterStop(m: Medication, atMs: number): boolean {
  return !m.active && !!m.stopped_at && atMs > new Date(m.stopped_at).getTime();
}

export function slotsFor(data: HealthData, day: string, now = Date.now(), index = doseIndex(data.doses)): Slot[] {
  const out: Slot[] = [];
  for (const m of data.medications) {
    for (const t of timesOn(m, day)) {
      const at = new Date(momentAt(day, t)).getTime();
      if (afterStop(m, at)) continue;
      const record = index.get(doseKey(m.id, day, t));
      const state: SlotState = record ? record.status : at > now ? "upcoming" : at + GRACE_MS < now ? "missed" : "due";
      out.push({ med: m, day, time: t, dose: slotDose(m, day, t), state, record });
    }
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.med.name.localeCompare(b.med.name)));
}

export function perDayUsage(m: Medication, day = todayISO()): number {
  const p = planOn(m, day);
  const s = p.schedule;
  const times = [...new Set(s.times)];
  if (s.type === "as_needed" || !times.length || p.stopped) return 0;
  const perDay = times.reduce((a, t) => a + (s.slot_doses?.[t]?.per_dose || p.per_dose || 1), 0);
  if (s.type === "days") return (perDay * new Set(s.weekdays).size) / 7;
  if (s.type === "interval") return perDay / Math.max(1, s.every_days);
  return perDay;
}

export function supply(m: Medication): { daysLeft: number | null; runsOut: string | null } | null {
  if (m.remaining === null) return null;
  const today = todayISO();
  const use = perDayUsage(m, today);
  if (use <= 0) return { daysLeft: null, runsOut: null };
  const days = m.remaining / use;
  return { daysLeft: days, runsOut: addDays(today, Math.floor(days)) };
}

export interface Adherence {
  due: number;
  taken: number;
  late: number;
  skipped: number;
  missed: number;
  pct: number | null;
}

export function adherence(data: HealthData, days: number, medId?: string, now = Date.now()): Adherence {
  const idx = doseIndex(data.doses);
  const res: Adherence = { due: 0, taken: 0, late: 0, skipped: 0, missed: 0, pct: null };
  const end = todayISO(new Date(now));
  const scoped = { ...data, medications: medId ? data.medications.filter((m) => m.id === medId) : data.medications };
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(end, -i);
    for (const s of slotsFor(scoped, day, now, idx)) {
      if (s.state === "due" || s.state === "upcoming") continue;
      res.due += 1;
      res[s.state as "taken" | "late" | "skipped" | "missed"] += 1;
    }
  }
  res.pct = res.due ? Math.round((100 * (res.taken + res.late)) / res.due) : null;
  return res;
}

/** Warnings for taking ``m`` at ``atISO`` (more than its max a day, or too soon) — mirrors ``limit_warnings``. */
export function limitWarnings(data: HealthData, m: Medication, atISO: string): string[] {
  const out: string[] = [];
  const at = new Date(atISO).getTime();
  const taken = data.doses.filter((d) => d.med_id === m.id && d.status !== "skipped");
  if (m.max_per_day) {
    const n = taken.filter((d) => d.day === atISO.slice(0, 10)).length;
    if (n + 1 > m.max_per_day) out.push(`This would be dose ${n + 1} today — more than the ${m.max_per_day} a day on your plan. Check the label or with your pharmacist first.`);
  }
  if (m.min_hours_between) {
    const moments = taken.map((d) => (d.at ? new Date(d.at).getTime() : NaN)).filter((t) => Number.isFinite(t) && t <= at);
    if (moments.length) {
      const hours = (at - Math.max(...moments)) / 3600_000;
      if (hours < m.min_hours_between) out.push(`Only ${hours.toFixed(1)} h since the last dose — your plan says at least ${m.min_hours_between} h apart.`);
    }
  }
  return out;
}

/** Mark a slot (or an as-needed dose) — a mutator for ``item.update``.
 *  ``atISO`` is when it was taken (the person may have entered it). */
export function markDose(d: HealthData, medId: string, day: string, slot: string | null, status: Dose["status"] | null, atISO: string, id = uid("d")) {
  const med = d.medications.find((m) => m.id === medId);
  if (!med) return;
  const existing = slot !== null ? d.doses.find((x) => x.med_id === medId && x.day === day && x.slot === slot) : undefined;
  const wasTaken = !!existing && existing.status !== "skipped";
  let nowTaken = false;
  if (status === null) {
    if (existing) d.doses.splice(d.doses.indexOf(existing), 1);
  } else {
    let st = status;
    if (st === "taken" && slot && new Date(atISO).getTime() - new Date(momentAt(day, slot)).getTime() > LATE_MS) st = "late";
    nowTaken = st !== "skipped";
    if (existing) {
      existing.status = st;
      existing.at = nowTaken ? atISO : null;
    } else {
      // Never trims old records — the server refuses past the cap and the shell offers archiving.
      d.doses.push({ id, med_id: medId, day, slot, status: st, at: nowTaken ? atISO : null, note: "" });
    }
  }
  if (med.remaining !== null && wasTaken !== nowTaken) {
    const units = slotUnits(med, day, slot);
    med.remaining = Math.max(0, Math.round((med.remaining + (nowTaken ? -1 : 1) * units) * 100) / 100);
  }
}

/** Delete one dose record by id (a mutator) — gives the units back if it was taken. */
export function removeDose(d: HealthData, doseId: string) {
  const i = d.doses.findIndex((x) => x.id === doseId);
  if (i < 0) return;
  const rec = d.doses[i];
  const med = d.medications.find((m) => m.id === rec.med_id);
  if (med && med.remaining !== null && rec.status !== "skipped") med.remaining = Math.round((med.remaining + slotUnits(med, rec.day, rec.slot)) * 100) / 100;
  d.doses.splice(i, 1);
}

export function scheduleText(m: Medication, day = todayISO()): string {
  const p = planOn(m, day);
  const s = p.schedule;
  if (s.type === "as_needed") {
    const lim = [m.max_per_day ? `max ${m.max_per_day}/day` : "", m.min_hours_between ? `${m.min_hours_between} h apart` : ""].filter(Boolean).join(", ");
    return `As needed${lim ? ` · ${lim}` : ""}`;
  }
  const times = s.times.map((t) => (s.slot_doses?.[t]?.dose ? `${t} (${s.slot_doses[t].dose})` : t)).join(", ");
  if (s.type === "days") return `${s.weekdays.map((w) => WEEKDAYS[w]).join(" ")} · ${times}`;
  if (s.type === "interval" && s.every_days > 1) return `Every ${s.every_days} days · ${times}`;
  return `${s.times.length === 1 ? "Daily" : `${s.times.length}× daily`} · ${times}`;
}

/** Upcoming / past plan changes, for display ("From 5 Nov: 20 mg"). */
export function planChanges(m: Medication): { from: string; until: string | null; plan: Plan }[] {
  const steps = [...(m.schedule_history ?? [])].sort((a, b) => (a.until < b.until ? -1 : 1));
  const out: { from: string; until: string | null; plan: Plan }[] = [];
  let from = m.start ?? "";
  for (const st of steps) {
    out.push({ from, until: st.until, plan: { schedule: st.schedule, dose: st.dose, per_dose: st.per_dose, stopped: !!st.stopped } });
    from = addDays(st.until, 1);
  }
  out.push({ from, until: null, plan: ownPlan(m) });
  return out;
}

export const FOOD_LABEL: Record<Medication["with_food"], string> = {
  any: "",
  with: "With food",
  before: "Before food",
  after: "After food",
  empty: "Empty stomach",
};

export function newMedication(): Medication {
  return {
    id: uid("m"),
    name: "",
    kind: "medication",
    dose: "",
    form: "tablet",
    per_dose: 1,
    schedule: { type: "daily", times: ["08:00"], weekdays: [], every_days: 1, anchor: null, slot_doses: {} },
    with_food: "any",
    start: todayISO(),
    end: null,
    remaining: null,
    purpose: "",
    prescriber: "",
    instructions: "",
    active: true,
    stopped_at: null,
    color: "",
    max_per_day: null,
    min_hours_between: null,
    schedule_history: [],
  };
}
