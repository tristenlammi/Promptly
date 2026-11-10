import { AtSign, MapPin } from "lucide-react";
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { StoryOverlay } from "@/api/porch";
import { cn } from "@/utils/cn";

/** A sticker being placed in the composer (``key`` keeps React's place). */
export type EditOverlay = StoryOverlay & { key: string };

/** What a sticker says, for screen readers and the composer's list. */
export function overlayWords(o: StoryOverlay): string {
  if (o.type === "text") return o.text;
  if (o.type === "mention") return `@${o.user.name}`;
  return o.place.name;
}

/** One sticker's look: text in one of three styles, an @mention or a place pill. */
function Chip({ o }: { o: StoryOverlay }) {
  // Sizes in container units, so a sticker keeps its place and size on any screen.
  const size: CSSProperties = { fontSize: `calc(${(o.type === "text" ? 6.4 : 4.6) * o.scale}cqw)` };
  if (o.type === "mention" || o.type === "place") {
    const Icon = o.type === "mention" ? AtSign : MapPin;
    return (
      <span
        style={size}
        className="inline-flex max-w-[78cqw] items-center gap-[0.3em] rounded-[0.6em] bg-white/95 px-[0.55em] py-[0.3em] font-semibold leading-tight text-[#1A1A19] shadow-md"
      >
        <Icon className="h-[1em] w-[1em] shrink-0 text-[#C2410C]" aria-hidden />
        <span className="truncate">{o.type === "mention" ? o.user.name : o.place.name}</span>
      </span>
    );
  }
  if (o.style === "box") {
    return (
      <span style={size} className="inline-block max-w-[80cqw] whitespace-pre-wrap break-words rounded-[0.4em] bg-white px-[0.45em] py-[0.2em] text-center font-semibold leading-snug text-[#1A1A19] shadow-md">
        {o.text}
      </span>
    );
  }
  return (
    <span
      style={{ ...size, textShadow: "0 1px 3px rgba(0,0,0,.55), 0 0 1px rgba(0,0,0,.6)" }}
      className={cn(
        "inline-block max-w-[80cqw] whitespace-pre-wrap break-words text-center leading-snug text-white",
        o.style === "bold" ? "font-black uppercase tracking-tight" : "font-semibold",
      )}
    >
      {o.text}
    </span>
  );
}

function place(o: StoryOverlay): CSSProperties {
  return { left: `${o.x * 100}%`, top: `${o.y * 100}%`, transform: `translate(-50%, -50%) rotate(${o.rotate}deg)` };
}

/** Stickers over a story, as everyone sees them. A mention or place opens on tap (``onOpen``). */
export function OverlayView({ overlays, onOpen }: { overlays: StoryOverlay[]; onOpen?: (o: StoryOverlay) => void }) {
  if (!overlays.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ containerType: "inline-size" }}>
      {overlays.map((o, i) => {
        const clickable = !!onOpen && o.type !== "text";
        return clickable ? (
          <button
            key={i}
            type="button"
            data-story-control
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.(o);
            }}
            className="pointer-events-auto absolute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={place(o)}
            aria-label={o.type === "mention" ? `${o.user.name}'s profile` : `${o.place.name} on the map`}
          >
            <Chip o={o} />
          </button>
        ) : (
          <span key={i} className="absolute" style={place(o)}>
            <Chip o={o} />
          </span>
        );
      })}
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Stickers you're placing: drag to move, pinch (or the size buttons, or
 * + / −) to resize and turn with two fingers. Arrow keys move the one
 * that's selected; Delete takes it off.
 */
export function OverlayEditor({
  overlays,
  onChange,
  selected,
  onSelect,
}: {
  overlays: EditOverlay[];
  onChange: (next: EditOverlay[]) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ o: EditOverlay; pts: { x: number; y: number }[] } | null>(null);
  const latest = useRef(overlays);
  latest.current = overlays;

  const update = (key: string, patch: Partial<StoryOverlay>) =>
    onChange(latest.current.map((o) => (o.key === key ? ({ ...o, ...patch } as EditOverlay) : o)));

  const down = (e: ReactPointerEvent, o: EditOverlay) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start.current = { o: latest.current.find((x) => x.key === o.key) ?? o, pts: [...pointers.current.values()] };
    onSelect(o.key);
  };
  const move = (e: ReactPointerEvent, key: string) => {
    if (!pointers.current.has(e.pointerId) || !start.current || !box.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = box.current.getBoundingClientRect();
    const pts = [...pointers.current.values()];
    const s = start.current;
    if (pts.length === 1 && s.pts.length === 1) {
      update(key, {
        x: clamp(s.o.x + (pts[0].x - s.pts[0].x) / rect.width, 0.02, 0.98),
        y: clamp(s.o.y + (pts[0].y - s.pts[0].y) / rect.height, 0.02, 0.98),
      });
    } else if (pts.length >= 2 && s.pts.length >= 2) {
      const d0 = Math.hypot(s.pts[1].x - s.pts[0].x, s.pts[1].y - s.pts[0].y) || 1;
      const d1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const a0 = Math.atan2(s.pts[1].y - s.pts[0].y, s.pts[1].x - s.pts[0].x);
      const a1 = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      let rot = s.o.rotate + ((a1 - a0) * 180) / Math.PI;
      rot = ((rot + 540) % 360) - 180;
      update(key, { scale: clamp(s.o.scale * (d1 / d0), 0.4, 3.5), rotate: Math.round(rot) });
    }
  };
  const up = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    const left = [...pointers.current.values()];
    const cur = start.current ? latest.current.find((x) => x.key === start.current?.o.key) : undefined;
    start.current = left.length && cur ? { o: cur, pts: left } : null;
  };
  const key = (e: KeyboardEvent, o: EditOverlay) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      update(o.key, { x: clamp(o.x + moves[e.key][0], 0.02, 0.98), y: clamp(o.y + moves[e.key][1], 0.02, 0.98) });
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      update(o.key, { scale: clamp(o.scale * 1.15, 0.4, 3.5) });
    } else if (e.key === "-") {
      e.preventDefault();
      update(o.key, { scale: clamp(o.scale / 1.15, 0.4, 3.5) });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onChange(latest.current.filter((x) => x.key !== o.key));
      onSelect(null);
    }
  };

  return (
    // The layer lets taps through to the photo or the words underneath; only the stickers take them.
    <div ref={box} className="pointer-events-none absolute inset-0" style={{ containerType: "inline-size" }}>
      {overlays.map((o) => (
        <div
          key={o.key}
          role="button"
          data-sticker
          tabIndex={0}
          aria-pressed={selected === o.key}
          aria-label={`Sticker: ${overlayWords(o)}. Drag to move; arrow keys move it, plus and minus resize, Delete removes.`}
          onPointerDown={(e) => down(e, o)}
          onPointerMove={(e) => move(e, o.key)}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={(e) => key(e, o)}
          onFocus={() => onSelect(o.key)}
          className={cn(
            "pointer-events-auto absolute cursor-grab touch-none select-none rounded-lg p-1 focus-visible:outline-none active:cursor-grabbing",
            selected === o.key && "outline-dashed outline-2 outline-offset-2 outline-white/90",
          )}
          style={place(o)}
        >
          <Chip o={o} />
        </div>
      ))}
    </div>
  );
}
