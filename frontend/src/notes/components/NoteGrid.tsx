import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Archive, ArchiveRestore } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Skeleton } from "@/components/shared/Skeleton";
import { cn } from "@/utils/cn";

import type { Note, NoteUser } from "../types";
import { NoteCard, type CardActions } from "./NoteCard";

/**
 * Cards in Keep's staggered grid: left to right, each into the next column
 * (so the order reads across), as many columns as fit. Drag a card onto
 * another to move it there (within Pinned or Others). On a touch screen,
 * press and hold: let go without moving for the note's actions, or swipe a
 * card sideways to archive it. Cards glide to their new places when one is
 * added, pinned, archived or moved.
 */

const COL = 240;
const GAP = 16;

const colsFor = (w: number) => (w < 600 ? 2 : Math.max(2, Math.min(6, Math.floor((w + GAP) / (COL + GAP)))));
/** How many columns fitted last time, so the next grid (or the placeholder
 *  cards while notes load) starts with the right number instead of two. */
let lastCols: number | null = null;

const stillMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useColumns(list: boolean): [(el: HTMLDivElement | null) => void, number, number] {
  const [n, setN] = useState(() => (list ? 1 : lastCols ?? 2));
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      ro.current?.disconnect();
      if (!el) return;
      const measure = () => {
        const w = el.clientWidth;
        setWidth(w);
        if (list) return setN(1);
        lastCols = colsFor(w);
        setN(lastCols);
      };
      measure();
      ro.current = new ResizeObserver(measure);
      ro.current.observe(el);
    },
    [list],
  );
  return [ref, n, width];
}

/** Placeholder cards in the grid's shape while your notes load. */
export function NoteGridSkeleton({ layout, label = "Loading your notes…" }: { layout: "grid" | "list"; label?: string }) {
  const [ref, cols] = useColumns(layout === "list");
  const lines = [3, 5, 2, 4, 2, 6, 3, 4, 5, 2, 3, 4];
  const count = layout === "list" ? 4 : Math.min(lines.length, cols * 3);
  return (
    <div ref={ref} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className={cn("flex items-start", layout === "list" && "mx-auto max-w-[600px]")} style={{ gap: GAP }} aria-hidden>
        {Array.from({ length: cols }, (_, c) => (
          <div key={c} className="flex min-w-0 flex-1 flex-col" style={{ gap: layout === "list" ? 10 : GAP }}>
            {lines.slice(0, count).map((n, i) =>
              i % cols === c ? (
                <div key={i} className="note-c flex flex-col gap-2.5 rounded-xl border px-4 py-3.5">
                  <Skeleton className="h-4 w-3/5" />
                  {Array.from({ length: n }, (_, l) => (
                    <Skeleton key={l} className={cn("h-3", l === n - 1 ? "w-2/5" : l % 2 ? "w-11/12" : "w-full")} />
                  ))}
                </div>
              ) : null,
            )}
          </div>
        ))}
      </div>
    </div>
  );
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
  const [ref, cols, width] = useColumns(layout === "list");
  // Fewer notes than columns: only as many columns as there are notes,
  // centred under "Take a note…", instead of a row hugging the left edge.
  const most = Math.max(1, ...sections.map((s) => s.notes.length));
  const used = layout === "grid" && width >= 600 ? Math.min(cols, most) : cols;
  const colWidth = (width - (cols - 1) * GAP) / cols;
  const narrowTo = used < cols && width > 0 ? used * colWidth + (used - 1) * GAP : undefined;
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
      // Press and hold without moving: the note's actions (or, where there
      // is no sheet for them, select it).
      if (actions.menu) actions.menu(a);
      else actions.select(a, "toggle");
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

  // Cards glide to where they now belong (and a new one fades in) instead
  // of jumping. Where each card sat is remembered from the last render.
  const outer = useRef<HTMLDivElement | null>(null);
  const seen = useRef<{ at: Map<string, { x: number; y: number }>; cols: number; layout: string } | null>(null);
  useLayoutEffect(() => {
    const root = outer.current;
    if (!root) return;
    const els = root.querySelectorAll<HTMLElement>("[data-glide]");
    if (els.length > 200) {
      seen.current = null;
      return;
    }
    const at = new Map<string, { x: number; y: number }>();
    els.forEach((el) => at.set(el.dataset.glide ?? "", { x: el.offsetLeft, y: el.offsetTop }));
    const prev = seen.current;
    seen.current = { at, cols, layout };
    if (!prev || prev.cols !== cols || prev.layout !== layout || active || stillMotion()) return;
    let added = 0;
    for (const id of at.keys()) if (!prev.at.has(id)) added++;
    if (added > 3) return; // another list altogether (a search, another page)
    els.forEach((el) => {
      if (typeof el.animate !== "function") return;
      const now = at.get(el.dataset.glide ?? "");
      const was = prev.at.get(el.dataset.glide ?? "");
      if (!now) return;
      if (!was) {
        el.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
        return;
      }
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (!dx && !dy) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    });
  });

  const setOuter = useCallback(
    (el: HTMLDivElement | null) => {
      outer.current = el;
      ref(el);
    },
    [ref],
  );
  const hold = (id: string) => {
    endedAt.current = Date.now();
    actions.menu?.(id);
  };

  const body = (
    <div ref={setOuter} className="relative">
     <div className="mx-auto flex flex-col gap-6" style={{ maxWidth: narrowTo }}>
      {sections.map((s) =>
        s.notes.length ? (
          <section key={s.key} aria-label={s.title ?? "Notes"}>
            {s.title && <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{s.title}</h2>}
            <div className={cn("flex items-start", layout === "list" ? "mx-auto max-w-[600px]" : "")} style={{ gap: GAP }}>
              {Array.from({ length: used }, (_, c) => (
                <ul key={c} className="flex min-w-0 flex-1 flex-col" style={{ gap: layout === "list" ? 10 : GAP }}>
                  {s.notes
                    .filter((_, i) => i % used === c)
                    .map((n) => (
                      <li key={n.id} data-glide={n.id} className="relative list-none">
                        <DraggableCard
                          note={n}
                          enabled={canDrag && !selecting}
                          dropTarget={over === n.id && active !== n.id}
                          dimmed={active === n.id}
                          onSwipe={trash || selecting || active ? undefined : () => actions.archive(n.id, !n.archived)}
                          onHold={canDrag || selecting || !actions.menu ? undefined : () => hold(n.id)}
                          onTouched={() => (endedAt.current = Date.now())}
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

type CardTouch = { x: number; y: number; at: number; mode: "?" | "swipe" | "no"; dx: number; timer?: number; held?: boolean };

function DraggableCard({
  note,
  enabled,
  dimmed,
  onSwipe,
  onHold,
  onTouched,
  children,
}: {
  note: Note;
  enabled: boolean;
  dropTarget: boolean;
  dimmed: boolean;
  /** A finger swiped the card off sideways (archive, with its Undo). */
  onSwipe?: () => void;
  /** A finger held still on the card (where dragging isn't doing that job). */
  onHold?: () => void;
  /** A swipe or hold just ended: the tap that follows isn't "open". */
  onTouched: () => void;
  children: (handle?: Record<string, unknown>) => React.ReactNode;
}) {
  const drag = useDraggable({ id: note.id, disabled: !enabled });
  const drop = useDroppable({ id: note.id, disabled: !enabled });
  const el = useRef<HTMLDivElement | null>(null);
  const under = useRef<HTMLDivElement>(null);
  const touch = useRef<CardTouch | null>(null);
  const settle = (smooth: boolean) => {
    const n = el.current;
    if (under.current) under.current.style.opacity = "0";
    if (!n) return;
    n.style.transition = smooth ? "transform 160ms ease-out, opacity 160ms ease-out" : "";
    n.style.transform = "";
    n.style.opacity = "";
  };
  useEffect(() => () => window.clearTimeout(touch.current?.timer), []);

  const touchable = !!onSwipe || !!onHold;
  const handlers = touchable
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          window.clearTimeout(touch.current?.timer);
          touch.current = null;
          const p = e.touches[0];
          // One finger, and not from the very edge (that's the system's Back).
          if (e.touches.length !== 1 || p.clientX < 24 || p.clientX > window.innerWidth - 24) return;
          const t: CardTouch = { x: p.clientX, y: p.clientY, at: Date.now(), mode: "?", dx: 0 };
          if (onHold) {
            t.timer = window.setTimeout(() => {
              if (touch.current !== t || t.mode !== "?") return;
              t.mode = "no";
              t.held = true;
              onHold();
            }, 500);
          }
          touch.current = t;
        },
        onTouchMove: (e: React.TouchEvent) => {
          const t = touch.current;
          const n = el.current;
          if (!t || !n || t.mode === "no") return;
          const p = e.touches[0];
          const dx = p.clientX - t.x;
          const dy = p.clientY - t.y;
          if (t.mode === "?") {
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) window.clearTimeout(t.timer);
            if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
              t.mode = "no"; // scrolling the page
              return;
            }
            if (Math.abs(dx) <= 12 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
            // Sideways after a long hold is a drag to reorder, not a swipe.
            if (!onSwipe || Date.now() - t.at > 400) {
              t.mode = "no";
              return;
            }
            t.mode = "swipe";
            n.style.transition = "none";
          }
          t.dx = dx;
          n.style.transform = `translateX(${dx}px)`;
          n.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / (n.offsetWidth * 1.4)));
          if (under.current) {
            under.current.style.opacity = "1";
            under.current.style.justifyContent = dx > 0 ? "flex-start" : "flex-end";
          }
        },
        onTouchEnd: () => {
          const t = touch.current;
          touch.current = null;
          if (!t) return;
          window.clearTimeout(t.timer);
          if (t.held) onTouched();
          if (t.mode !== "swipe") return;
          onTouched();
          const n = el.current;
          if (!n || !onSwipe || Math.abs(t.dx) < Math.min(140, n.offsetWidth * 0.4)) return settle(true);
          n.style.transition = "transform 150ms ease-in, opacity 150ms ease-in";
          n.style.transform = `translateX(${t.dx > 0 ? "110%" : "-110%"})`;
          n.style.opacity = "0";
          window.setTimeout(() => {
            onSwipe();
            // Still here (it didn't leave this list)? Put it back.
            window.setTimeout(() => settle(false), 500);
          }, 150);
        },
        onTouchCancel: () => {
          window.clearTimeout(touch.current?.timer);
          const swiping = touch.current?.mode === "swipe";
          touch.current = null;
          if (swiping) settle(true);
        },
      }
    : {};
  return (
    <>
      {onSwipe && (
        <div ref={under} aria-hidden className="pointer-events-none absolute inset-0 flex items-center rounded-xl bg-[var(--hover-strong)] px-4 text-xs font-medium text-[var(--text-muted)] opacity-0">
          <span className="flex items-center gap-1.5">
            {note.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            {note.archived ? "Unarchive" : "Archive"}
          </span>
        </div>
      )}
      <div
        ref={(node) => {
          el.current = node;
          drag.setNodeRef(node);
          drop.setNodeRef(node);
        }}
        className={cn("relative", onSwipe && "touch-pan-y", dimmed && "opacity-30")}
        {...handlers}
      >
        {/* Only the pointer listeners: the card's own buttons stay the keyboard way in. */}
        {children(enabled ? (drag.listeners as Record<string, unknown>) : undefined)}
      </div>
    </>
  );
}
