import { CalendarCheck, Plus, Sparkles, Sun } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { EmptyState, Fab, ItemButton, Page, ProgressRing, parseDay, todayISO } from "@/items/ui";

import { buckets, doneOn, sortKey } from "./logic";
import { AddSheet, Fold, QuickAdd, SectionHead, TaskGroup, TaskRow, useQuickAddRequest, useToggle } from "./parts";
import { moveMany, useReschedule } from "./reschedule";
import { TaskEditor } from "./TaskEditor";
import type { TasksData } from "./types";

/* Today: what's overdue, what's due today (timed first), and what's been
 * done today. Adding here makes it due today. */
export function TodayView({ item, isPhone, ask }: ItemViewProps<TasksData>) {
  const today = todayISO();
  const data = item.data;
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const toggle = useToggle(item);
  const move = useReschedule(item);
  const b = useMemo(() => buckets(data.tasks, today), [data.tasks, today]);
  const done = useMemo(() => doneOn(data, today), [data, today]);
  const doneTasks = useMemo(() => data.tasks.filter((t) => t.done && t.done_at?.slice(0, 10) === today).sort(sortKey), [data.tasks, today]);
  const total = b.today.length + b.overdue.length + done.length;
  useQuickAddRequest(() => (isPhone ? setAdding(true) : document.querySelector<HTMLInputElement>("[aria-label='New task']")?.focus()));
  const row = (t: (typeof b.today)[number], showDue = false) => (
    <TaskRow key={t.id} task={t} data={data} onToggle={() => toggle(t)} onOpen={() => setOpen(t.id)} canEdit={item.canEdit} showDue={showDue} onReschedule={(due) => move(t, due)} />
  );

  return (
    <Page className="tasks-scope">
      <header className="flex items-center gap-4">
        <ProgressRing value={total ? done.length / total : 0} size={56}>
          {done.length}/{total}
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-[var(--text)]">Today</h1>
          <p className="text-sm text-[var(--text-muted)]">{parseDay(today).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
        </div>
        {(b.today.length + b.overdue.length > 2) && (
          <ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Plan my day: put today's and overdue tasks in a sensible order and tell me what to push if it's too much.")}>
            Plan my day
          </ItemButton>
        )}
      </header>

      {item.canEdit && !isPhone && <QuickAdd item={item} due={today} placeholder="Add a task for today — or “… tomorrow 3pm”, “… every Mon”" />}

      {b.overdue.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHead
            title={`Overdue · ${b.overdue.length}`}
            tone="danger"
            action={
              item.canEdit && (
                <ItemButton
                  size="sm"
                  variant="ghost"
                  onClick={() => moveMany(item, b.overdue, today)}
                >
                  Move all to today
                </ItemButton>
              )
            }
          />
          <TaskGroup>{b.overdue.map((t) => row(t, true))}</TaskGroup>
        </section>
      )}

      <section className="flex flex-col gap-2">
        {b.overdue.length > 0 && <SectionHead title={`Today · ${b.today.length}`} tone="accent" />}
        {b.today.length ? (
          <TaskGroup>{b.today.map((t) => row(t))}</TaskGroup>
        ) : (
          <EmptyState
            icon={b.overdue.length || done.length ? CalendarCheck : Sun}
            title={done.length ? "All done for today" : "Nothing due today"}
            text={done.length ? `${done.length} ticked off. Enjoy the rest of the day.` : isPhone ? "Tap Add, or pull a task in from Upcoming." : "Type one in the box above, or pull a task in from Upcoming."}
            action={
              item.canEdit &&
              (isPhone ? (
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                  Add a task
                </ItemButton>
              ) : b.upcoming.length ? (
                <ItemButton onClick={() => ask("Look at my upcoming tasks and suggest one or two I could get ahead on today.")}>What could I get ahead on?</ItemButton>
              ) : null)
            }
          />
        )}
      </section>

      {done.length > 0 && (
        <Fold title="Done today" count={done.length}>
          <TaskGroup>
            {doneTasks.map((t) => row(t))}
            {done
              .filter((x) => !doneTasks.some((t) => t.id === x.task_id))
              .map((x) => (
                <div key={x.id} className="flex min-h-[44px] items-center gap-3 px-4 py-2 text-sm text-[var(--text-muted)] line-through">
                  {x.title}
                </div>
              ))}
          </TaskGroup>
        </Fold>
      )}

      {isPhone && item.canEdit && <Fab label="Add" icon={Plus} onClick={() => setAdding(true)} />}
      <AddSheet item={item} open={adding} onClose={() => setAdding(false)} due={today} />
      <TaskEditor item={item} taskId={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
