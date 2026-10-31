import { Archive, ArchiveRestore, Bell, History, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Chip, Field, ItemButton, ScrollRow, Segmented, Sheet, Stepper, TextArea, TextInput, Toggle } from "@/items/ui";
import { cn } from "@/utils/cn";

import { WEEKDAYS } from "./engine";
import type { Habit, HabitsData, HabitType, ScheduleKind } from "./types";
import { COLORS, EMOJIS, IDEAS, TIMES, TYPE_LABEL, blankHabit, habitFromIdea, hasPast, rulesChanged } from "./util";

const KINDS: { id: ScheduleKind; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Some days" },
  { id: "per_week", label: "× a week" },
  { id: "per_month", label: "× a month" },
  { id: "every_n_days", label: "Every N days" },
];

/** Create or edit a habit — a bottom sheet on a phone, a dialog on desktop. */
export function HabitEditor({
  open,
  onClose,
  data,
  habit,
  onSave,
  onArchive,
  onDelete,
  ask,
  today,
}: {
  open: boolean;
  onClose: () => void;
  data: HabitsData;
  /** null = a new habit */
  habit: Habit | null;
  /** ``original`` = the habit as the editor opened it (only changed fields are saved). */
  onSave: (h: Habit, isNew: boolean, original: Habit | null, applyToPast?: boolean) => void;
  onArchive?: (h: Habit) => void;
  onDelete?: (h: Habit) => void;
  ask?: (prompt: string) => void;
  today: string;
}) {
  const [h, setH] = useState<Habit>(() => habit ?? blankHabit(data));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [more, setMore] = useState(false);
  const [newArea, setNewArea] = useState("");
  const [applyToPast, setApplyToPast] = useState(false);
  const isNew = !habit;

  useEffect(() => {
    if (!open) return;
    setH(habit ? structuredClone(habit) : blankHabit(data));
    setConfirmDelete(false);
    setMore(!!habit && !!(habit.identity || habit.why || habit.notes));
    setNewArea("");
    setApplyToPast(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, habit]);

  const set = <K extends keyof Habit>(k: K, v: Habit[K]) => setH((x) => ({ ...x, [k]: v }));
  const setSched = (patch: Partial<Habit["schedule"]>) => setH((x) => ({ ...x, schedule: { ...x.schedule, ...patch } }));
  const setType = (t: HabitType) =>
    setH((x) => ({
      ...x,
      type: t,
      target: t === "yes_no" ? 1 : t === "duration" ? (x.type === "duration" ? x.target : 10) : t === "count" ? (x.type === "count" ? x.target : 8) : x.target,
    }));

  const valid = h.name.trim().length > 0 && (h.schedule.kind !== "weekdays" || h.schedule.days.length > 0);
  const areas = Array.from(new Set([...data.settings.areas, ...(h.area ? [h.area] : [])]));

  // Changing the rules of a habit with history: past days keep the rules
  // they were lived under (an era), unless this is fixing a mistake.
  const rulesEdit = !!habit && rulesChanged(habit, h) && hasPast(habit, today);
  const flexible = h.schedule.kind === "per_week" || h.schedule.kind === "per_month";
  const remindDays = h.reminder_days ?? [];

  const submit = () => {
    if (!valid) return;
    onSave({ ...h, name: h.name.trim(), intention: h.intention.trim(), identity: h.identity.trim() }, isNew, habit, rulesEdit && applyToPast);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={isNew ? "New habit" : "Edit habit"}
      footer={
        <>
          {!isNew && onArchive && (
            <ItemButton
              variant="ghost"
              icon={h.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              onClick={() => {
                onArchive(h);
                onClose();
              }}
            >
              {h.archived ? "Restore" : "Archive"}
            </ItemButton>
          )}
          <ItemButton variant="primary" block disabled={!valid} onClick={submit}>
            {isNew ? "Add habit" : "Save"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-5 pt-1">
        {isNew && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-[var(--text-muted)]">Start from an idea</span>
            <ScrollRow>
              {IDEAS.map((idea) => (
                <Chip key={idea.name} onClick={() => setH(habitFromIdea(data, idea))} active={h.name === idea.name}>
                  <span aria-hidden>{idea.emoji}</span> {idea.name}
                </Chip>
              ))}
            </ScrollRow>
          </div>
        )}

        <div className="flex items-end gap-3">
          <Field label="Name" className="flex-1">
            <TextInput autoFocus={isNew} value={h.name} onChange={(e) => set("name", e.target.value)} placeholder="Drink water" maxLength={80} />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Icon</span>
          <div className="grid grid-cols-9 gap-1.5 sm:grid-cols-12" role="radiogroup" aria-label="Icon">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={h.emoji === e}
                aria-label={e}
                onClick={() => set("emoji", h.emoji === e ? "" : e)}
                className={cn(
                  "flex h-10 items-center justify-center rounded-xl text-xl transition",
                  h.emoji === e ? "bg-[color-mix(in_srgb,var(--item-accent)_18%,transparent)] ring-2 ring-[var(--item-accent)]" : "hover:bg-[var(--hover)]",
                )}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-1" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={h.color === c}
                aria-label={`Colour ${c}`}
                onClick={() => set("color", c)}
                className={cn("h-8 w-8 rounded-full transition", h.color === c && "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--bg)]")}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        <Field label="Type">
          <Segmented<HabitType>
            value={h.type}
            onChange={setType}
            size="sm"
            className="w-full"
            options={(Object.keys(TYPE_LABEL) as HabitType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
          />
        </Field>

        {h.type === "count" && (
          <div className="grid grid-cols-2 gap-3">
            <Stepper label="Goal per day" value={h.target} onChange={(v) => set("target", Math.max(1, v))} min={1} max={100000} />
            <Field label="Unit">
              <TextInput value={h.unit} onChange={(e) => set("unit", e.target.value)} placeholder="glasses" maxLength={24} />
            </Field>
          </div>
        )}
        {h.type === "duration" && <Stepper label="Minutes per day" value={h.target} onChange={(v) => set("target", Math.max(1, v))} step={5} min={1} max={1440} unit="min" />}
        {h.type === "avoid" && (
          <div className="flex flex-col gap-2">
            <Stepper label="Slips allowed per day" value={h.limit} onChange={(v) => set("limit", v)} min={0} max={1000} />
            <p className="text-xs text-[var(--text-muted)]">
              0 = quit completely. Days count as clean unless you log a slip; tap the circle to confirm a clean day.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Schedule</span>
          <ScrollRow>
            {KINDS.map((k) => (
              <Chip key={k.id} active={h.schedule.kind === k.id} onClick={() => setSched({ kind: k.id, days: k.id === "weekdays" && !h.schedule.days.length ? [0, 1, 2, 3, 4] : h.schedule.days })}>
                {k.label}
              </Chip>
            ))}
          </ScrollRow>
          {h.schedule.kind === "weekdays" && (
            <div className="grid grid-cols-7 gap-1.5" role="group" aria-label="Days">
              {WEEKDAYS.map((w, i) => {
                const on = h.schedule.days.includes(i);
                return (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSched({ days: on ? h.schedule.days.filter((d) => d !== i) : [...h.schedule.days, i].sort() })}
                    className={cn(
                      "h-11 rounded-xl text-xs font-semibold transition",
                      on ? "bg-[var(--item-accent)] text-white" : "border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                    )}
                  >
                    {w.slice(0, 2)}
                  </button>
                );
              })}
            </div>
          )}
          {(h.schedule.kind === "per_week" || h.schedule.kind === "per_month") && (
            <Stepper
              label={h.schedule.kind === "per_week" ? "Times per week" : "Times per month"}
              value={h.schedule.times}
              onChange={(v) => setSched({ times: v })}
              min={1}
              max={h.schedule.kind === "per_week" ? 7 : 31}
            />
          )}
          {h.schedule.kind === "every_n_days" && <Stepper label="Every … days" value={h.schedule.every} onChange={(v) => setSched({ every: v })} min={2} max={365} unit="days" />}
        </div>

        {rulesEdit && (
          <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-3" role="status">
            <p className="flex items-start gap-2 text-sm text-[var(--text)]">
              <History className="mt-0.5 h-4 w-4 shrink-0 text-[var(--item-accent)]" />
              <span>
                The new schedule / goal applies <strong>from today</strong>. Days before today keep the rules they had, so your streaks and stats stay
                honest.
              </span>
            </p>
            <label className="flex items-center justify-between gap-3 text-sm text-[var(--text-muted)]">
              <span>Fixing a mistake? Re-judge all past days with the new rules</span>
              <Toggle checked={applyToPast} onChange={setApplyToPast} label="Apply to past days too" />
            </label>
            {applyToPast && <p className="text-xs text-[var(--text-muted)]">Past streaks, rates and the strength score will be recalculated with the new set-up.</p>}
          </div>
        )}

        <Field label="Time of day">
          <Segmented value={h.time_of_day} onChange={(v) => set("time_of_day", v)} size="sm" className="w-full" options={TIMES.map((t) => ({ value: t.id, label: t.label }))} />
        </Field>

        <div className="flex flex-col gap-2 rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)] p-3">
          <Field label="Plan — when and where (implementation intention)" hint="Anchor it to something you already do: “After I pour my coffee, I will meditate for one minute.”">
            <TextInput value={h.intention} onChange={(e) => set("intention", e.target.value)} placeholder="After I …, I will …" maxLength={300} />
          </Field>
          {!h.intention && (
            <div className="flex flex-wrap gap-2">
              {["After I pour my coffee, I will ", "After I brush my teeth, I will ", "When I get home, I will ", "After lunch, I will "].map((s) => (
                <Chip key={s} onClick={() => set("intention", `${s}${h.name ? h.name.toLowerCase() : ""}`)}>
                  {s.replace(/, I will $/, "…")}
                </Chip>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
            <Bell className="h-3.5 w-3.5" /> Reminders (only while it's still to do)
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {h.reminders.map((t, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-xl border border-[var(--border)] pl-2">
                <input
                  type="time"
                  value={t}
                  aria-label={`Reminder ${i + 1}`}
                  onChange={(e) => set("reminders", h.reminders.map((x, j) => (j === i ? e.target.value || x : x)))}
                  className="h-10 bg-transparent text-sm tabular-nums text-[var(--text)] outline-none"
                />
                <button type="button" aria-label="Remove reminder" onClick={() => set("reminders", h.reminders.filter((_, j) => j !== i))} className="flex h-10 w-9 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]">
                  <X className="h-4 w-4" />
                </button>
              </span>
            ))}
            {h.reminders.length < 6 && (
              <ItemButton
                size="sm"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => set("reminders", [...h.reminders, h.time_of_day === "evening" ? "20:00" : h.time_of_day === "afternoon" ? "13:00" : "08:00"])}
              >
                Add time
              </ItemButton>
            )}
          </div>
        </div>

        {flexible && h.reminders.length > 0 && (
          <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-3">
            <span className="text-xs font-medium text-[var(--text-muted)]">For a {h.schedule.kind === "per_week" ? "weekly" : "monthly"} target, remind me…</span>
            <div className="grid grid-cols-7 gap-1.5" role="group" aria-label="Remind on these days">
              {WEEKDAYS.map((w, i) => {
                const on = remindDays.length === 0 || remindDays.includes(i);
                return (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Remind on ${w}`}
                    onClick={() => {
                      const cur = remindDays.length ? remindDays : [0, 1, 2, 3, 4, 5, 6];
                      const next = on ? cur.filter((d) => d !== i) : [...cur, i].sort();
                      set("reminder_days", next.length === 7 || next.length === 0 ? [] : next);
                    }}
                    className={cn(
                      "h-10 rounded-xl text-xs font-semibold transition",
                      on ? "bg-[color-mix(in_srgb,var(--item-accent)_22%,transparent)] text-[var(--text)]" : "border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                    )}
                  >
                    {w.slice(0, 2)}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
              <span>
                Only when I'm behind pace
                <span className="block text-xs text-[var(--text-muted)]">No nudge while you're on track for {h.schedule.times}× this {h.schedule.kind === "per_week" ? "week" : "month"}.</span>
              </span>
              <Toggle checked={!!h.remind_when_behind} onChange={(v) => set("remind_when_behind", v)} label="Only remind when behind pace" />
            </label>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Area</span>
          <div className="flex flex-wrap gap-2">
            {areas.map((a) => (
              <Chip key={a} active={h.area === a} onClick={() => set("area", h.area === a ? "" : a)}>
                {a}
              </Chip>
            ))}
            <TextInput
              value={newArea}
              onChange={(e) => setNewArea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newArea.trim()) {
                  e.preventDefault();
                  set("area", newArea.trim().slice(0, 40));
                  setNewArea("");
                }
              }}
              onBlur={() => {
                if (newArea.trim()) {
                  set("area", newArea.trim().slice(0, 40));
                  setNewArea("");
                }
              }}
              placeholder="New area…"
              aria-label="New area"
              className="!h-8 w-32 !text-xs"
            />
          </div>
        </div>

        <button type="button" onClick={() => setMore((m) => !m)} className="self-start text-sm font-medium text-[var(--item-accent)]" aria-expanded={more}>
          {more ? "Fewer details" : "Identity, why & notes…"}
        </button>
        {more && (
          <div className="flex flex-col gap-3">
            <Field label="Identity" hint="Each check-off is a vote for who you're becoming.">
              <TextInput value={h.identity} onChange={(e) => set("identity", e.target.value)} placeholder="I am someone who…" maxLength={200} />
            </Field>
            <Field label="Why it matters">
              <TextArea value={h.why} onChange={(e) => set("why", e.target.value)} maxLength={1000} className="min-h-[64px]" />
            </Field>
            <Field label="Notes">
              <TextArea value={h.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} className="min-h-[64px]" />
            </Field>
            <Field label="Start date">
              <TextInput type="date" value={h.start_date ?? ""} onChange={(e) => set("start_date", e.target.value || null)} />
            </Field>
          </div>
        )}

        {ask && isNew && (
          <ItemButton
            variant="ghost"
            icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />}
            onClick={() => {
              onClose();
              ask(h.name.trim() ? `Help me design a habit for "${h.name.trim()}" — make it tiny, anchored and scheduled, then add it.` : "Help me design one new habit that would make the biggest difference for me right now.");
            }}
          >
            Design it with the coach
          </ItemButton>
        )}

        {!isNew && onDelete && (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
            <span className="text-xs text-[var(--text-muted)]">Delete removes the habit and all its history.</span>
            {confirmDelete ? (
              <ItemButton
                variant="danger"
                size="sm"
                onClick={() => {
                  onDelete(h);
                  onClose();
                }}
              >
                Delete for good
              </ItemButton>
            ) : (
              <ItemButton variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>
                Delete
              </ItemButton>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
