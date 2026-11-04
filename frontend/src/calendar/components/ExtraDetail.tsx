import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ExternalLink, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";

import { calendarApi, type CalendarBootstrap, type CalExtras, type CalTask } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { selectTrip } from "@/items/kinds/trip/trips";
import { Field, ItemButton, Select, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { BOOTSTRAP_KEY, EXTRAS_KEY, useRefreshEventsAsync } from "../data";
import { addDays, combine, fmt, hm, localZone, parseYmd, sameDay, shortDay, startOfDay, timeLabel, ymd } from "../dates";
import { extraLabel, slotLabel, type Extra, type ViewEvent } from "../model";
import { TaskCheck } from "./ExtrasChips";

/** The little picture in front of an "Also show" chip. */
export function extraEmoji(x: Extra): string {
  switch (x.kind) {
    case "workout":
      return "🏋️";
    case "meals":
      return "🍽️";
    case "bill":
      return "💳";
    case "trip":
      return x.trip.emoji || "✈️";
    case "appointment":
      return "🩺";
    case "holiday":
      return "🎉";
    case "birthday":
      return x.b.kind === "birthday" ? "🎂" : "💍";
    case "task":
      return "";
  }
}

/** The app an item came from (for "Open in …"). */
const SOURCE: Record<Exclude<Extra["kind"], "holiday" | "birthday">, string> = {
  task: "Tasks",
  workout: "Workout",
  meals: "Meal plan",
  bill: "Budget",
  trip: "Trips",
  appointment: "Health",
};

/** Where an item lives in its own app (``null``: nowhere to open, a holiday). */
export function extraPath(x: Extra): string | null {
  switch (x.kind) {
    case "task":
      return `/apps/tasks/${x.task.file_id}`;
    case "workout":
      return `/apps/workout/${x.w.file_id}?tab=plan`;
    case "meals":
      return x.meals[0] ? `/apps/mealplan/${x.meals[0].file_id}?tab=plan` : null;
    case "bill":
      return `/apps/budget/${x.bill.file_id}?tab=subscriptions`;
    case "trip":
      return `/apps/trip/${x.trip.file_id}`;
    case "appointment":
      return `/apps/health/${x.a.file_id}?tab=records`;
    case "birthday":
      return `/apps/contacts/${x.b.file_id}?c=${encodeURIComponent(x.b.contact_id)}`;
    case "holiday":
      return null;
  }
}

/** Open an item in its app, at the right place (a trip opens on that trip). */
export function openExtraSource(x: Extra, navigate: NavigateFunction) {
  const path = extraPath(x);
  if (!path) return;
  if (x.kind === "trip") selectTrip(x.trip.file_id, x.trip.trip_id);
  navigate(path);
}

// ------------------------------------------------------------------ planning a task

/** A sensible first slot for a task: its own time, else the next hour today, else 9am on its day. */
export function defaultPlanStart(t: CalTask): Date {
  const day = parseYmd(t.due);
  if (t.time) return combine(t.due, t.time);
  const now = new Date();
  const base = day < startOfDay(now) ? startOfDay(now) : day;
  if (sameDay(base, now)) {
    const s = new Date(now);
    s.setHours(now.getHours() + 1, 0, 0, 0);
    return s;
  }
  const s = new Date(base);
  s.setHours(9, 0, 0, 0);
  return s;
}

/** Put a task into a time slot: an event on my own calendar, linked to the
 *  task (``source``), so the task shows as planned and the event can tick
 *  it off. */
export function usePlanTask() {
  const qc = useQueryClient();
  const refresh = useRefreshEventsAsync();
  return async (t: CalTask, start: Date, end: Date) => {
    const b = qc.getQueryData<CalendarBootstrap>(BOOTSTRAP_KEY);
    const own = b?.calendars.find((c) => c.personal && c.owner_id === b.me.id);
    try {
      const r = await calendarApi.create({
        title: t.title || "Task",
        start: start.toISOString(),
        end: end.toISOString(),
        tz: localZone(),
        calendar_id: own?.id ?? null,
        source: { kind: "task", file_id: t.file_id, task_id: t.task_id },
      });
      const planned = { event_id: r.event.event_id, start: r.event.start, end: r.event.end };
      qc.setQueriesData<CalExtras>({ queryKey: EXTRAS_KEY }, (d) =>
        d ? { ...d, tasks: d.tasks.map((x) => (x.file_id === t.file_id && x.task_id === t.task_id ? { ...x, planned } : x)) } : d,
      );
      void refresh();
      toast.success(`Planned for ${shortDay(start)}, ${timeLabel(start)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void calendarApi
              .remove(r.event.event_id)
              .catch((err) => toast.error(extractError(err) || "Couldn't undo that."))
              .finally(() => void refresh());
          },
        },
      });
    } catch (err) {
      toast.error(extractError(err) || "Couldn't plan that.");
    }
  };
}

const LENGTHS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 45, label: "45 min" },
  { value: 60, label: "1 hour" },
  { value: 90, label: "1½ hours" },
  { value: 120, label: "2 hours" },
];

/** "Plan a time" for a task: a day, a start and how long (works with a finger). */
export function PlanTaskForm({ task, onDone, onCancel }: { task: CalTask; onDone: () => void; onCancel: () => void }) {
  const plan = usePlanTask();
  const first = defaultPlanStart(task);
  const [day, setDay] = useState(ymd(first));
  const [time, setTime] = useState(hm(first));
  const [mins, setMins] = useState(60);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const start = combine(day, time);
    setBusy(true);
    await plan(task, start, new Date(start.getTime() + mins * 60_000));
    setBusy(false);
    onDone();
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Day">
          <TextInput type="date" value={day} onChange={(e) => setDay(e.target.value || day)} />
        </Field>
        <Field label="Start">
          <TextInput type="time" value={time} step={900} onChange={(e) => setTime(e.target.value || time)} />
        </Field>
      </div>
      <Field label="How long">
        <Select value={mins} onChange={(e) => setMins(Number(e.target.value))}>
          {LENGTHS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end gap-2">
        <ItemButton size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </ItemButton>
        <ItemButton size="sm" variant="primary" disabled={busy} onClick={() => void go()}>
          Plan it
        </ItemButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ details

function Header({ emoji, title, sub, onClose, lead }: { emoji?: string; title: string; sub: ReactNode; onClose: () => void; lead?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      {lead ?? (emoji ? <span aria-hidden className="mt-0.5 text-2xl leading-none">{emoji}</span> : null)}
      <div className="min-w-0 flex-1">
        <h2 className="break-words text-lg font-semibold leading-snug">{title}</h2>
        <p className="text-[var(--text-muted)]">{sub}</p>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A task, workout, day's meals, bill, trip or holiday opened (popover /
 *  sheet body): what it is, and a way into its own app. Read-only here. */
export function ExtraDetail({ v, onClose, onOpenEvent }: { v: ViewEvent; onClose: () => void; onOpenEvent?: (eventId: string) => void }) {
  const navigate = useNavigate();
  const x = v.extra!;
  const [planning, setPlanning] = useState(false);
  const day = shortDay(v.start);
  let sub: ReactNode = day;
  let body: ReactNode = null;
  let lead: ReactNode | undefined;
  switch (x.kind) {
    case "task": {
      const t = x.task;
      lead = (
        <span className="mt-1">
          <TaskCheck task={t} size={20} />
        </span>
      );
      sub = `${t.time ? `${day}, ${timeLabel(v.start)}` : `Due ${day}`} · ${t.list}`;
      const p = t.planned;
      body = (
        <>
          {p && (
            <button
              type="button"
              onClick={() => onOpenEvent?.(p.event_id)}
              disabled={!onOpenEvent}
              className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--surface))] px-3 py-2 text-left text-sm text-[var(--text)] enabled:hover:brightness-95"
            >
              <CalendarClock className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
              <span>
                Planned for {shortDay(new Date(p.start))}, {timeLabel(new Date(p.start))}
              </span>
            </button>
          )}
          {planning ? (
            <PlanTaskForm task={t} onDone={onClose} onCancel={() => setPlanning(false)} />
          ) : (
            <p className="text-xs text-[var(--text-muted)]">Tip: drag a task onto a time in week or day view to plan it.</p>
          )}
        </>
      );
      break;
    }
    case "workout": {
      const w = x.w;
      sub = w.kind === "day" ? `${day} · one of your training days, nothing planned yet` : `${day}${w.time ? `, ${timeLabel(v.start)}` : ""}${w.exercises ? ` · ${w.exercises} exercise${w.exercises === 1 ? "" : "s"}` : ""}${w.done ? " · Done" : ""}`;
      break;
    }
    case "meals":
      body = (
        <ul className="flex flex-col gap-1">
          {x.meals.map((m) => (
            <li key={m.id} className="flex items-baseline gap-2">
              <span className="w-20 shrink-0 text-xs font-medium text-[var(--text-muted)]">{slotLabel(m.slot)}</span>
              <span className={m.cooked ? "text-[var(--text-muted)] line-through" : ""}>{m.title}</span>
            </li>
          ))}
        </ul>
      );
      break;
    case "bill":
      sub = `Due ${day} · ${x.bill.amount} · ${x.bill.cadence} ${x.bill.kind}`;
      break;
    case "trip": {
      const last = addDays(v.end, -1);
      sub = sameDay(v.start, last) ? day : `${fmt(v.start, { month: "short", day: "numeric" })} – ${shortDay(last)}`;
      break;
    }
    case "appointment": {
      const a = x.a;
      sub = `${day}, ${timeLabel(v.start)}${a.done ? " · Done" : ""}`;
      if (a.location) body = <p className="text-[var(--text-muted)]">{a.location}</p>;
      break;
    }
    case "holiday":
      sub = `${day} · public holiday in ${regionName(x.h.country)}`;
      break;
    case "birthday":
      break;
  }
  const title = x.kind === "meals" ? "Meals" : x.kind === "task" ? x.task.title : extraLabel(x);
  const source = x.kind === "holiday" || x.kind === "birthday" ? null : SOURCE[x.kind];
  return (
    <div className="flex flex-col gap-4 text-sm text-[var(--text)]">
      <Header emoji={extraEmoji(x)} title={title} sub={sub} onClose={onClose} lead={lead} />
      {body}
      {(source || (x.kind === "task" && !planning)) && (
        <div className="flex flex-wrap gap-2">
          {x.kind === "task" && !planning && (
            <ItemButton size="sm" variant="primary" icon={<CalendarClock className="h-3.5 w-3.5" />} onClick={() => setPlanning(true)}>
              {x.task.planned ? "Plan another time" : "Plan a time"}
            </ItemButton>
          )}
          {source && (
            <ItemButton
              size="sm"
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={() => {
                onClose();
                openExtraSource(x, navigate);
              }}
            >
              Open in {source}
            </ItemButton>
          )}
        </div>
      )}
    </div>
  );
}
