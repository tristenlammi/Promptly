import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Pill, RotateCcw, SkipForward } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, IconButton, ItemButton, List, ListRow, Segmented, Sheet, addDays, fmtDay, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { Badge, Callout } from "./common";
import { FOOD_LABEL, isActiveOn, isAsNeededOn, limitWarnings, markDose, removeDose, slotDose, slotsFor, type Slot } from "./meds";
import type { Dose, HealthData, Medication } from "./types";
import { momentAt, nowISO, todayISO } from "./zone";

const STATE: Record<Slot["state"], { label: string; color: string }> = {
  taken: { label: "Taken", color: "var(--success)" },
  late: { label: "Taken late", color: "var(--warning)" },
  skipped: { label: "Skipped", color: "var(--text-muted)" },
  due: { label: "Due now", color: "var(--item-accent)" },
  missed: { label: "Not logged", color: "var(--danger)" },
  upcoming: { label: "Later", color: "var(--text-muted)" },
};

/** "When it was taken" for a dose marked from the checklist: now for
 *  today, the slot's own time for an earlier day (editable in the sheet). */
function defaultTakenAt(day: string, slot: string | null): string {
  const today = todayISO();
  if (day === today) return nowISO();
  return momentAt(day, slot ?? "12:00");
}

const PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

/** A medicine's colour: its own, else a stable one from its id. */
export function medColor(m: Medication): string {
  if (m.color) return m.color;
  let h = 0;
  for (const ch of m.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** The pill badge in a medicine's colour (rows, cards). */
export function MedDot({ med, size = 36 }: { med: Medication; size?: number }) {
  const c = medColor(med);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 16%, transparent)` }}
    >
      <Pill className="h-4 w-4" />
    </span>
  );
}

function partOfDay(t: string): string {
  const h = Number(t.slice(0, 2));
  return h < 5 ? "Night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : h < 21 ? "Evening" : "Night";
}

type Editing = { med: Medication; day: string; slot: string | null; record?: Dose };

/**
 * The dose checklist for a day (default today) — tap ✓ to take, ⏭ to skip,
 * ↺ to undo; tap a row to set the time it was actually taken. ``picker``
 * adds a day switcher so earlier days can be filled in.
 */
export function MedChecklist({
  item,
  day: fixedDay,
  compact,
  picker,
}: {
  item: ItemHandle<HealthData>;
  day?: string;
  compact?: boolean;
  picker?: boolean;
}) {
  const data = item.data;
  const today = todayISO();
  const [pickedDay, setPickedDay] = useState(fixedDay ?? today);
  const day = picker ? pickedDay : (fixedDay ?? today);
  const slots = useMemo(() => slotsFor(data, day), [data, day]);
  const prn = data.medications.filter((m) => isActiveOn(m, day) && isAsNeededOn(m, day) && !(day === today && !m.active));
  const prnDoses = (medId: string) => data.doses.filter((d) => d.med_id === medId && d.day === day && d.slot === null && d.status !== "skipped");
  const left = slots.filter((s) => s.state === "due" || s.state === "missed").length;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [warned, setWarned] = useState<{ med: Medication; at: string; msgs: string[] } | null>(null);

  const take = (med: Medication, slot: string | null, at = defaultTakenAt(day, slot)) => {
    const id = uid("d");
    item.update((d) => markDose(d, med.id, day, slot, "taken", at, id));
  };
  const takePrn = (med: Medication) => {
    const at = defaultTakenAt(day, null);
    const msgs = limitWarnings(data, med, at);
    if (msgs.length) setWarned({ med, at, msgs });
    else take(med, null, at);
  };

  const header = picker ? (
    <div className="flex items-center justify-between gap-2">
      <IconButton label="Previous day" icon={ChevronLeft} onClick={() => setPickedDay(addDays(day, -1))} />
      <label className="flex min-w-0 flex-1 items-center justify-center gap-2 text-sm font-semibold text-[var(--text)]">
        <span className="truncate">{fmtDay(day, { long: true })}</span>
        <input
          type="date"
          aria-label="Pick a day"
          value={day}
          max={today}
          onChange={(e) => e.target.value && e.target.value <= today && setPickedDay(e.target.value)}
          className="h-9 w-9 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface)] text-transparent [color-scheme:light_dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        />
      </label>
      <IconButton label="Next day" icon={ChevronRight} disabled={day >= today} onClick={() => setPickedDay(addDays(day, 1) > today ? today : addDays(day, 1))} />
    </div>
  ) : null;

  if (!slots.length && !prn.length)
    return picker ? (
      <div className="flex flex-col gap-2">
        {header}
        <p className="px-1 text-sm text-[var(--text-muted)]">Nothing was scheduled on this day.</p>
      </div>
    ) : null;

  // Grouped by time like a pill organiser (Medisafe): one header per time,
  // with "Take all" for that time when more than one dose is open there.
  const groups: { time: string; slots: Slot[] }[] = [];
  for (const sl of slots) {
    const g = groups[groups.length - 1];
    if (g && g.time === sl.time) g.slots.push(sl);
    else groups.push({ time: sl.time, slots: [sl] });
  }
  const takeAll = (list: Slot[]) => {
    const todo = list.filter((s) => s.state === "due" || s.state === "missed").map((s) => ({ s, id: uid("d"), at: defaultTakenAt(day, s.time) }));
    item.update((d) => {
      for (const { s, id, at } of todo) markDose(d, s.med.id, s.day, s.time, "taken", at, id);
    });
  };
  const groupHead = (label: ReactNode, open: Slot[]) => (
    <div className="flex min-h-[32px] items-center justify-between gap-2 px-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      {open.length > 1 && item.canEdit && (
        <button
          type="button"
          onClick={() => takeAll(open)}
          className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-[var(--item-accent)] transition hover:bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          <Check className="h-3.5 w-3.5" />
          {day === today ? `Take all ${open.length}` : `Mark all ${open.length} taken`}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {header}
      {picker && day !== today && left > 1 && item.canEdit && groups.length > 1 && (
        <ItemButton size="sm" className="self-end" icon={<Check className="h-3.5 w-3.5" />} onClick={() => takeAll(slots)}>
          Mark all {left} taken
        </ItemButton>
      )}
      {groups.map((g) => {
        const open = g.slots.filter((s) => s.state === "due" || s.state === "missed");
        return (
          <div key={g.time} className="flex flex-col gap-1">
            {groupHead(
              <>
                <span className="tabular-nums text-[var(--text)]">{g.time}</span> · {partOfDay(g.time)}
              </>,
              open,
            )}
            <List>
              {g.slots.map((s) => {
                const st = STATE[s.state];
                const done = s.state === "taken" || s.state === "late" || s.state === "skipped";
                const food = FOOD_LABEL[s.med.with_food];
                return (
                  <ListRow
                    key={`${s.med.id}-${s.time}`}
                    className={cn(done && "opacity-70")}
                    onClick={item.canEdit ? () => setEditing({ med: s.med, day, slot: s.time, record: s.record }) : undefined}
                    leading={<MedDot med={s.med} />}
                    title={
                      <span className={cn(s.state === "skipped" && "line-through")}>
                        {s.med.name}
                        {s.dose && <span className="font-normal text-[var(--text-muted)]"> · {s.dose}</span>}
                      </span>
                    }
                    subtitle={
                      <span className="flex items-center gap-1.5">
                        <Badge color={st.color}>{st.label}</Badge>
                        {s.record?.at && s.state !== "skipped" && <span className="tabular-nums">at {s.record.at.slice(11, 16)}</span>}
                        {!compact && food && !done && <span className="truncate">{food}</span>}
                      </span>
                    }
                    action={
                      item.canEdit &&
                      (done ? (
                        <span className="pr-1">
                          <IconButton label={`Undo ${s.med.name} ${s.time}`} icon={RotateCcw} onClick={() => item.update((d) => markDose(d, s.med.id, s.day, s.time, null, nowISO()))} />
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 pr-2">
                          <IconButton label={`Skip ${s.med.name} ${s.time}`} icon={SkipForward} onClick={() => item.update((d) => markDose(d, s.med.id, s.day, s.time, "skipped", nowISO()))} />
                          <button
                            type="button"
                            aria-label={`Take ${s.med.name} ${s.time}`}
                            onClick={() => take(s.med, s.time)}
                            className={cn(
                              "flex h-11 w-11 items-center justify-center rounded-full border-2 transition active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                              s.state === "due" || s.state === "missed"
                                ? "border-[var(--item-accent)] text-[var(--item-accent)] hover:bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]"
                                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                            )}
                          >
                            <Check className="h-5 w-5" />
                          </button>
                        </span>
                      ))
                    }
                  />
                );
              })}
            </List>
          </div>
        );
      })}
      {prn.length > 0 && (
        <div className="flex flex-col gap-1">
          {groupHead("As needed", [])}
          <List>
            {prn.map((m) => {
              const taken = prnDoses(m.id);
              const lim = [m.max_per_day ? `max ${m.max_per_day}/day` : "", m.min_hours_between ? `${m.min_hours_between} h apart` : ""].filter(Boolean).join(" · ");
              const over = m.max_per_day ? taken.length >= m.max_per_day : false;
              const lastAt = (taken.map((x) => x.at ?? "").sort().slice(-1)[0] || "").slice(11, 16);
              return (
                <ListRow
                  key={m.id}
                  onClick={item.canEdit ? () => setEditing({ med: m, day, slot: null }) : undefined}
                  leading={<MedDot med={m} />}
                  title={
                    <span>
                      {m.name}
                      {slotDose(m, day, null) && <span className="font-normal text-[var(--text-muted)]"> · {slotDose(m, day, null)}</span>}
                    </span>
                  }
                  subtitle={
                    <span className={cn(over && "text-[var(--warning)]")}>
                      {taken.length ? `${taken.length}× ${day === today ? "today" : "that day"}${lastAt ? ` · last ${lastAt}` : ""}` : lim || "As needed"}
                    </span>
                  }
                  action={
                    item.canEdit && (
                      <span className="pr-2">
                        <ItemButton size="sm" onClick={() => takePrn(m)}>
                          {day === today ? "Take now" : "Add dose"}
                        </ItemButton>
                      </span>
                    )
                  }
                />
              );
            })}
          </List>
        </div>
      )}
      {warned && (
        <Sheet
          open
          size="sm"
          onClose={() => setWarned(null)}
          title={`Take ${warned.med.name}?`}
          footer={
            <>
              <ItemButton onClick={() => setWarned(null)}>Don't log</ItemButton>
              <ItemButton
                variant="primary"
                block
                onClick={() => {
                  take(warned.med, null, warned.at);
                  setWarned(null);
                }}
              >
                Log it anyway
              </ItemButton>
            </>
          }
        >
          <Callout tone="warning" title="Past your limit">
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {warned.msgs.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        </Sheet>
      )}
      {editing && <DoseSheet item={item} editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** One dose: taken / skipped and the actual time taken (or, for an
 *  as-needed medicine, the day's doses with their times). */
function DoseSheet({ item, editing, onClose }: { item: ItemHandle<HealthData>; editing: Editing; onClose: () => void }) {
  const { med, day, slot } = editing;
  const rec = slot !== null ? item.data.doses.find((d) => d.med_id === med.id && d.day === day && d.slot === slot) : undefined;
  const [status, setStatus] = useState<"taken" | "skipped">(rec?.status === "skipped" ? "skipped" : "taken");
  const [time, setTime] = useState((rec?.at ?? defaultTakenAt(day, slot)).slice(11, 16));
  const prnRows = slot === null ? item.data.doses.filter((d) => d.med_id === med.id && d.day === day && d.slot === null) : [];
  const atISO = momentAt(day, time || "12:00");
  const warnings = status === "taken" && (slot === null || !rec || rec.status === "skipped") ? limitWarnings(item.data, med, atISO) : [];
  const future = new Date(atISO).getTime() > Date.now() + 60_000;

  const save = () => {
    const id = uid("d");
    item.update((d) => {
      if (slot === null) {
        markDose(d, med.id, day, null, "taken", atISO, id);
        return;
      }
      if (status === "skipped") markDose(d, med.id, day, slot, "skipped", atISO, id);
      else {
        // Re-mark with the time given (markDose decides on time vs late).
        const cur = d.doses.find((x) => x.med_id === med.id && x.day === day && x.slot === slot);
        if (cur && cur.status !== "skipped") {
          cur.at = atISO;
          cur.status = new Date(atISO).getTime() - new Date(momentAt(day, slot)).getTime() > 3600_000 ? "late" : "taken";
        } else markDose(d, med.id, day, slot, "taken", atISO, id);
      }
    });
    onClose();
  };

  return (
    <Sheet
      open
      size="sm"
      onClose={onClose}
      title={`${med.name}${slot ? ` · ${slot}` : ""}`}
      footer={
        <>
          {rec && (
            <ItemButton
              variant="ghost"
              icon={<RotateCcw className="h-4 w-4" />}
              onClick={() => {
                item.update((d) => markDose(d, med.id, day, slot, null, nowISO()));
                onClose();
              }}
            >
              Clear
            </ItemButton>
          )}
          <ItemButton variant="primary" block disabled={future || !time} onClick={save}>
            {slot === null ? "Add dose" : "Save"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          {fmtDay(day, { long: true })}
          {slotDose(med, day, slot) ? ` · ${slotDose(med, day, slot)}` : ""}
        </p>
        {slot !== null && (
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: "taken", label: "Taken" },
              { value: "skipped", label: "Skipped" },
            ]}
          />
        )}
        {status === "taken" && (
          <Field label="Time taken" hint={future ? "That's in the future" : undefined}>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-[var(--text-muted)]" />
              <input
                type="time"
                aria-label="Time taken"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base tabular-nums text-[var(--text)] outline-none focus:border-[var(--item-accent)] md:h-10 md:text-sm"
              />
            </div>
          </Field>
        )}
        {warnings.length > 0 && (
          <Callout tone="warning" title={<span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Past your limit</span>}>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}
        {slot === null && prnRows.length > 0 && (
          <Field label="Logged that day">
            <List>
              {prnRows.map((r) => (
                <ListRow
                  key={r.id}
                  title={r.at ? r.at.slice(11, 16) : "No time"}
                  subtitle={r.status === "skipped" ? "Skipped" : "Taken"}
                  action={
                    <span className="pr-2">
                      <IconButton label="Remove this dose" icon={RotateCcw} onClick={() => item.update((d) => removeDose(d, r.id))} />
                    </span>
                  }
                />
              ))}
            </List>
          </Field>
        )}
      </div>
    </Sheet>
  );
}
