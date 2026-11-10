import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, CheckCheck, Flag, GripVertical, Inbox, ListPlus, Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { confirm } from "@/components/shared/ConfirmDialog";
import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { EmptyState, Fab, Field, IconButton, ItemButton, Page, Sheet, TextInput, fmtTime, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { LIST_COLORS, orderKey, reopenChange, sortKey } from "./logic";
import { AddSheet, Fold, QuickAdd, TaskGroup, TaskRow, useQuickAddRequest, useToggle } from "./parts";
import { plusDays } from "./recur";
import { useReschedule } from "./reschedule";
import { TaskEditor } from "./TaskEditor";
import { INBOX, type Done, type Task, type TaskList, type TasksData } from "./types";

/* Lists: every list with its open count (plus High priority and Completed),
 * one list's tasks in your own order (drag to sort), and search. Phone:
 * index → list. Desktop: the two side by side. */

type Sel = string | "@high" | "@done";

export function ListsView({ item, isPhone }: ItemViewProps<TasksData>) {
  const data = item.data;
  const [params, setParams] = useSearchParams();
  const wanted = params.get("list");
  // A deep link can name a list (?list=<id>, e.g. Meal Planner's "Open
  // Tasks" after sending the grocery list) — open it straight away.
  const [sel, setSel] = useState<Sel | null>(() => (wanted && item.data.lists.some((l) => l.id === wanted) ? wanted : isPhone ? null : INBOX));
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editList, setEditList] = useState<TaskList | "new" | null>(null);
  const toggle = useToggle(item);
  const move = useReschedule(item);
  // Select + scroll to the linked list once it's in the data, then drop the
  // param so it doesn't pin the selection on later visits.
  useEffect(() => {
    if (!wanted || !data.lists.some((l) => l.id === wanted)) return;
    setSel(wanted);
    const p = new URLSearchParams(window.location.search);
    p.delete("list");
    setParams(p, { replace: true });
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-list-id="${window.CSS.escape(wanted)}"]`)?.scrollIntoView({ block: "nearest" });
      if (isPhone) window.scrollTo({ top: 0 });
    });
  }, [wanted, data.lists, setParams, isPhone]);
  useQuickAddRequest(() => (isPhone ? setAdding(true) : document.querySelector<HTMLInputElement>("[aria-label='New task']")?.focus()));

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of data.tasks) if (!t.done) c[t.list_id] = (c[t.list_id] ?? 0) + 1;
    return c;
  }, [data.tasks]);
  const high = useMemo(() => data.tasks.filter((t) => !t.done && t.priority === 3).sort(sortKey), [data.tasks]);
  const lists = useMemo(() => [...data.lists].sort((a, b) => (a.id === INBOX ? -1 : b.id === INBOX ? 1 : a.order - b.order)), [data.lists]);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!q.length) return null;
    return data.tasks
      .filter((t) => {
        const hay = `${t.title} ${t.notes} ${t.tags.join(" ")}`.toLowerCase();
        return q.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(a.done) - Number(b.done) || sortKey(a, b))
      .slice(0, 100);
  }, [query, data.tasks]);

  const row = (t: Task, showList = true) => <TaskRow key={t.id} task={t} data={data} onToggle={() => toggle(t)} onOpen={() => setOpen(t.id)} canEdit={item.canEdit} showList={showList} onReschedule={(due) => move(t, due)} />;

  const index = (
    <nav className="flex flex-col gap-4" aria-label="Lists">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" className="pl-9" type="search" />
      </div>
      <div className="flex flex-col gap-0.5">
        <NavRow icon={<Flag className="h-4 w-4 text-[#DB4C3F]" />} name="High priority" count={high.length} active={sel === "@high"} onClick={() => setSel("@high")} />
        <NavRow icon={<CheckCheck className="h-4 w-4 text-[var(--success)]" />} name="Completed" active={sel === "@done"} onClick={() => setSel("@done")} />
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">My lists</span>
          {item.canEdit && <IconButton label="New list" icon={ListPlus} onClick={() => setEditList("new")} className="h-10 w-10 md:h-8 md:w-8" />}
        </div>
        {lists.map((l) => (
          <NavRow
            key={l.id}
            icon={l.id === INBOX ? <Inbox className="h-4 w-4" style={{ color: l.color }} /> : l.emoji ? <span className="w-4 text-center text-sm">{l.emoji}</span> : <span className="mx-1 h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />}
            name={l.name}
            count={counts[l.id] ?? 0}
            active={sel === l.id}
            onClick={() => setSel(l.id)}
            listId={l.id}
          />
        ))}
      </div>
    </nav>
  );

  const searchResults = hits && (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold text-[var(--text)]">{hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"}` : "No matches"}</h2>
      {hits.length > 0 && <TaskGroup>{hits.map((t) => row(t))}</TaskGroup>}
    </section>
  );

  const detail =
    sel === null ? null : sel === "@high" ? (
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-[var(--text)]">High priority</h1>
        {high.length ? <TaskGroup>{high.map((t) => row(t))}</TaskGroup> : <EmptyState icon={Flag} title="Nothing urgent" text="Tasks you flag as high priority collect here." />}
      </section>
    ) : sel === "@done" ? (
      <CompletedPanel item={item} onOpen={setOpen} />
    ) : (
      <ListPanel
        item={item}
        list={data.lists.find((l) => l.id === sel) ?? data.lists[0]}
        isPhone={isPhone}
        onOpen={setOpen}
        onToggle={toggle}
        onEdit={(l) => setEditList(l)}
      />
    );

  return (
    <Page wide={!isPhone} className="tasks-scope">
      {isPhone ? (
        sel === null ? (
          <>
            <h1 className="text-xl font-semibold text-[var(--text)]">Lists</h1>
            {index}
            {searchResults}
          </>
        ) : (
          <>
            <button type="button" onClick={() => setSel(null)} className="-ml-1 flex h-10 items-center gap-1 self-start rounded-lg pr-2 text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
              <ArrowLeft className="h-4 w-4" /> Lists
            </button>
            {detail}
          </>
        )
      ) : (
        <div className="grid grid-cols-[15rem_minmax(0,1fr)] gap-8">
          <aside className="sticky top-4 self-start">{index}</aside>
          <div className="flex min-w-0 flex-col gap-5">{searchResults ?? detail}</div>
        </div>
      )}
      {isPhone && item.canEdit && sel !== null && sel !== "@done" && <Fab label="Add" icon={Plus} onClick={() => setAdding(true)} />}
      <AddSheet item={item} open={adding} onClose={() => setAdding(false)} listId={sel && !sel.startsWith("@") ? sel : null} />
      <TaskEditor item={item} taskId={open} onClose={() => setOpen(null)} />
      <ListSheet item={item} target={editList} onClose={() => setEditList(null)} onCreated={(id) => setSel(id)} onDeleted={() => setSel(isPhone ? null : INBOX)} />
    </Page>
  );
}

function NavRow({ icon, name, count, active, onClick, listId }: { icon: React.ReactNode; name: string; count?: number; active?: boolean; onClick: () => void; listId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-list-id={listId}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-[44px] items-center gap-3 rounded-xl px-2 text-left text-sm transition md:min-h-[38px]",
        active ? "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] font-medium text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]",
      )}
    >
      <span className="flex w-5 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {count !== undefined && count > 0 && <span className="text-xs tabular-nums text-[var(--text-muted)]">{count}</span>}
    </button>
  );
}

/* ------------------------------------------------------------ one list */

function ListPanel({
  item,
  list,
  isPhone,
  onOpen,
  onToggle,
  onEdit,
}: {
  item: ItemHandle<TasksData>;
  list: TaskList;
  isPhone: boolean;
  onOpen: (id: string) => void;
  onToggle: (t: Task) => void;
  onEdit: (l: TaskList) => void;
}) {
  const data = item.data;
  const openTasks = useMemo(() => data.tasks.filter((t) => t.list_id === list.id && !t.done).sort(orderKey), [data.tasks, list.id]);
  const doneTasks = useMemo(() => data.tasks.filter((t) => t.list_id === list.id && t.done).sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? "")), [data.tasks, list.id]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = useReschedule(item);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragged = dragId ? openTasks.find((t) => t.id === dragId) : undefined;
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    if (!e.over || e.active.id === e.over.id) return;
    const ids = openTasks.map((t) => t.id);
    const moved = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    // Whole-number orders for this list's open tasks, in the new order.
    item.update((d) => {
      moved.forEach((id, i) => {
        const t = d.tasks.find((x) => x.id === id);
        if (t) t.order = i;
      });
    });
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {!list.emoji && <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: list.color }} />}
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold text-[var(--text)]">
          {list.emoji ? `${list.emoji} ` : ""}
          {list.name}
        </h1>
        {item.canEdit && list.id !== INBOX && <IconButton label="Edit list" icon={Pencil} onClick={() => onEdit(list)} />}
      </div>
      {item.canEdit && !isPhone && <QuickAdd item={item} listId={list.id} placeholder={`Add to ${list.name}`} />}
      {openTasks.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e) => setDragId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
          <SortableContext items={openTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <TaskGroup>
              {openTasks.map((t) => (
                <SortableTask key={t.id} task={t} data={data} canEdit={item.canEdit} onOpen={() => onOpen(t.id)} onToggle={() => onToggle(t)} onReschedule={(due) => move(t, due)} />
              ))}
            </TaskGroup>
          </SortableContext>
          <DragOverlay>
            {dragged ? (
              <div className="tasks-ghost flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm text-[var(--text)] shadow-[var(--shadow-lg)]">
                <GripVertical className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="line-clamp-2">{dragged.title}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <EmptyState icon={CheckCheck} title={doneTasks.length ? "All done here" : "Nothing in this list"} text={list.id === "shopping" ? "Add what you need — “Milk”, “Bread #shopping”." : "Add a task to get started."} />
      )}
      {doneTasks.length > 0 && (
        <Fold
          title="Completed"
          count={doneTasks.length}
          action={
            item.canEdit && (
              <ItemButton
                size="sm"
                variant="ghost"
                onClick={() => {
                  const ids = new Set(doneTasks.map((t) => t.id));
                  const copies = JSON.parse(JSON.stringify(doneTasks)) as Task[];
                  item.update((d) => void (d.tasks = d.tasks.filter((t) => !ids.has(t.id))));
                  toast.info(`Cleared ${copies.length} completed`, {
                    action: { label: "Undo", onClick: () => item.update((d) => void d.tasks.push(...copies.filter((c) => !d.tasks.some((x) => x.id === c.id)))) },
                  });
                }}
              >
                Clear
              </ItemButton>
            )
          }
        >
          <TaskGroup>
            {doneTasks.slice(0, 200).map((t) => (
              <TaskRow key={t.id} task={t} data={data} onToggle={() => onToggle(t)} onOpen={() => onOpen(t.id)} canEdit={item.canEdit} showList={false} />
            ))}
          </TaskGroup>
        </Fold>
      )}
    </section>
  );
}

function SortableTask({ task, data, canEdit, onOpen, onToggle, onReschedule }: { task: Task; data: TasksData; canEdit: boolean; onOpen: () => void; onToggle: () => void; onReschedule: (due: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: !canEdit });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("relative bg-[var(--surface)]", isDragging && "opacity-40")}>
      <TaskRow
        task={task}
        data={data}
        onToggle={onToggle}
        onOpen={onOpen}
        canEdit={canEdit}
        showList={false}
        onReschedule={onReschedule}
        handle={
          canEdit ? (
            <button type="button" aria-label={`Reorder “${task.title}”`} data-no-swipe {...attributes} {...listeners} className="flex h-11 w-10 shrink-0 md:w-6 cursor-grab touch-none items-center justify-center text-[var(--text-muted)] opacity-60 hover:opacity-100">
              <GripVertical className="h-4 w-4" />
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------ completed */

/** The day a moment falls on here, whatever zone it was written in. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CompletedPanel({ item, onOpen }: { item: ItemHandle<TasksData>; onOpen: (id: string) => void }) {
  const data = item.data;
  const groups = useMemo(() => {
    const m = new Map<string, Done[]>();
    for (const x of [...data.log].reverse().slice(0, 500)) {
      const day = localDay(x.at);
      m.set(day, [...(m.get(day) ?? []), x]);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data.log]);
  const today = todayISO();
  const weekAgo = plusDays(today, -6);
  const week = data.log.filter((x) => localDay(x.at) >= weekAgo).length;

  /** Put a finished task back on its list (Undo ticks it off again). */
  const reopen = (x: Done, t: Task) => {
    const doneAt = t.done_at;
    const entry = { ...x };
    const at = data.log.findIndex((y) => y.id === x.id);
    item.update(reopenChange(t.id));
    toast.success(`“${t.title}” is back on your list`, {
      action: {
        label: "Undo",
        onClick: () =>
          item.update((d) => {
            const y = d.tasks.find((z) => z.id === t.id);
            if (!y || y.done) return;
            y.done = true;
            y.done_at = doneAt;
            if (!d.log.some((z) => z.id === entry.id)) d.log.splice(at < 0 ? d.log.length : Math.min(at, d.log.length), 0, entry);
          }),
      },
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text)]">Completed</h1>
        <p className="text-sm text-[var(--text-muted)]">
          {week} in the last 7 days · {data.log.length} in all
        </p>
      </div>
      {!groups.length && <EmptyState icon={CheckCheck} title="Nothing ticked off yet" text="Completed tasks — repeats included — are logged here." />}
      {groups.map(([day, rows]) => (
        <div key={day} className="flex flex-col gap-1.5">
          <h2 className="px-1 text-sm font-semibold text-[var(--text)]">
            {day === today ? "Today" : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" })}
            <span className="ml-1.5 font-normal text-[var(--text-muted)]">{rows.length}</span>
          </h2>
          <TaskGroup>
            {rows.map((x) => {
              const l = data.lists.find((y) => y.id === x.list_id);
              const t = data.tasks.find((y) => y.id === x.task_id);
              // Still done: a tap puts it back. Already back (a repeat that
              // rolled on to its next day): a tap opens it.
              const back = !!t && t.done && item.canEdit;
              const inner = (
                <>
                  <CheckCheck className="h-4 w-4 shrink-0 text-[var(--success)]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.title}</span>
                  {l && l.id !== INBOX && <span className="shrink-0 text-xs text-[var(--text-muted)]">{l.name}</span>}
                  <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{fmtTime(x.at)}</span>
                  {back && <RotateCcw className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />}
                </>
              );
              return t ? (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => (back ? reopen(x, t) : onOpen(t.id))}
                  aria-label={back ? `Put “${x.title}” back on your list` : `Open “${x.title}”`}
                  title={back ? "Put back on your list" : "Open"}
                  className="flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                >
                  {inner}
                </button>
              ) : (
                <div key={x.id} className="flex min-h-[44px] items-center gap-3 px-3 py-2">
                  {inner}
                </div>
              );
            })}
          </TaskGroup>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------ list editor */

const COLOR_NAMES = ["Blue", "Terracotta", "Green", "Purple", "Amber", "Berry", "Sky", "Brown"];
const colorName = (c: string) => COLOR_NAMES[LIST_COLORS.indexOf(c)] ?? "Custom";

const LIST_EMOJIS = [
  "🛒", "🏠", "💼", "📚", "🎓", "💪", "🏃", "🍽️",
  "🧹", "🧺", "🔧", "🚗", "✈️", "🏖️", "🎁", "🎉",
  "💰", "🧾", "💡", "📞", "💊", "🩺", "🐶", "🐱",
  "🌱", "👶", "❤️", "⭐", "🎯", "🎬", "🎵", "🎮",
  "⚽", "🧘", "📅", "✏️", "💻", "📦", "🔑",
];

function ListSheet({
  item,
  target,
  onClose,
  onCreated,
  onDeleted,
}: {
  item: ItemHandle<TasksData>;
  target: TaskList | "new" | null;
  onClose: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}) {
  const isNew = target === "new";
  const cur = target && target !== "new" ? target : null;
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState(LIST_COLORS[0]);
  const [seen, setSeen] = useState<typeof target>(null);
  if (target !== seen) {
    setSeen(target);
    setName(cur?.name ?? "");
    setEmoji(cur?.emoji ?? "");
    setColor(cur?.color ?? LIST_COLORS[item.data.lists.length % LIST_COLORS.length]);
  }
  const n = cur ? item.data.tasks.filter((t) => t.list_id === cur.id && !t.done).length : 0;
  // A list that already has an icon from outside the grid keeps it.
  const emojis = cur?.emoji && !LIST_EMOJIS.includes(cur.emoji) ? [cur.emoji, ...LIST_EMOJIS] : LIST_EMOJIS;
  const save = () => {
    const nm = name.trim();
    if (!nm) return;
    if (isNew) {
      const id = uid("l");
      const order = Math.max(0, ...item.data.lists.map((l) => l.order)) + 1;
      item.update((d) => void d.lists.push({ id, name: nm.slice(0, 80), color, emoji: emoji.trim().slice(0, 8), order }));
      onCreated(id);
    } else if (cur) {
      item.update((d) => {
        const l = d.lists.find((x) => x.id === cur.id);
        if (!l) return;
        if (nm !== cur.name) l.name = nm.slice(0, 80);
        if (color !== cur.color) l.color = color;
        if (emoji.trim() !== cur.emoji) l.emoji = emoji.trim().slice(0, 8);
      });
    }
    onClose();
  };
  const remove = async (list: TaskList, open: number) => {
    // Close the sheet first so the question isn't asked underneath it.
    onClose();
    if (
      open &&
      !(await confirm({
        title: `Delete “${list.name}”?`,
        message: `Its ${open} open task${open === 1 ? "" : "s"} will move to the Inbox.`,
        confirmLabel: "Delete list",
        danger: true,
      }))
    )
      return;
    const copy = { ...list };
    const moved = new Set(item.data.tasks.filter((t) => t.list_id === list.id).map((t) => t.id));
    item.update((d) => {
      for (const t of d.tasks) if (t.list_id === list.id) t.list_id = INBOX;
      d.lists = d.lists.filter((x) => x.id !== list.id);
    });
    onDeleted();
    toast.info(`Deleted “${list.name}”`, {
      action: {
        label: "Undo",
        onClick: () => {
          item.update((d) => {
            if (!d.lists.some((x) => x.id === copy.id)) d.lists.push({ ...copy });
            // Only tasks still sitting in the Inbox go back.
            for (const t of d.tasks) if (moved.has(t.id) && t.list_id === INBOX) t.list_id = copy.id;
          });
          onCreated(copy.id);
        },
      },
    });
  };
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={isNew ? "New list" : "Edit list"}
      size="sm"
      footer={
        <div className="flex w-full items-center gap-2">
          {cur && (
            <ItemButton variant="ghost" className="text-[var(--danger)]" icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove(cur, n)}>
              Delete
            </ItemButton>
          )}
          <ItemButton variant="primary" className="ml-auto" disabled={!name.trim()} onClick={save}>
            {isNew ? "Create" : "Save"}
          </ItemButton>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries" maxLength={80} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Icon</span>
          <div className="grid grid-cols-8 gap-1" role="group" aria-label="Icon">
            <button
              type="button"
              aria-label="No icon"
              title="No icon"
              aria-pressed={!emoji}
              onClick={() => setEmoji("")}
              className={cn(
                "flex h-10 items-center justify-center rounded-xl transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                !emoji && "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] ring-2 ring-inset ring-[var(--accent)]",
              )}
            >
              <span className="h-3 w-3 rounded-full" style={{ background: color }} />
            </button>
            {emojis.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={`Icon ${e}`}
                aria-pressed={emoji === e}
                onClick={() => setEmoji(e)}
                className={cn(
                  "flex h-10 items-center justify-center rounded-xl text-xl leading-none transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                  emoji === e && "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] ring-2 ring-inset ring-[var(--accent)]",
                )}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Colour · <span className="text-[var(--text)]">{colorName(color)}</span>
          </span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Colour">
            {LIST_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={colorName(c)}
                title={colorName(c)}
                aria-pressed={c === color}
                onClick={() => setColor(c)}
                className="flex h-10 w-10 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
              >
                <span className={cn("h-7 w-7 rounded-full transition", c === color && "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]")} style={{ background: c }} />
              </button>
            ))}
          </div>
        </div>
      </form>
    </Sheet>
  );
}
