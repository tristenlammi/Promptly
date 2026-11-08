import { ChevronLeft, ChevronRight, ImagePlus, SlidersHorizontal, X } from "lucide-react";
import { useRef, useState } from "react";

import type { EditOps, PhotoItem } from "@/api/photos";
import { PhotoEditor } from "@/components/photos/PhotoEditor";
import { presetOf } from "@/components/photos/filterPresets";
import { ItemButton, TextArea } from "@/items/ui";
import { cn } from "@/utils/cn";

import { moveItem, type Pick } from "./model";
import { PickImage } from "./PickImage";

function asPhotoItem(p: Pick): PhotoItem {
  return {
    id: p.fileId as string,
    filename: p.name,
    mime: p.kind === "video" ? "video/mp4" : "image/jpeg",
    kind: p.kind,
    taken_at: "",
    taken_local: "",
    width: p.width,
    height: p.height,
    duration_ms: p.durationMs,
    thumbhash: p.thumbhash,
    live: false,
    favorite: false,
    archived: false,
    thumb: null,
    state: null,
    mine: true,
  };
}

function editWords(e: EditOps | null): string | null {
  if (!e) return null;
  const parts: string[] = [];
  if (e.crop) parts.push("cropped");
  if (e.rotate) parts.push("turned");
  if (e.flip) parts.push("flipped");
  const look = presetOf(e);
  if (look && look.id !== "normal") parts.push(look.label);
  else if (!look) parts.push("adjusted");
  return parts.length ? parts.join(", ") : null;
}

/**
 * The strip of picks: tap one to work on it; drag to put them in order
 * (a mouse straight away, a finger after a short hold, so the strip still
 * scrolls), or use "Earlier" / "Later" from the keyboard.
 */
function Strip({
  picks,
  active,
  onActive,
  onMove,
  onAdd,
  canAdd,
}: {
  picks: Pick[];
  active: number;
  onActive: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onAdd: () => void;
  canAdd: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<{ from: number; x: number; y: number; started: boolean; timer: number | null; id: number } | null>(null);
  const [over, setOver] = useState<{ from: number; to: number } | null>(null);
  const [ghostX, setGhostX] = useState(0);

  const indexAt = (x: number): number => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-pick]") ?? []);
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return items.length - 1;
  };
  const begin = (d: NonNullable<typeof drag.current>) => {
    d.started = true;
    setOver({ from: d.from, to: d.from });
  };
  const down = (i: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const d = { from: i, x: e.clientX, y: e.clientY, started: false, timer: null as number | null, id: e.pointerId };
    drag.current = d;
    if (e.pointerType !== "mouse") {
      d.timer = window.setTimeout(() => {
        if (drag.current === d) {
          (e.target as HTMLElement).setPointerCapture?.(d.id);
          begin(d);
          navigator.vibrate?.(10);
        }
      }, 260);
    }
  };
  const move = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const far = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6;
    if (!d.started) {
      if (!far) return;
      if (e.pointerType !== "mouse") {
        // A finger moving before the hold: it's a scroll.
        if (d.timer) window.clearTimeout(d.timer);
        drag.current = null;
        return;
      }
      (e.target as HTMLElement).setPointerCapture?.(d.id);
      begin(d);
    }
    e.preventDefault();
    setGhostX(e.clientX - d.x);
    setOver({ from: d.from, to: indexAt(e.clientX) });
  };
  const up = (i: number) => () => {
    const d = drag.current;
    drag.current = null;
    if (d?.timer) window.clearTimeout(d.timer);
    if (d?.started) {
      setOver((o) => {
        if (o && o.to !== o.from) onMove(o.from, o.to);
        return null;
      });
      setGhostX(0);
      return;
    }
    onActive(i);
  };
  const cancel = () => {
    const d = drag.current;
    if (d?.timer) window.clearTimeout(d.timer);
    drag.current = null;
    setOver(null);
    setGhostX(0);
  };

  return (
    <ol ref={list} aria-label="Order of photos" className="flex gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:thin] md:px-0">
      {picks.map((p, i) => {
        const dragging = over?.from === i;
        const target = over && over.to === i && over.from !== i;
        return (
          <li key={p.key} data-pick className={cn("relative shrink-0", target && (over.to > over.from ? "pr-3" : "pl-3"))}>
            {target && (
              <span aria-hidden className={cn("absolute bottom-1 top-1 w-1 rounded-full bg-[var(--item-accent)]", over.to > over.from ? "right-0.5" : "left-0.5")} />
            )}
            <button
              type="button"
              aria-label={`Photo ${i + 1} of ${picks.length}${i === active ? ", showing" : ""}`}
              aria-current={i === active ? "true" : undefined}
              onPointerDown={down(i)}
              onPointerMove={move}
              onPointerUp={up(i)}
              onPointerCancel={cancel}
              onContextMenu={(e) => over && e.preventDefault()}
              className={cn(
                "relative block h-16 w-16 select-none overflow-hidden rounded-lg border-2 transition-[box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2 md:h-[72px] md:w-[72px]",
                i === active ? "border-[var(--item-accent)]" : "border-transparent",
                dragging && "z-10 shadow-[var(--shadow-md)]",
              )}
              style={dragging ? { transform: `translateX(${ghostX}px) scale(1.06)`, touchAction: "none" } : { touchAction: over ? "none" : "pan-x" }}
            >
              <PickImage pick={p} label="" className="pointer-events-none h-full w-full" />
              <span aria-hidden className="absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/60 px-1 text-[11px] font-bold text-white">
                {i + 1}
              </span>
            </button>
          </li>
        );
      })}
      {canAdd && (
        <li className="shrink-0">
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add more photos"
            className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-dashed border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] hover:border-[var(--item-accent)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-[72px] md:w-[72px]"
          >
            <ImagePlus className="h-5 w-5" aria-hidden />
            Add
          </button>
        </li>
      )}
    </ol>
  );
}

/**
 * Step 2, Arrange: a large preview, the strip to put them in order, and for
 * each photo its own crop / filter for this post (the library photo isn't
 * changed, decision D3) and a description for screen readers, filled in from
 * Photos' own caption when it has one.
 */
export function ArrangeStep({
  picks,
  setPicks,
  active,
  setActive,
  onAdd,
  maxMedia,
  isPhone,
}: {
  picks: Pick[];
  setPicks: (fn: (p: Pick[]) => Pick[]) => void;
  active: number;
  setActive: (i: number) => void;
  onAdd: () => void;
  maxMedia: number;
  isPhone: boolean;
}) {
  const [editing, setEditing] = useState<Pick | null>(null);
  const i = Math.min(active, picks.length - 1);
  const cur = picks[i];
  if (!cur) return null;
  const update = (key: string, patch: Partial<Pick>) => setPicks((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (from: number, to: number) => {
    setPicks((ps) => moveItem(ps, from, to));
    setActive(to);
  };
  const remove = () => {
    setPicks((ps) => ps.filter((p) => p.key !== cur.key));
    setActive(Math.max(0, i - (i === picks.length - 1 ? 1 : 0)));
  };
  const words = editWords(cur.edit);
  const canEdit = cur.kind === "image" && !!cur.fileId;

  return (
    <div className="flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_280px] md:items-start md:gap-5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="relative flex aspect-[4/5] max-h-[62vh] w-full items-center justify-center overflow-hidden bg-[var(--surface-2)] md:aspect-[4/3] md:rounded-2xl">
          <PickImage key={cur.key} pick={cur} big label={cur.alt || `Photo ${i + 1}`} className="flex h-full w-full items-center justify-center bg-transparent" />
          <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
            {i + 1}/{picks.length}
          </span>
        </div>
        <Strip picks={picks} active={i} onActive={setActive} onMove={move} onAdd={onAdd} canAdd={picks.length < maxMedia} />
        {picks.length > 1 && (
          <p className="px-3 text-xs text-[var(--text-muted)] md:px-0">
            {isPhone ? "Hold and drag a photo to change the order." : "Drag a photo to change the order."} The first one leads the post.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 px-3 md:px-0">
        <div className="flex flex-wrap items-center gap-2">
          <ItemButton
            variant="secondary"
            icon={<SlidersHorizontal className="h-4 w-4" />}
            disabled={!canEdit}
            onClick={() => setEditing(cur)}
            title={cur.kind === "video" ? "Videos are posted as they are" : !cur.fileId ? "Ready once it's uploaded" : undefined}
          >
            Edit
          </ItemButton>
          {picks.length > 1 && (
            <>
              <ItemButton variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move earlier">
                <span className="sr-only md:not-sr-only">Earlier</span>
              </ItemButton>
              <ItemButton variant="ghost" icon={<ChevronRight className="h-4 w-4" />} disabled={i === picks.length - 1} onClick={() => move(i, i + 1)} aria-label="Move later">
                <span className="sr-only md:not-sr-only">Later</span>
              </ItemButton>
            </>
          )}
          <ItemButton variant="ghost" icon={<X className="h-4 w-4" />} onClick={remove} className="ml-auto text-[var(--danger)]" aria-label="Take this one out">
            <span className="sr-only md:not-sr-only">Take out</span>
          </ItemButton>
        </div>
        {words && <p className="text-xs text-[var(--text-muted)]">For this post: {words}. The photo in your library stays as it is.</p>}
        {cur.kind === "video" && <p className="text-xs text-[var(--text-muted)]">Videos are posted as they are, sized for phones.</p>}
        {cur.error && <p className="text-sm text-[var(--danger)]">Couldn't upload this one: {cur.error}</p>}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Describe this {cur.kind === "video" ? "video" : "photo"}</span>
          <TextArea
            value={cur.alt}
            onChange={(e) => update(cur.key, { alt: e.target.value, altTouched: true })}
            maxLength={1000}
            rows={3}
            placeholder="What's in it, for people using a screen reader"
          />
          <span className="text-[11px] text-[var(--text-muted)]">
            {cur.alt && !cur.altTouched ? "Filled in from Photos. Change it if you like." : "Read out to people who can't see the picture."}
          </span>
        </label>
      </div>

      {editing && editing.fileId && (
        <PhotoEditor
          photo={asPhotoItem(editing)}
          onClose={() => setEditing(null)}
          opsOnly={{
            initial: editing.edit,
            onDone: (ops) => {
              update(editing.key, { edit: ops });
              setEditing(null);
            },
          }}
        />
      )}
    </div>
  );
}
