import { CalendarRange, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { EmptyState, Fab, IconButton, Page, fmtDay, parseDay, todayISO } from "@/items/ui";

import { buckets } from "./logic";
import { AddSheet, Fold, QuickAdd, SectionHead, TaskGroup, TaskRow, useQuickAddRequest, useToggle } from "./parts";
import { plusDays } from "./recur";
import { TaskEditor } from "./TaskEditor";
import type { Task, TasksData } from "./types";

const DAYS = 14;
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/* Upcoming: the next two weeks day by day (empty days stay, so you can drop
 * something on them), then later by month, then tasks with no date. */
export function UpcomingView({ item, isPhone }: ItemViewProps<TasksData>) {
  const today = todayISO();
  const data = item.data;
  const [open, setOpen] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<string | null | undefined>(undefined);
  const [inlineDay, setInlineDay] = useState<string | null>(null);
  const toggle = useToggle(item);
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
  const row = (t: Task, showDue = false) => <TaskRow key={t.id} task={t} data={data} onToggle={() => toggle(t)} onOpen={() => setOpen(t.id)} canEdit={item.canEdit} showDue={showDue} />;
  const days = Array.from({ length: DAYS + 1 }, (_, i) => plusDays(today, i));
  const empty = !b.today.length && !b.upcoming.length && !b.later.length && !b.someday.length;

  return (
    <Page>
      <h1 className="text-xl font-semibold text-[var(--text)]">Upcoming</h1>
      {item.canEdit && !isPhone && <QuickAdd item={item} placeholder="Add a task — “Dentist Thu 10am”, “Pay rent every month on the 1st”" />}
      {empty && <EmptyState icon={CalendarRange} title="Nothing coming up" text="Tasks with a date show here, day by day." />}
      {days.map((day) => {
        const list = byDay.get(day) ?? [];
        const weekend = parseDay(day).getDay() % 6 === 0;
        return (
          <section key={day} className="flex flex-col gap-1.5">
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
                    className="h-8 w-8"
                  />
                )
              }
            />
            {inlineDay === day && <QuickAdd item={item} due={day} autoFocus placeholder={`Add for ${fmtDay(day)}`} />}
            {list.length > 0 ? (
              <TaskGroup>{list.map((t) => row(t))}</TaskGroup>
            ) : (
              <div className={`h-px ${weekend ? "bg-[color-mix(in_srgb,var(--border)_60%,transparent)]" : "bg-[var(--border)]"} mx-1`} aria-hidden />
            )}
          </section>
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
      {isPhone && item.canEdit && <Fab label="Add" icon={Plus} onClick={() => setAddFor(null)} />}
      <AddSheet item={item} open={addFor !== undefined} onClose={() => setAddFor(undefined)} due={addFor ?? null} />
      <TaskEditor item={item} taskId={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
