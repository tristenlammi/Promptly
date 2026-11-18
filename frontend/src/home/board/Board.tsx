import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { homeApi, type Home } from "@/api/home";
import { Skeleton } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { AddWidgetSheet } from "./AddWidgetSheet";
import {
  added,
  changed,
  DEFAULT,
  find,
  gone,
  MAX_WIDGETS,
  move,
  nameOf,
  resized,
  restRooms,
  roomsOf,
  same,
  SIZE_WORDS,
  sizesOf,
  startingLayout,
  tidy,
  without,
  type Widget,
} from "./layout";
import { RoomSection } from "./RoomSection";
import { DeviceWidget, GoneWidget, GroupWidget, MusicWidget, ScenesWidget } from "./widgets";

/**
 * The home's page as widgets, in the person's own order and sizes.
 *
 * Until they customise it there is one widget, "everything else", which is
 * the page as it always was: every room, in the order set under Rooms.
 * "Customise this page" turns each room into a widget of its own that can be
 * dragged (by its handle, with a finger, a mouse, or Space and the arrow
 * keys), made bigger or smaller, or taken off, and adds others: one device,
 * a group picked by hand, scenes, music. "Done" saves it for this person in
 * this home, on every device they use; "Reset" brings the page back as it
 * came.
 *
 * The grid is two columns on a phone and four from a tablet up: small is one
 * column, medium two, large the whole row.
 */

const layoutKey = (homeId: string) => ["home", "layout", homeId];

const quiet =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const primary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const tool =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

const SPAN: Record<Widget["size"], string> = { s: "col-span-1", m: "col-span-2", l: "col-span-2 sm:col-span-4" };

export function Board({
  home,
  onOpen,
  onSort,
  customise = 0,
}: {
  home: Home;
  /** Open a device's controls. */
  onOpen: (key: string) => void;
  onSort: () => void;
  /** Goes up by one each time "Customise this page" is pressed in the page's header. */
  customise?: number;
}) {
  const qc = useQueryClient();
  const key = layoutKey(home.id);
  const { data: saved = null, isPending } = useQuery({ queryKey: key, queryFn: () => homeApi.layout(home.id).then(tidy), staleTime: 60_000 });
  // The layout being customised; ``null`` when the page is just being used.
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const [from, setFrom] = useState<Widget[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Widget | null>(null);
  const [sure, setSure] = useState(false);

  const save = useMutation({
    mutationFn: (widgets: Widget[]) => homeApi.saveLayout(home.id, widgets),
    onSuccess: (_r, widgets) => {
      qc.setQueryData(key, widgets);
      setDraft(null);
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save your page. Try again.")),
  });
  const reset = useMutation({
    mutationFn: () => homeApi.resetLayout(home.id),
    onSuccess: () => {
      qc.setQueryData(key, null);
      setDraft(null);
      setSure(false);
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't reset your page. Try again.")),
  });
  // A small change made while using the page (a speaker picked, a gone widget taken off): saved quietly.
  const patch = useMutation({
    mutationFn: (widgets: Widget[]) => homeApi.saveLayout(home.id, widgets),
    onMutate: (widgets) => qc.setQueryData(key, widgets),
    onError: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const widgets = draft ?? saved ?? DEFAULT;
  const custom = draft !== null;
  const begin = () => {
    const start = saved ?? startingLayout(home);
    setFrom(start);
    setDraft(start);
    setSure(false);
  };
  // The header's button starts it (once the saved page is known; pressing it again while customising does nothing).
  const asked = useRef(customise);
  useEffect(() => {
    if (customise === asked.current || isPending) return;
    asked.current = customise;
    if (draft === null && home.entities.length > 0) begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customise, isPending]);
  const done = () => {
    if (!draft) return;
    // Nothing moved: leave the page as it comes (so it keeps following Rooms).
    if (same(draft, from)) setDraft(null);
    else save.mutate(draft);
  };
  const dropped = (ev: DragEndEvent) => {
    if (ev.over && ev.active.id !== ev.over.id) setDraft((d) => (d ? move(d, String(ev.active.id), String(ev.over!.id)) : d));
  };

  const rooms = useMemo(() => roomsOf(home), [home]);
  const rest = useMemo(() => restRooms(home, widgets), [home, widgets]);

  /** What a widget draws, or ``null`` for nothing at all (so it takes no room on the page). */
  const draw = (w: Widget): ReactNode => {
    if (gone(home, w)) {
      return <GoneWidget name={nameOf(home, w)} what={w.type === "room" ? "room" : w.type === "device" ? "device" : "devices"} onRemove={custom || saved === null ? undefined : () => patch.mutate(without(saved, w.id))} />;
    }
    if (w.type === "rest") {
      if (rest.length === 0) return null;
      return <div className="flex flex-col gap-5">{rest.map((r) => <RoomSection key={r.id || "none"} home={home} {...r} onOpen={onOpen} onSort={onSort} />)}</div>;
    }
    if (w.type === "room") {
      const r = rooms.find((x) => x.id === (w.area ?? ""));
      // A room with nothing in it (yet, or any more) shows nothing, as it never did.
      return r ? <RoomSection home={home} {...r} narrow={w.size !== "l"} onOpen={onOpen} onSort={onSort} /> : null;
    }
    if (w.type === "device") {
      const e = find(home, w.key);
      return e ? <DeviceWidget home={home} entity={e} size={w.size} onOpen={() => onOpen(w.key!)} /> : null;
    }
    if (w.type === "scenes") return (w.items?.length ?? 0) > 0 && home.entities.length > 0 ? <ScenesWidget home={home} widget={w} /> : null;
    if (w.type === "group") return <GroupWidget home={home} widget={w} onOpen={onOpen} />;
    return <MusicWidget home={home} widget={w} onOpen={onOpen} onPick={saved && !custom ? (k) => patch.mutate(changed(saved, w.id, { key: k })) : undefined} />;
  };

  const grid = "grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4";

  // Not the page as it comes and then the person's own a moment later: wait for theirs.
  if (isPending) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
      </div>
    );
  }
  if (!custom) {
    const cells = widgets.map((w) => ({ w, body: draw(w) })).filter((c) => c.body !== null);
    return (
      <>
        {cells.length > 0 && (
          <div className={grid} data-testid="home-board">
            {cells.map(({ w, body }) => <div key={w.id} className={cn("min-w-0", SPAN[w.size])} data-widget={w.type}>{body}</div>)}
          </div>
        )}
        {saved !== null && cells.length === 0 && home.entities.length > 0 && (
          <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">Your page has nothing on it. Customise it to add a widget, or reset it.</p>
        )}
      </>
    );
  }

  const full = widgets.length >= MAX_WIDGETS;
  return (
    <>
      <div role="region" aria-label="Customise this page" className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <p className="text-sm text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text)]">Customising your page. </span>
          Drag a widget by its handle to move it. This is your own page: nobody else's changes.
        </p>
        {sure ? (
          <div role="alertdialog" aria-label="Reset your page?" className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 basis-48 text-sm font-medium text-[var(--text)]">Put the page back as it came? Your widgets go.</p>
            <button type="button" className={quiet} onClick={() => setSure(false)}>Keep it</button>
            <button type="button" className={primary} disabled={reset.isPending} onClick={() => reset.mutate()}>{reset.isPending ? "Resetting…" : "Reset"}</button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} disabled={full} onClick={() => { setEditing(null); setAdding(true); }}><Plus className="h-4 w-4" aria-hidden /> Add a widget</button>
            <span className="flex-1" />
            {saved !== null && <button type="button" className={quiet} onClick={() => setSure(true)}>Reset</button>}
            <button type="button" className={quiet} onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className={primary} disabled={save.isPending} onClick={done}>{save.isPending ? "Saving…" : "Done"}</button>
          </div>
        )}
      </div>
      {widgets.length === 0 && <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">Nothing on your page yet. Add a widget.</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dropped}>
        <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
          <ul className={cn(grid, "gap-y-3")} aria-label="Your widgets" data-testid="home-board">
            {widgets.map((w) => (
              <Frame
                key={w.id}
                widget={w}
                name={nameOf(home, w)}
                onSize={sizesOf(w).length > 1 ? () => setDraft((d) => d && resized(d, w.id)) : undefined}
                onEdit={(w.type === "group" || w.type === "scenes") && !gone(home, w) ? () => { setEditing(w); setAdding(true); } : undefined}
                onRemove={() => setDraft((d) => d && without(d, w.id))}
              >
                {draw(w) ?? (
                  <p className="px-1 py-2 text-sm text-[var(--text-muted)]">
                    {w.type === "rest" ? "Rooms that have no widget of their own show here. There are none right now." : "Nothing to show here right now."}
                  </p>
                )}
              </Frame>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {widgets.length > 3 && (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={quiet} disabled={full} onClick={() => { setEditing(null); setAdding(true); }}><Plus className="h-4 w-4" aria-hidden /> Add a widget</button>
          <button type="button" className={primary} disabled={save.isPending} onClick={done}>{save.isPending ? "Saving…" : "Done"}</button>
        </div>
      )}
      <AddWidgetSheet
        open={adding}
        home={home}
        widgets={widgets}
        editing={editing}
        onClose={() => setAdding(false)}
        onAdd={(w) => setDraft((d) => d && added(d, w))}
        onChange={(id, to) => setDraft((d) => d && changed(d, id, to))}
      />
    </>
  );
}

/** One widget while the page is being customised: a bar to move, size, change and remove it, and a look at what it shows. */
function Frame({ widget, name, onSize, onEdit, onRemove, children }: { widget: Widget; name: string; onSize?: () => void; onEdit?: () => void; onRemove: () => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-widget={widget.type}
      data-size={widget.size}
      className={cn("flex min-w-0 list-none flex-col overflow-hidden rounded-2xl border border-dashed border-[var(--text-muted)]/60 bg-[var(--bg)]", SPAN[widget.size], isDragging && "relative z-10 opacity-90 shadow-lg")}
    >
      <div className="flex items-center border-b border-dashed border-[var(--text-muted)]/40 bg-[var(--surface)]">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move ${name}`}
          title="Drag to move"
          className="flex h-10 min-w-10 flex-1 cursor-grab touch-none items-center gap-1 rounded-lg pl-2 text-left text-xs font-medium text-[var(--text)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
        >
          <GripVertical className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <span className="min-w-0 truncate">{name}</span>
        </button>
        {onSize && (
          <button type="button" onClick={onSize} aria-label={`${name}: size ${SIZE_WORDS[widget.size].toLowerCase()}. Change size`} title={`${SIZE_WORDS[widget.size]}. Tap to change size`} className={cn(tool, "text-xs font-semibold")}>
            {widget.size.toUpperCase()}
          </button>
        )}
        {onEdit && (
          <button type="button" onClick={onEdit} aria-label={`Change what's in ${name}`} title="Change what's in it" className={tool}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        )}
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove" className={tool}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {/* A look at it only: nothing in here can be pressed while customising. */}
      <div {...{ inert: "" }} aria-hidden className="pointer-events-none max-h-44 select-none overflow-hidden p-2 opacity-80">
        {children}
      </div>
    </li>
  );
}
