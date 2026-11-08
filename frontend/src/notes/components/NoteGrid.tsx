import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/utils/cn";

import type { Note, NoteUser } from "../types";
import { NoteCard, type CardActions } from "./NoteCard";

/**
 * Cards in Keep's staggered grid: left to right, each into the next column
 * (so the order reads across), as many columns as fit. Drag a card onto
 * another to move it there (within Pinned or Others). On a touch screen,
 * press and hold: let go without moving to select it instead.
 */

const COL = 240;
const GAP = 16;

function useColumns(list: boolean): [(el: HTMLDivElement | null) => void, number] {
  const [n, setN] = useState(2);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      ro.current?.disconnect();
      if (!el) return;
      const measure = () => {
        const w = el.clientWidth;
        if (list) return setN(1);
        setN(w < 600 ? 2 : Math.max(2, Math.min(6, Math.floor((w + GAP) / (COL + GAP)))));
      };
      measure();
      ro.current = new ResizeObserver(measure);
      ro.current.observe(el);
    },
    [list],
  );
  return [ref, n];
}

export function NoteGrid({
  sections,
  users,
  selected,
  pending,
  actions,
  layout,
  trash,
  onMove,
}: {
  sections: { key: string; title?: string; notes: Note[] }[];
  users: Record<string, NoteUser>;
  selected: Set<string>;
  pending: Set<string>;
  actions: CardActions;
  layout: "grid" | "list";
  trash?: boolean;
  /** Put ``id`` where ``over`` is (same section). */
  onMove?: (id: string, overId: string, section: string) => void;
}) {
  const [ref, cols] = useColumns(layout === "list");
  const [active, setActive] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 450, tolerance: 8 } }),
  );
  const sectionOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sections) for (const n of s.notes) m.set(n.id, s.key);
    return m;
  }, [sections]);
  const all = useMemo(() => new Map(sections.flatMap((s) => s.notes.map((n) => [n.id, n] as const))), [sections]);
  const selecting = selected.size > 0;
  // The click that ends a press-and-hold mustn't also open the note.
  const endedAt = useRef(0);
  const cardActions = useMemo<CardActions>(
    () => ({
      ...actions,
      open: (id) => Date.now() - endedAt.current > 400 && actions.open(id),
      select: (id, how) => Date.now() - endedAt.current > 400 && actions.select(id, how),
    }),
    [actions],
  );
  const canDrag = !!onMove && !trash;

  const detect: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    return hits.length ? hits : rectIntersection(args);
  };

  const onStart = (e: DragStartEvent) => setActive(String(e.active.id));
  const onEnd = (e: DragEndEvent) => {
    const a = String(e.active.id);
    const o = e.over ? String(e.over.id) : null;
    endedAt.current = Date.now();
    setActive(null);
    setOver(null);
    const touch = e.activatorEvent instanceof TouchEvent || (e.activatorEvent as PointerEvent | undefined)?.pointerType === "touch";
    const moved = Math.abs(e.delta.x) + Math.abs(e.delta.y) > 12;
    if (touch && !moved) {
      // Press and hold without moving: select it (Keep on a phone).
      actions.select(a, "toggle");
      return;
    }
    if (!o || o === a || sectionOf.get(a) !== sectionOf.get(o)) return;
    onMove?.(a, o, sectionOf.get(a) ?? "");
  };

  useEffect(() => {
    if (!active) return;
    const stop = (ev: KeyboardEvent) => ev.key === "Escape" && setActive(null);
    window.addEventListener("keydown", stop);
    return () => window.removeEventListener("keydown", stop);
  }, [active]);

  const body = (
    <div ref={ref} className="flex flex-col gap-6">
      {sections.map((s) =>
        s.notes.length ? (
          <section key={s.key} aria-label={s.title ?? "Notes"}>
            {s.title && <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{s.title}</h2>}
            <div className={cn("flex items-start", layout === "list" ? "mx-auto max-w-[600px]" : "")} style={{ gap: GAP }}>
              {Array.from({ length: cols }, (_, c) => (
                <ul key={c} className="flex min-w-0 flex-1 flex-col" style={{ gap: layout === "list" ? 10 : GAP }}>
                  {s.notes
                    .filter((_, i) => i % cols === c)
                    .map((n) => (
                      <li key={n.id} className="list-none">
                        <DraggableCard
                          note={n}
                          enabled={canDrag && !selecting}
                          dropTarget={over === n.id && active !== n.id}
                          dimmed={active === n.id}
                        >
                          {(handle) => (
                            <NoteCard
                              note={n}
                              users={users}
                              selected={selected.has(n.id)}
                              selecting={selecting}
                              trash={!!trash}
                              pending={pending.has(n.id)}
                              actions={cardActions}
                              dragHandle={handle}
                              dropTarget={over === n.id && active !== n.id}
                            />
                          )}
                        </DraggableCard>
                      </li>
                    ))}
                </ul>
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );

  if (!canDrag) return body;
  const dragged = active ? all.get(active) : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={detect}
      onDragStart={onStart}
      onDragOver={(e) => setOver(e.over ? String(e.over.id) : null)}
      onDragCancel={() => {
        setActive(null);
        setOver(null);
      }}
      onDragEnd={onEnd}
      accessibility={{ screenReaderInstructions: { draggable: "" } }}
    >
      {body}
      <DragOverlay dropAnimation={null}>
        {dragged ? (
          <div className="rotate-1 opacity-95 shadow-[var(--shadow-lg)]" style={{ width: COL }}>
            <NoteCard note={dragged} users={users} selected={false} selecting={false} trash={false} pending={false} actions={actions} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DraggableCard({
  note,
  enabled,
  dimmed,
  children,
}: {
  note: Note;
  enabled: boolean;
  dropTarget: boolean;
  dimmed: boolean;
  children: (handle?: Record<string, unknown>) => React.ReactNode;
}) {
  const drag = useDraggable({ id: note.id, disabled: !enabled });
  const drop = useDroppable({ id: note.id, disabled: !enabled });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      className={cn(dimmed && "opacity-30")}
    >
      {/* Only the pointer listeners: the card's own buttons stay the keyboard way in. */}
      {children(enabled ? (drag.listeners as Record<string, unknown>) : undefined)}
    </div>
  );
}
