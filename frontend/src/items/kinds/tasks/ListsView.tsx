import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, CheckCheck, Flag, GripVertical, Inbox, ListPlus, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { EmptyState, Fab, Field, IconButton, ItemButton, Page, Sheet, TextInput, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { LIST_COLORS, orderKey, sortKey } from "./logic";
import { AddSheet, Fold, QuickAdd, TaskGroup, TaskRow, useQuickAddRequest, useToggle } from "./parts";
import { plusDays } from "./recur";
import { TaskEditor } from "./TaskEditor";
import { INBOX, type Task, type TaskList, type TasksData } from "./types";

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

  const row = (t: Task, showList = true) => <TaskRow key={t.id} task={t} data={data} onToggle={() => toggle(t)} onOpen={() => setOpen(t.id)} canEdit={item.canEdit} showList={showList} />;

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
          {item.canEdit && <IconButton label="New list" icon={ListPlus} onClick={() => setEditList("new")} className="h-8 w-8" />}
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
        {high.length ? <TaskGroup>{high.map((t) => row(t))}</TaskGroup> : <EmptyState icon={Flag} title="Nothing urgent" text="Tasks marked high priority (!3) collect here." />}
      </section>
    ) : sel === "@done" ? (
      <CompletedPanel item={item} />
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
    <Page wide={!isPhone}>
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
  const onDragEnd = (e: DragEndEvent) => {
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={openTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <TaskGroup>
              {openTasks.map((t) => (
                <SortableTask key={t.id} task={t} data={data} canEdit={item.canEdit} onOpen={() => onOpen(t.id)} onToggle={() => onToggle(t)} />
              ))}
            </TaskGroup>
          </SortableContext>
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

function SortableTask({ task, data, canEdit, onOpen, onToggle }: { task: Task; data: TasksData; canEdit: boolean; onOpen: () => void; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: !canEdit });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("relative bg-[var(--surface)]", isDragging && "z-10 shadow-[var(--shadow-lg)]")}>
      <TaskRow
        task={task}
        data={data}
        onToggle={onToggle}
        onOpen={onOpen}
        canEdit={canEdit}
        showList={false}
        handle={
          canEdit ? (
            <button type="button" aria-label={`Reorder “${task.title}”`} {...attributes} {...listeners} className="flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--text-muted)] opacity-60 hover:opacity-100">
              <GripVertical className="h-4 w-4" />
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------ completed */

function CompletedPanel({ item }: { item: ItemHandle<TasksData> }) {
  const data = item.data;
  const groups = useMemo(() => {
    const m = new Map<string, typeof data.log>();
    for (const x of [...data.log].reverse().slice(0, 500)) m.set(x.at.slice(0, 10), [...(m.get(x.at.slice(0, 10)) ?? []), x]);
    return [...m.entries()];
  }, [data.log]);
  const today = todayISO();
  const week = data.log.filter((x) => x.at.slice(0, 10) >= plusDays(today, -6)).length;
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
              return (
                <div key={x.id} className="flex min-h-[44px] items-center gap-3 px-3 py-2">
                  <CheckCheck className="h-4 w-4 shrink-0 text-[var(--success)]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.title}</span>
                  {l && l.id !== INBOX && <span className="shrink-0 text-xs text-[var(--text-muted)]">{l.name}</span>}
                  <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{x.at.slice(11, 16)}</span>
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
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={isNew ? "New list" : "Edit list"}
      size="sm"
      footer={
        <div className="flex w-full items-center gap-2">
          {cur && (
            <ItemButton
              variant="ghost"
              className="text-[var(--danger)]"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                if (n && !window.confirm(`Delete “${cur.name}”? Its ${n} open task${n === 1 ? "" : "s"} move to the Inbox.`)) return;
                item.update((d) => {
                  for (const t of d.tasks) if (t.list_id === cur.id) t.list_id = INBOX;
                  d.lists = d.lists.filter((x) => x.id !== cur.id);
                });
                onDeleted();
                onClose();
              }}
            >
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
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
          <Field label="Emoji">
            <TextInput value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🛒" maxLength={8} className="text-center" />
          </Field>
          <Field label="Name">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries" maxLength={80} />
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Colour</span>
          <div className="flex flex-wrap gap-2">
            {LIST_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={c === color}
                onClick={() => setColor(c)}
                className={cn("h-9 w-9 rounded-full transition", c === color && "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]")}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      </form>
    </Sheet>
  );
}
