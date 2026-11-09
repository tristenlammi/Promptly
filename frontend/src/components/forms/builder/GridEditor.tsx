import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import type { ChoiceGridConfig, FormItem, GridLine } from "@/api/forms";
import { cn } from "@/utils/cn";

import { GRID_COLUMN_CHARS, GRID_MAX_COLUMNS, GRID_MAX_ROWS, newGridLine } from "../model";
import { Switch, fieldCls, iconBtnCls } from "./ui";

/**
 * A grid question's editor: two lists, **Rows** and **Columns**, each with
 * drag handles (or Space and the arrow keys), Add, Enter for the next one,
 * Backspace on an empty one to remove it, and paste of several lines at
 * once. Then the grid's switches: an answer in each row, one per column
 * (multiple-choice grids only) and shuffle rows. Caps: 20 rows, 8 columns,
 * 40-character columns — a grid has to work on a phone.
 */
export function GridEditor({
  item,
  setConfig,
}: {
  item: FormItem<"choice_grid"> | FormItem<"checkbox_grid">;
  setConfig: (fn: (c: never) => unknown, coalesce?: string) => void;
}) {
  const c = item.config as ChoiceGridConfig;
  const multi = item.kind === "checkbox_grid";
  const set = (patch: Partial<ChoiceGridConfig>, key?: string) => setConfig((x: ChoiceGridConfig) => ({ ...x, ...patch }), key);
  const tooMany = !multi && c.one_per_column && c.each_row && c.rows.length > c.columns.length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Lines
          kind="r"
          title="Rows"
          lines={c.rows}
          max={GRID_MAX_ROWS}
          maxChars={300}
          itemId={item.id}
          onChange={(rows, key) => setConfig((x: ChoiceGridConfig) => ({ ...x, rows: rows(x.rows) }), key)}
        />
        <Lines
          kind="c"
          title="Columns"
          lines={c.columns}
          max={GRID_MAX_COLUMNS}
          maxChars={GRID_COLUMN_CHARS}
          itemId={item.id}
          onChange={(cols, key) => setConfig((x: ChoiceGridConfig) => ({ ...x, columns: cols(x.columns) }), key)}
        />
      </div>
      <div className="flex flex-col gap-3 border-t border-dotted border-[var(--border)] pt-3">
        <Switch checked={c.each_row} onChange={(v) => set({ each_row: v })} label="Require an answer in each row" />
        {!multi && (
          <Switch
            checked={c.one_per_column}
            onChange={(v) => set({ one_per_column: v })}
            label="Only one answer per column"
            hint="Good for “rank these”: each column can be picked in one row only."
          />
        )}
        <Switch checked={c.shuffle_rows} onChange={(v) => set({ shuffle_rows: v })} label="Shuffle rows" hint="Columns always stay in order." />
        {tooMany && (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            With one answer per column and an answer in each row, you need at least as many columns as rows.
          </p>
        )}
      </div>
    </div>
  );
}

function Lines({
  kind,
  title,
  lines,
  max,
  maxChars,
  itemId,
  onChange,
}: {
  kind: "r" | "c";
  title: string;
  lines: GridLine[];
  max: number;
  maxChars: number;
  itemId: string;
  onChange: (fn: (l: GridLine[]) => GridLine[], key?: string) => void;
}) {
  const word = kind === "r" ? "Row" : "Column";
  const inputs = useRef(new Map<string, HTMLInputElement>());
  // A new line is focused (its "Row 3" selected, so typing replaces it)
  // once, as soon as it's on screen. A ref, not state: it's used up the
  // moment it's applied, so a keystroke can never select it again.
  const focusNext = useRef<string | null>(null);
  const setFocusId = (id: string | null) => {
    focusNext.current = id;
  };
  useLayoutEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    const el = inputs.current.get(id);
    if (!el) return;
    focusNext.current = null;
    el.focus();
    el.select();
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const addAfter = (idx: number, labels: string[] = [""]) => {
    const room = max - lines.length;
    if (room <= 0) return;
    const made = labels.slice(0, room).map((l, i) => newGridLine(kind, (l || `${word} ${lines.length + 1 + i}`).slice(0, maxChars)));
    onChange((l) => [...l.slice(0, idx + 1), ...made, ...l.slice(idx + 1)]);
    setFocusId(made[made.length - 1].id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onChange((l) => {
      const from = l.findIndex((x) => x.id === active.id);
      const to = l.findIndex((x) => x.id === over.id);
      return from < 0 || to < 0 ? l : arrayMove(l, from, to);
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]" id={`${itemId}-${kind}-title`}>
        {title}
      </h3>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={lines.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1.5" aria-labelledby={`${itemId}-${kind}-title`}>
            {lines.map((l, i) => (
              <Line
                key={l.id}
                line={l}
                index={i}
                word={word}
                maxChars={maxChars}
                canRemove={lines.length > 1}
                inputRef={(el) => {
                  if (el) inputs.current.set(l.id, el);
                  else inputs.current.delete(l.id);
                }}
                onLabel={(v) => onChange((list) => list.map((x) => (x.id === l.id ? { ...x, label: v } : x)), `${l.id}:label`)}
                onRemove={() => {
                  const prev = lines[i - 1] ?? lines[i + 1];
                  onChange((list) => list.filter((x) => x.id !== l.id));
                  if (prev) setFocusId(prev.id);
                }}
                onEnter={() => addAfter(i)}
                onPasteLines={(first, rest) => {
                  onChange((list) => list.map((x) => (x.id === l.id ? { ...x, label: (x.label + first).slice(0, maxChars) } : x)));
                  if (rest.length) addAfter(i, rest);
                }}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        className="inline-flex min-h-[40px] items-center gap-1.5 self-start rounded-md px-2 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] disabled:opacity-40"
        disabled={lines.length >= max}
        onClick={() => addAfter(lines.length - 1)}
      >
        <Plus className="h-4 w-4" aria-hidden="true" /> Add {word.toLowerCase()}
      </button>
      {lines.length >= max && (
        <p className="text-xs text-[var(--text-muted)]">
          A grid can have at most {max} {title.toLowerCase()}, so it still works on a phone.
        </p>
      )}
    </div>
  );
}

function Line({
  line,
  index,
  word,
  maxChars,
  canRemove,
  inputRef,
  onLabel,
  onRemove,
  onEnter,
  onPasteLines,
}: {
  line: GridLine;
  index: number;
  word: string;
  maxChars: number;
  canRemove: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onLabel: (v: string) => void;
  onRemove: () => void;
  onEnter: () => void;
  onPasteLines: (first: string, rest: string[]) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: line.id });
  const name = `${word} ${index + 1}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center gap-1", isDragging && "relative z-10 opacity-80")}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder: ${line.label || name}`}
        className="flex h-10 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <input
        ref={inputRef}
        aria-label={name}
        className={cn(fieldCls, "h-10 min-w-0 flex-1")}
        value={line.label}
        maxLength={maxChars}
        onChange={(e) => onLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Backspace" && line.label === "" && canRemove) {
            e.preventDefault();
            onRemove();
          }
        }}
        onPaste={(e) => {
          const parts = e.clipboardData.getData("text").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (parts.length < 2) return;
          e.preventDefault();
          const [first, ...rest] = parts;
          onPasteLines(first, rest);
        }}
      />
      <button type="button" className={iconBtnCls} aria-label={`Remove ${name.toLowerCase()}`} title="Remove" disabled={!canRemove} onClick={onRemove}>
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}
