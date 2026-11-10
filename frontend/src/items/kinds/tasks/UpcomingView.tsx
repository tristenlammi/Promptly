import { DndContext, DragOverlay, MouseSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CalendarRange, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { ItemViewProps } from "@/items/types";
import { EmptyState, Fab, IconButton, Page, fmtDay, parseDay, todayISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { buckets } from "./logic";
import { AddSheet, Fold, QuickAdd, SectionHead, TaskGroup, TaskRow, useQuickAddRequest, useToggle } from "./parts";
import { plusDays } from "./recur";
import { useReschedule } from "./reschedule";
import { TaskEditor } from "./TaskEditor";
import type { Task, TasksData } from "./types";

const DAYS = 14;
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** A day you can drop a task on (with a mouse; phones swipe a row left). */
function DayDrop({ day, children }: { day: string; children: ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `day:${day}` });
  const from = (active?.data.current as { due?: string | null } | undefined)?.due;
  return (
    <section ref={setNodeRef} className={cn("tasks-drop flex flex-col gap-1.5", isOver && from !== day && "is-over")}>
      {children}
    </section>
  );
}

/** Hold a row with the mouse and carry it to another day. No keyboard
 *  handles here on purpose: the row's own button and the T key move it. */
function DragToDay({ task, enabled, children }: { task: Task; enabled: boolean; children: ReactNode }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: task.id, data: { due: task.due }, disabled: !enabled });
  return (
    <div ref={setNodeRef} {...(enabled ? listeners : undefined)} className={cn(isDragging && "opacity-40")}>
      {children}
    </div>
  );
}

/* Upcoming: the next two weeks day by day (empty days stay, so you can drop
 * something on them), then later by month, then tasks with no date. */
export function UpcomingView({ item, isPhone }: ItemViewProps<TasksData>) {
  const today = todayISO();
  const data = item.data;
  const [open, setOpen] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<string | null | undefined>(undefined);
  const [inlineDay, setInlineDay] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const toggle = useToggle(item);
  const move = useReschedule(item);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));
  const b = useMemo(() => buckets(data.tasks, today, DAYS), [data.tasks, today]);
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of [...b.today, ...b.upcoming]) m.set(t.due!, [...(m.get(t.due!) ?? []), t]);
    return m;
  }, [b]);
  const byMonth = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of b.later) m.set(t.due!.slice(0, 7), [...(m.get(t.due!.slice(0, 7)) ?? []), t]);
    return m;
  }, [b]);
  useQuickAddRequest(() => (isPhone ? setAddFor(null) : document.querySelector<HTMLInputElement>("[aria-label='New task']")?.focus()));
  const canDrag = item.canEdit && !isPhone;
  const row = (t: Task, showDue = false) => (
    <DragToDay key={t.id} task={t} enabled={canDrag && !t.done}>
      <TaskRow task={t} data={data} onToggle={() => toggle(t)} onOpen={() => setOpen(t.id)} canEdit={item.canEdit} showDue={showDue} onReschedule={(due) => move(t, due)} />
    </DragToDay>
  );
  const days = Array.from({ length: DAYS + 1 }, (_, i) => plusDays(today, i));
  const empty = !b.today.length && !b.upcoming.length && !b.later.length && !b.someday.length;
  const dragged = dragId ? data.tasks.find((t) => t.id === dragId) : undefined;

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const over = e.over ? String(e.over.id) : "";
    if (!over.startsWith("day:")) return;
    const t = data.tasks.find((x) => x.id === e.active.id);
    if (t) move(t, over.slice(4));
  };

  return (
    <Page className="tasks-scope">
      <h1 className="text-xl font-semibold text-[var(--text)]">Upcoming</h1>
      {item.canEdit && !isPhone && <QuickAdd item={item} placeholder="Add a task — “Dentist Thu 10am”, “Pay rent every month on the 1st”" />}
      {empty && <EmptyState icon={CalendarRange} title="Nothing coming up" text="Tasks with a date show here, day by day." />}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={(e) => setDragId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
        {days.map((day) => {
          const list = byDay.get(day) ?? [];
          const weekend = parseDay(day).getDay() % 6 === 0;
          return (
            <DayDrop key={day} day={day}>
              <SectionHead
                title={
                  <span>
                    {fmtDay(day)}
                    {day === today || day === plusDays(today, 1) ? <span className="ml-1.5 font-normal text-[var(--text-muted)]">{parseDay(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span> : null}
                  </span>
                }
                tone={day === today ? "accent" : undefined}
                action={
                  item.canEdit && (
                    <IconButton
                      label={`Add a task on ${fmtDay(day)}`}
                      icon={Plus}
                      onClick={() => (isPhone ? setAddFor(day) : setInlineDay(inlineDay === day ? null : day))}
                      className="h-10 w-10 md:h-8 md:w-8"
                    />
                  )
                }
              />
              {inlineDay === day && <QuickAdd item={item} due={day} autoFocus placeholder={`Add for ${fmtDay(day)}`} />}
              {list.length > 0 ? (
                <TaskGroup>{list.map((t) => row(t))}</TaskGroup>
              ) : (
                <div className={cn("mx-1 h-px", weekend ? "bg-[color-mix(in_srgb,var(--border)_60%,transparent)]" : "bg-[var(--border)]", dragId && "my-3")} aria-hidden />
              )}
            </DayDrop>
          );
        })}
        {[...byMonth.entries()].map(([ym, list]) => (
          <section key={ym} className="flex flex-col gap-1.5">
            <SectionHead title={monthFmt.format(parseDay(`${ym}-01`))} hint={`${list.length} task${list.length === 1 ? "" : "s"}`} />
            <TaskGroup>{list.map((t) => row(t, true))}</TaskGroup>
          </section>
        ))}
        {b.someday.length > 0 && (
          <Fold title="No date" count={b.someday.length}>
            <TaskGroup>{b.someday.map((t) => row(t, true))}</TaskGroup>
          </Fold>
        )}
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <div className="tasks-ghost rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text)] shadow-[var(--shadow-lg)]">
              <span className="line-clamp-2">{dragged.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {isPhone && item.canEdit && <Fab label="Add" icon={Plus} onClick={() => setAddFor(null)} />}
      <AddSheet item={item} open={addFor !== undefined} onClose={() => setAddFor(undefined)} due={addFor ?? null} />
      <TaskEditor item={item} taskId={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
