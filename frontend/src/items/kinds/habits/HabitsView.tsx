import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, ArrowDownUp, Bell, GripVertical, ListChecks, Plus, Settings2, Sparkles, X } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { ItemViewProps } from "@/items/types";
import { Chip, EmptyState, Fab, IconButton, ItemButton, Page, ProgressRing, ScrollRow, Section, Select, Sheet, TextInput, Toggle } from "@/items/ui";
import { cn } from "@/utils/cn";

import { WEEKDAY_NAMES, describeGoal, describeSchedule, dn, habitStats } from "./engine";
import { useHabitTools, useToday, useWidth } from "./hooks";
import { DataSheet } from "./DataSheet";
import { HabitBadge, StreakBadge } from "./parts";
import type { Habit, HabitSettings, HabitsData } from "./types";
import { TIMES } from "./util";
import { HistoryHead, HistoryStrip } from "./viz";

export function HabitsView({ item, isPhone, ask }: ItemViewProps<HabitsData>) {
  const data = item.data;
  const today = useToday(data.settings.day_ends_at);
  const tools = useHabitTools(item, today, ask);
  const [area, setArea] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [dataOpen, setDataOpen] = useState(false);
  const closeData = useCallback(() => setDataOpen(false), []);
  const t = dn(today);
  const ws = data.settings.week_start;
  // Wide enough for a row per habit with its last 7 days (Loop / Habitify).
  const [wrapRef, width] = useWidth();
  const wide = !isPhone && width >= 680;

  const active = data.habits.filter((h) => !h.archived);
  const archived = data.habits.filter((h) => h.archived);
  const areas = useMemo(() => Array.from(new Set(active.map((h) => h.area).filter(Boolean))), [active]);
  const shown = area ? active.filter((h) => h.area === area) : active;
  // Habits started in the last three weeks: more than three new at once is a lot.
  const newCount = active.filter((h) => h.start_date && dn(h.start_date) > t - 21).length;
  const stats = useMemo(() => new Map(data.habits.map((h) => [h.id, habitStats(h, t, ws)])), [data.habits, t, ws]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    const { active: a, over } = e;
    if (!over || a.id === over.id) return;
    item.update((d) => {
      const from = d.habits.findIndex((h) => h.id === a.id);
      const to = d.habits.findIndex((h) => h.id === over.id);
      if (from >= 0 && to >= 0) d.habits = arrayMove(d.habits, from, to);
    });
  };

  return (
    <Page wide={!isPhone}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">Your habits</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {active.length} active{archived.length ? ` · ${archived.length} archived` : ""} {active.length > 1 && item.canEdit ? "· drag to reorder" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Import & export" icon={ArrowDownUp} onClick={() => setDataOpen(true)} />
          <IconButton label="Settings" icon={Settings2} onClick={() => setSettingsOpen(true)} />
          {item.canEdit && !isPhone && (
            <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={tools.openNew}>
              New habit
            </ItemButton>
          )}
        </div>
      </div>

      {item.canEdit && newCount >= 4 && (
        <div className="flex items-start gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_9%,transparent)] p-3 text-sm text-[var(--text)]">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--item-accent)]" />
          <span className="min-w-0 flex-1">
            Several new habits at once is hard — most people do best adding 1–3 at a time.{" "}
            <button type="button" className="font-medium text-[var(--item-accent)] underline-offset-2 hover:underline" onClick={() => ask("I have a lot of new habits. Help me pick the 1–3 to focus on now and pause the rest.")}>
              Help me focus
            </button>
          </span>
        </div>
      )}

      {areas.length > 1 && (
        <ScrollRow>
          <Chip active={area === null} onClick={() => setArea(null)}>
            All
          </Chip>
          {areas.map((a) => (
            <Chip key={a} active={area === a} onClick={() => setArea(area === a ? null : a)}>
              {a}
            </Chip>
          ))}
        </ScrollRow>
      )}

      {active.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No active habits"
          text="Add a habit, or ask the coach to turn a goal into one or two tiny, anchored habits."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {item.canEdit && (
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={tools.openNew}>
                  New habit
                </ItemButton>
              )}
              <ItemButton icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask("I want to build better habits. Ask me about my goals, then set up 1–3 tiny habits.")}>
                Ask the coach
              </ItemButton>
              {item.canEdit && (
                <ItemButton variant="ghost" icon={<ArrowDownUp className="h-4 w-4" />} onClick={() => setDataOpen(true)}>
                  Import from Loop or CSV
                </ItemButton>
              )}
            </div>
          }
        />
      ) : (
        <div ref={wrapRef} className="min-w-0">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown.map((h) => h.id)} strategy={verticalListSortingStrategy}>
              {wide && (
                <div className="flex items-end gap-2 pb-1.5 pl-1 pr-2 text-[11px] font-medium text-[var(--text-muted)]">
                  <span className="min-w-0 flex-1 pl-12">Habit</span>
                  <HistoryHead today={today} />
                  <span className="w-14 text-right">Strength</span>
                  {item.canEdit && <span className="w-10" />}
                </div>
              )}
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label="Habits">
                {shown.map((h) => {
                  const st = stats.get(h.id);
                  return (
                    <SortableHabit
                      key={h.id}
                      habit={h}
                      stats={st}
                      canEdit={item.canEdit}
                      wide={wide}
                      phone={isPhone}
                      onOpen={() => tools.openEdit(h)}
                      onArchive={() => tools.archive(h)}
                      strip={wide && st ? <HistoryStrip habit={h} logs={st.logs} today={today} weekStart={ws} onOpenDay={item.canEdit ? (d) => tools.openLog(h.id, d) : undefined} /> : undefined}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      )}

      {archived.length > 0 && (
        <Section title="Archived" hint="Hidden from Today; history kept.">
          <ul className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {archived.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                <HabitBadge habit={h} size={32} />
                <button type="button" onClick={() => tools.openEdit(h)} className="min-w-0 flex-1 truncate text-left text-sm text-[var(--text-muted)]">
                  {h.name}
                </button>
                {item.canEdit && <IconButton label={`Restore ${h.name}`} icon={ArchiveRestore} onClick={() => tools.archive(h)} />}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {isPhone && item.canEdit && (
        <>
          {/* Room so the last row clears the floating button. */}
          <div className="h-16" aria-hidden />
          <Fab label="Habit" icon={Plus} onClick={tools.openNew} />
        </>
      )}
      <SettingsSheet open={settingsOpen} onClose={closeSettings} data={data} item={item} />
      <DataSheet open={dataOpen} onClose={closeData} item={item} onDone={(text) => tools.say(text)} />
      {tools.element}
    </Page>
  );
}

function SortableHabit({
  habit: h,
  stats,
  canEdit,
  wide,
  phone,
  strip,
  onOpen,
  onArchive,
}: {
  habit: Habit;
  stats: ReturnType<typeof habitStats> | undefined;
  canEdit: boolean;
  wide?: boolean;
  /** Phone: archive lives in the editor; the row keeps its width for the name. */
  phone?: boolean;
  strip?: ReactNode;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: h.id, disabled: !canEdit });
  const tod = TIMES.find((x) => x.id === h.time_of_day)?.label;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-2 pl-1 pr-2 shadow-[var(--shadow-sm)]",
        isDragging && "relative z-10 shadow-[var(--shadow-lg)] ring-2 ring-[var(--item-accent)]",
      )}
    >
      {canEdit && (
        <button
          type="button"
          aria-label={`Reorder ${h.name}`}
          {...attributes}
          {...listeners}
          className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <button type="button" onClick={onOpen} className="flex min-h-[48px] min-w-0 flex-1 items-center gap-3 rounded-xl px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]">
        <HabitBadge habit={h} size={40} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-medium text-[var(--text)]">{h.name}</span>
            {stats && <StreakBadge n={stats.current} unit={stats.unit} hot={stats.current >= 7} />}
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">
            {[describeGoal(h), describeSchedule(h), tod, h.area].filter(Boolean).join(" · ")}
            {h.reminders.length ? " · " : ""}
            {h.reminders.length ? <Bell className="mb-0.5 inline h-3 w-3" aria-label="Has reminders" /> : null}
          </span>
        </span>
        {stats && !wide && (
          <span className="shrink-0" title="Habit strength (0–100)">
            <ProgressRing value={stats.score} size={36} stroke={3.5} color={h.color}>
              <span className="text-[11px] tabular-nums">{Math.round(stats.score * 100)}</span>
            </ProgressRing>
            <span className="sr-only">strength</span>
          </span>
        )}
      </button>
      {strip}
      {stats && wide && (
        <span className="flex w-14 shrink-0 items-center justify-end gap-1.5" title="Habit strength (0–100)">
          <span className="relative h-1.5 w-6 overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden>
            <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(stats.score * 100)}%`, background: h.color }} />
          </span>
          <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{Math.round(stats.score * 100)}</span>
        </span>
      )}
      {canEdit && !phone && <IconButton label={`Archive ${h.name}`} icon={Archive} onClick={onArchive} />}
    </li>
  );
}

function SettingsSheet({ open, onClose, data, item }: { open: boolean; onClose: () => void; data: HabitsData; item: ItemViewProps<HabitsData>["item"] }) {
  const s = data.settings;
  const [newArea, setNewArea] = useState("");
  const set = <K extends keyof HabitSettings>(k: K, v: HabitSettings[K]) =>
    item.update((d) => {
      d.settings[k] = v;
    });
  const ro = !item.canEdit;
  return (
    <Sheet open={open} onClose={onClose} title="Habit settings">
      <div className="flex flex-col gap-5 pt-1">
        <Row label="The day ends at" hint="Late nights still count for the day before.">
          <Select value={s.day_ends_at} disabled={ro} onChange={(e) => set("day_ends_at", Number(e.target.value))} className="!w-36" aria-label="The day ends at">
            {[0, 1, 2, 3, 4, 5, 6].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? "Midnight" : `${h}:00 am`}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Week starts on">
          <Select value={s.week_start} disabled={ro} onChange={(e) => set("week_start", Number(e.target.value))} className="!w-36" aria-label="Week starts on">
            {[0, 6, 5].map((d) => (
              <option key={d} value={d}>
                {WEEKDAY_NAMES[d]}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Reminders" hint="Each habit's own reminder times, only while it's still to do.">
          <Toggle checked={s.reminders_on} onChange={(v) => !ro && set("reminders_on", v)} label="Reminders" />
        </Row>
        <Row label="Evening “still to do”" hint="One nudge listing what's left.">
          <div className="flex items-center gap-2">
            {s.evening_summary && (
              <TextInput type="time" value={s.evening_time} disabled={ro} onChange={(e) => e.target.value && set("evening_time", e.target.value)} className="!w-28" aria-label="Evening summary time" />
            )}
            <Toggle checked={s.evening_summary} onChange={(v) => !ro && set("evening_summary", v)} label="Evening summary" />
          </div>
        </Row>
        <Row label="Weekly review reminder">
          <Toggle checked={s.review_reminder} onChange={(v) => !ro && set("review_reminder", v)} label="Weekly review reminder" />
        </Row>
        {s.review_reminder && (
          <div className="flex gap-2">
            <Select value={s.review_weekday} disabled={ro} onChange={(e) => set("review_weekday", Number(e.target.value))} aria-label="Review day">
              {WEEKDAY_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </Select>
            <TextInput type="time" value={s.review_time} disabled={ro} onChange={(e) => e.target.value && set("review_time", e.target.value)} className="!w-32" aria-label="Review time" />
          </div>
        )}
        <Row label="Celebrations" hint="Animations and haptics when you check off.">
          <Toggle checked={s.celebrate} onChange={(v) => !ro && set("celebrate", v)} label="Celebrations" />
        </Row>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-[var(--text)]">Areas</span>
          <div className="flex flex-wrap gap-2">
            {s.areas.map((a) => (
              <Chip key={a} icon={!ro ? <X className="h-3 w-3" /> : undefined} onClick={ro ? undefined : () => set("areas", s.areas.filter((x) => x !== a))}>
                {a}
              </Chip>
            ))}
          </div>
          {!ro && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newArea.trim().slice(0, 40);
                if (v && !s.areas.includes(v) && s.areas.length < 24) set("areas", [...s.areas, v]);
                setNewArea("");
              }}
            >
              <TextInput value={newArea} onChange={(e) => setNewArea(e.target.value)} placeholder="Add an area" aria-label="New area" />
              <ItemButton type="submit" disabled={!newArea.trim()}>
                Add
              </ItemButton>
            </form>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]">{label}</p>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
