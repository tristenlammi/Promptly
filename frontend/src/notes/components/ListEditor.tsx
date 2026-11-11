import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Plus, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/utils/cn";

import { aisleName, keptByAisle } from "../aisles";
import { grouped } from "../ops";
import { addFlusher, notesActions } from "../store";
import { uuid, type Note, type NoteItem } from "../types";

/**
 * A list note's items. Enter adds an item below (splitting the text at the
 * cursor), Backspace on an empty item removes it, Tab / Shift+Tab indent
 * one level, arrows move between items. Ticked items move to a section at
 * the bottom that folds away. Each change is its own small request, so two
 * people ticking the same list never clash.
 */

type Focus = { id: string; caret: number | "end" } | null;

function pos(i: NoteItem | undefined): number {
  return i?.position ?? 0;
}

export function ListEditor({ note, editable, autoFocusNew }: { note: Note; editable: boolean; autoFocusNew?: boolean }) {
  const all = useMemo(() => grouped(note.items), [note.items]);
  const open = all.filter((i) => !i.checked);
  const ticked = all.filter((i) => i.checked);
  const ids = useMemo(() => new Set(all.map((i) => i.id)), [all]);
  const openTops = open.filter((i) => !i.parent_id || !ids.has(i.parent_id) || !open.some((p) => p.id === i.parent_id));
  const kidsOf = useCallback((pid: string) => open.filter((i) => i.parent_id === pid), [open]);
  const refs = useRef(new Map<string, HTMLTextAreaElement>());
  const [focus, setFocus] = useState<Focus>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const tickedOpen = note.list_opts.ticked_open ?? true;
  // Kept by aisle (N2.2): thin aisle lines between groups, and a new item
  // goes in when it's typed (Enter), so its aisle comes from its words.
  const byAisle = keptByAisle(note);
  const [draft, setDraft] = useState("");
  const commitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    notesActions.addItem(note.id, { id: uuid(), text }, null);
    setDraft("");
  };
  /** An aisle line before ``i`` when its aisle differs from the item above. */
  const aisleLine = (list: NoteItem[], at: number) => {
    if (!byAisle) return null;
    const a = list[at]?.aisle;
    if (!a) return null;
    const prev = list.slice(0, at).reverse().find((x) => x.aisle);
    if (prev && prev.aisle === a) return null;
    return (
      <li key={`aisle-${a}-${list[at].id}`} className="list-none px-1 pb-0.5 pt-2 first:pt-0" data-aisle={a}>
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider note-muted">
          {aisleName(a)}
          <span aria-hidden className="h-px flex-1 bg-[color-mix(in_srgb,var(--note-text)_14%,transparent)]" />
        </span>
      </li>
    );
  };

  useLayoutEffect(() => {
    if (!focus) return;
    const el = refs.current.get(focus.id);
    if (!el) return;
    el.focus();
    const at = focus.caret === "end" ? el.value.length : Math.min(focus.caret, el.value.length);
    el.setSelectionRange(at, at);
    setFocus(null);
  }, [focus, note.items]);

  useEffect(() => {
    if (autoFocusNew && editable) newRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ------------------------------------------------------------ edits
  const lastGlobal = () => [...note.items].sort((a, b) => pos(a) - pos(b)).at(-1)?.id ?? null;

  const addAfter = (cur: NoteItem, text: string) => {
    const hasKids = !cur.parent_id && kidsOf(cur.id).length > 0;
    const parent = cur.parent_id ? cur.parent_id : hasKids ? cur.id : null;
    const id = notesActions.addItem(note.id, { id: uuid(), text, parent_id: parent }, cur.id);
    setFocus({ id, caret: 0 });
  };

  const indent = (cur: NoteItem) => {
    if (cur.parent_id || kidsOf(cur.id).length) return;
    const at = openTops.findIndex((t) => t.id === cur.id);
    const parent = at > 0 ? openTops[at - 1] : null;
    if (!parent) return;
    notesActions.patchItem(note.id, cur.id, { parent_id: parent.id });
    setFocus({ id: cur.id, caret: "end" });
  };

  const outdent = (cur: NoteItem) => {
    if (!cur.parent_id) return;
    const siblings = note.items.filter((i) => i.parent_id === cur.parent_id && i.id !== cur.id).sort((a, b) => pos(a) - pos(b));
    const parent = note.items.find((i) => i.id === cur.parent_id);
    const after = siblings.filter((s) => pos(s) > pos(cur));
    if (!after.length) notesActions.patchItem(note.id, cur.id, { parent_id: null });
    else {
      const lastKid = pos(siblings[siblings.length - 1]);
      const nextTop = note.items.filter((i) => !i.parent_id && pos(i) > pos(parent)).sort((a, b) => pos(a) - pos(b))[0];
      const p = nextTop ? (lastKid + pos(nextTop)) / 2 : lastKid + 1;
      notesActions.patchItem(note.id, cur.id, { parent_id: null, position: p });
    }
    setFocus({ id: cur.id, caret: "end" });
  };

  const remove = (cur: NoteItem, focusPrev: boolean) => {
    const at = open.findIndex((i) => i.id === cur.id);
    const prev = at > 0 ? open[at - 1] : null;
    notesActions.deleteItem(note.id, cur.id);
    if (focusPrev && prev) setFocus({ id: prev.id, caret: "end" });
  };

  const toggle = (cur: NoteItem, checked: boolean) => {
    notesActions.patchItem(note.id, cur.id, { checked });
    // A parent takes its own items with it.
    if (!cur.parent_id) for (const k of note.items.filter((i) => i.parent_id === cur.id && i.checked !== checked)) notesActions.patchItem(note.id, k.id, { checked });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const a = String(e.active.id);
    const o = e.over ? String(e.over.id) : null;
    if (!o || a === o) return;
    const item = note.items.find((i) => i.id === a);
    const target = note.items.find((i) => i.id === o);
    if (!item || !target || (item.parent_id ?? null) !== (target.parent_id ?? null)) return;
    if (!item.parent_id) {
      // A top-level item moves with its own items.
      const tops = openTops.filter((t) => t.id !== a);
      const from = openTops.findIndex((t) => t.id === a);
      const to = openTops.findIndex((t) => t.id === o);
      const idx = tops.findIndex((t) => t.id === o) + (to > from ? 1 : 0);
      const before = tops[idx - 1];
      const after = tops[idx];
      const groupEnd = before ? Math.max(pos(before), ...note.items.filter((i) => i.parent_id === before.id).map(pos)) : null;
      const lo = groupEnd ?? (after ? pos(after) - 1 : 0);
      const hi = after ? pos(after) : lo + 2;
      const kids = note.items.filter((i) => i.parent_id === a).sort((x, y) => pos(x) - pos(y));
      const step = (hi - lo) / (kids.length + 2);
      // Kept by aisle: dropped on an item, it joins that item's aisle.
      const aisle = byAisle && target.aisle && target.aisle !== item.aisle ? target.aisle : undefined;
      notesActions.patchItem(note.id, a, aisle ? { position: lo + step, aisle } : { position: lo + step });
      kids.forEach((k, n) => notesActions.patchItem(note.id, k.id, { position: lo + step * (n + 2) }));
    } else {
      const sibs = open.filter((i) => i.parent_id === item.parent_id && i.id !== a);
      const from = open.filter((i) => i.parent_id === item.parent_id).findIndex((i) => i.id === a);
      const to = open.filter((i) => i.parent_id === item.parent_id).findIndex((i) => i.id === o);
      const idx = sibs.findIndex((t) => t.id === o) + (to > from ? 1 : 0);
      const parent = note.items.find((i) => i.id === item.parent_id);
      const lo = sibs[idx - 1] ? pos(sibs[idx - 1]) : pos(parent);
      const nextTop = note.items.filter((i) => !i.parent_id && pos(i) > pos(parent)).sort((x, y) => pos(x) - pos(y))[0];
      const hi = sibs[idx] ? pos(sibs[idx]) : nextTop ? pos(nextTop) : lo + 2;
      notesActions.patchItem(note.id, a, { position: (lo + hi) / 2 });
    }
  };

  const row = (i: NoteItem, sortable: boolean) => (
    <ItemRow
      key={i.id}
      noteId={note.id}
      item={i}
      editable={editable}
      sortable={sortable && editable}
      indented={!!i.parent_id && ids.has(i.parent_id)}
      inputRef={(el) => (el ? refs.current.set(i.id, el) : refs.current.delete(i.id))}
      onText={(text) => notesActions.patchItem(note.id, i.id, { text })}
      onToggle={(c) => toggle(i, c)}
      onRemove={() => remove(i, false)}
      onKey={(e, el) => {
        const caret = el.selectionStart ?? 0;
        const atStart = caret === 0 && el.selectionEnd === 0;
        const list = i.checked ? ticked : open;
        const at = list.findIndex((x) => x.id === i.id);
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (i.checked) return;
          const before = el.value.slice(0, caret);
          const rest = el.value.slice(el.selectionEnd ?? caret);
          if (before !== i.text) notesActions.patchItem(note.id, i.id, { text: before });
          addAfter(i, rest);
        } else if (e.key === "Backspace" && atStart) {
          if (!el.value) {
            e.preventDefault();
            remove(i, true);
          } else if (at > 0 && !i.checked) {
            e.preventDefault();
            const prev = list[at - 1];
            notesActions.patchItem(note.id, prev.id, { text: prev.text + el.value });
            notesActions.deleteItem(note.id, i.id);
            setFocus({ id: prev.id, caret: prev.text.length });
          }
        } else if (e.key === "Tab" && !i.checked) {
          e.preventDefault();
          if (e.shiftKey) outdent(i);
          else indent(i);
        } else if (e.key === "ArrowUp" && caret === 0 && at > 0) {
          e.preventDefault();
          setFocus({ id: list[at - 1].id, caret: "end" });
        } else if (e.key === "ArrowDown" && caret === el.value.length && at < list.length - 1) {
          e.preventDefault();
          setFocus({ id: list[at + 1].id, caret: "end" });
        } else if (e.key === "ArrowDown" && caret === el.value.length && at === list.length - 1 && !i.checked) {
          e.preventDefault();
          newRef.current?.focus();
        }
      }}
    />
  );

  return (
    <div className="flex flex-col">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={openTops.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul aria-label="List items" className="flex flex-col">
            {openTops.flatMap((t, at) => {
              const kids = kidsOf(t.id);
              const line = aisleLine(openTops, at);
              return [
                line,
                <SortableGroup key={t.id} id={t.id} enabled={editable}>
                  {row(t, true)}
                  {kids.length > 0 && (
                    <SortableContext items={kids.map((k) => k.id)} strategy={verticalListSortingStrategy}>
                      <ul className="flex flex-col">
                        {kids.map((k) => (
                          <SortableGroup key={k.id} id={k.id} enabled={editable}>
                            {row(k, true)}
                          </SortableGroup>
                        ))}
                      </ul>
                    </SortableContext>
                  )}
                </SortableGroup>,
              ];
            })}
          </ul>
        </SortableContext>
      </DndContext>

      {editable && byAisle && (
        <div className="flex items-center gap-2 py-1 pl-7">
          <Plus className="h-4 w-4 shrink-0 note-muted" aria-hidden />
          <input
            ref={newRef}
            aria-label="New list item"
            aria-description="Press Enter to add it to its aisle"
            placeholder="List item"
            value={draft}
            enterKeyHint="done"
            className="h-8 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--note-muted)]"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitDraft();
              } else if (e.key === "ArrowUp" && open.length && !draft) {
                e.preventDefault();
                setFocus({ id: open[open.length - 1].id, caret: "end" });
              }
            }}
          />
        </div>
      )}
      {editable && !byAisle && (
        <div className="flex items-center gap-2 py-1 pl-7">
          <Plus className="h-4 w-4 shrink-0 note-muted" aria-hidden />
          <input
            ref={newRef}
            aria-label="New list item"
            placeholder="List item"
            className="h-8 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--note-muted)]"
            onChange={(e) => {
              const text = e.target.value;
              if (!text) return;
              e.target.value = "";
              const id = notesActions.addItem(note.id, { id: uuid(), text }, lastGlobal());
              setFocus({ id, caret: "end" });
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && open.length) {
                e.preventDefault();
                setFocus({ id: open[open.length - 1].id, caret: "end" });
              }
            }}
          />
        </div>
      )}

      {ticked.length > 0 && (
        <div className="mt-2 border-t border-[color-mix(in_srgb,var(--note-text)_14%,transparent)] pt-1">
          <button
            type="button"
            aria-expanded={tickedOpen}
            onClick={() => editable && notesActions.patch(note.id, { list_opts: { ...note.list_opts, ticked_open: !tickedOpen } })}
            className="flex h-9 items-center gap-1.5 rounded-md px-1 text-sm note-muted note-hover"
          >
            <ChevronDown className={cn("h-4 w-4 transition", !tickedOpen && "-rotate-90")} />
            {ticked.length === 1 ? "1 ticked item" : `${ticked.length} ticked items`}
          </button>
          {tickedOpen && (
            <ul aria-label="Ticked items" className="flex flex-col">
              {ticked.flatMap((i, at) => [aisleLine(ticked, at), <li key={i.id}>{row(i, false)}</li>])}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SortableGroup({ id, enabled, children }: { id: string; enabled: boolean; children: React.ReactNode }) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id, disabled: !enabled });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 5 : undefined, opacity: isDragging ? 0.85 : undefined };
  return (
    <HandleContext.Provider value={enabled ? { attributes, listeners } : null}>
      <li ref={setNodeRef} style={style} className="list-none">
        {children}
      </li>
    </HandleContext.Provider>
  );
}

const HandleContext = createContext<{ attributes: object; listeners: object | undefined } | null>(null);

function ItemRow({
  noteId,
  item,
  editable,
  sortable,
  indented,
  inputRef,
  onText,
  onToggle,
  onRemove,
  onKey,
}: {
  noteId: string;
  item: NoteItem;
  editable: boolean;
  sortable: boolean;
  indented: boolean;
  inputRef: (el: HTMLTextAreaElement | null) => void;
  onText: (t: string) => void;
  onToggle: (checked: boolean) => void;
  onRemove: () => void;
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>, el: HTMLTextAreaElement) => void;
}) {
  const handle = useContext(HandleContext);
  const [text, setText] = useState(item.text);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const el = useRef<HTMLTextAreaElement | null>(null);

  // Someone else's edit shows unless you're typing in this item.
  useEffect(() => {
    if (!focused.current && !timer.current) setText(item.text);
  }, [item.text]);

  const fit = () => {
    const t = el.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  };
  useLayoutEffect(fit, [text]);

  const save = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (v !== itemText.current) onTextRef.current(v);
    }, 350);
  };
  const latest = useRef(text);
  latest.current = text;
  const itemText = useRef(item.text);
  itemText.current = item.text;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const flushNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      if (latest.current !== itemText.current) onTextRef.current(latest.current);
    }
  }, []);
  useEffect(() => {
    const off = addFlusher(noteId, flushNow);
    return () => {
      off();
      flushNow();
    };
  }, [noteId, flushNow]);

  const label = item.text.trim() || "Empty item";
  return (
    <div className={cn("group/item flex items-start gap-1 rounded-md py-0.5", indented && "pl-7")}>
      {sortable && handle ? (
        <button
          type="button"
          aria-label={`Move ${label}`}
          className="mt-1 flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded note-muted opacity-40 hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover/item:opacity-100"
          {...(handle.attributes as object)}
          {...(handle.listeners as object)}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
      <input
        type="checkbox"
        checked={item.checked}
        disabled={!editable}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={item.checked ? `Untick ${label}` : `Tick ${label}`}
        className="note-check mt-[7px] shrink-0"
      />
      {editable ? (
        <textarea
          ref={(t) => {
            el.current = t;
            inputRef(t);
          }}
          rows={1}
          value={text}
          aria-label="List item"
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            flushNow();
          }}
          onChange={(e) => {
            setText(e.target.value.replace(/\n/g, " "));
            save(e.target.value.replace(/\n/g, " "));
          }}
          onKeyDown={(e) => {
            if (["Enter", "Backspace", "Tab"].includes(e.key)) flushNow();
            onKey(e, e.currentTarget);
          }}
          className={cn(
            "min-h-8 min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-1 text-[15px] leading-6 outline-none",
            item.checked && "note-muted line-through",
          )}
        />
      ) : (
        <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-[15px] leading-6", item.checked && "note-muted line-through")}>{item.text}</span>
      )}
      {editable && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full note-muted note-hover opacity-60 hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover/item:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
