import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { ItemButton, TextInput, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { TickMark } from "./parts";
import type { Task } from "./types";

type Step = Task["steps"][number];

/*
 * A task's steps: the same round tick as a task, a title you can change
 * where it sits, a grip to put them in order, and Undo when one is removed.
 */

function StepRow({ step, readOnly, edit }: { step: Step; readOnly: boolean; edit: (fn: (t: Task) => void) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id, disabled: readOnly });
  const [title, setTitle] = useState(step.title);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => setTitle(step.title), [step.title]);
  const commit = () => {
    const v = title.trim().slice(0, 300);
    if (!v) return setTitle(step.title);
    if (v !== step.title)
      edit((t) => {
        const x = t.steps.find((y) => y.id === step.id);
        if (x) x.title = v;
      });
  };
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("relative flex items-center rounded-lg bg-[var(--surface)]", isDragging && "z-10 shadow-[var(--shadow-lg)]")}>
      {!readOnly && (
        <button type="button" aria-label={`Reorder step ${step.title}`} {...attributes} {...listeners} className="flex h-10 w-8 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--text-muted)] opacity-60 hover:opacity-100">
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={step.done}
        aria-label={step.done ? `Mark step ${step.title} not done` : `Tick off step ${step.title}`}
        onClick={() => {
          const target = !step.done;
          setDrawn(target);
          edit((t) => {
            const x = t.steps.find((y) => y.id === step.id);
            if (x) x.done = target;
          });
        }}
        className={cn(
          "tasks-check flex h-10 w-10 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
          step.done && "is-done",
          drawn && step.done && "is-drawing",
        )}
      >
        <span
          className={cn(
            "tasks-check-ring flex h-[18px] w-[18px] items-center justify-center rounded-full border-2",
            step.done ? "border-transparent bg-[var(--item-accent)] text-white" : "border-[var(--text-muted)] text-[var(--text-muted)]",
          )}
        >
          <TickMark className="h-3 w-3" />
        </span>
      </button>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        maxLength={300}
        aria-label="Step"
        className={cn(
          "h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 text-sm text-[var(--text)] outline-none hover:border-[var(--border)] focus:border-[var(--accent)]",
          step.done && "text-[var(--text-muted)] line-through",
        )}
      />
      {!readOnly && (
        <button
          type="button"
          aria-label={`Remove step ${step.title}`}
          onClick={() => {
            const copy = { ...step };
            let at = -1;
            edit((t) => {
              at = t.steps.findIndex((y) => y.id === copy.id);
              t.steps = t.steps.filter((y) => y.id !== copy.id);
            });
            toast.info(`Removed “${copy.title}”`, {
              action: {
                label: "Undo",
                onClick: () =>
                  edit((t) => {
                    if (!t.steps.some((y) => y.id === copy.id)) t.steps.splice(at < 0 ? t.steps.length : Math.min(at, t.steps.length), 0, { ...copy });
                  }),
              },
            });
          }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

export function Steps({ task, readOnly, edit }: { task: Task; readOnly: boolean; edit: (fn: (t: Task) => void) => void }) {
  const [draft, setDraft] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = task.steps.map((s) => s.id);
    const order = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    edit((t) => {
      t.steps = [...t.steps].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    });
  };
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    const id = uid("s");
    edit((t) => void t.steps.push({ id, title: v.slice(0, 300), done: false }));
    setDraft("");
  };
  return (
    <>
      {task.steps.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={task.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col">
              {task.steps.map((st) => (
                <StepRow key={st.id} step={st} readOnly={readOnly} edit={edit} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <TextInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add a step"
            aria-label="New step"
            enterKeyHint="done"
          />
          <ItemButton aria-label="Add step" icon={<Plus className="h-4 w-4" />} disabled={!draft.trim()} onClick={add} />
        </div>
      )}
    </>
  );
}
