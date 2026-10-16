import type * as Y from "yjs";

/** Slides-lite (Stage 12): a whiteboard in slide mode. Excalidraw frames
 *  are the slides; what makes it a deck, the slides' order and each
 *  slide's speaker notes live in the whiteboard's own Y.Doc, so they sync
 *  and save with the drawing:
 *
 *    deck  (Y.Map)  mode: "slides", order: string[] (frame ids)
 *    notes (Y.Map)  <frame id> → speaker notes (plain text)
 */

export const SLIDE_W = 1600;
export const SLIDE_H = 900;
export const SLIDE_GAP = 200;

export interface FrameLike {
  id: string;
  type: string;
  name?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  frameId?: string | null;
  version?: number;
}

export const deckMap = (ydoc: Y.Doc) => ydoc.getMap<unknown>("deck");
export const notesMap = (ydoc: Y.Doc) => ydoc.getMap<string>("notes");

export function isDeck(ydoc: Y.Doc | null): boolean {
  return !!ydoc && deckMap(ydoc).get("mode") === "slides";
}

export function deckOrder(ydoc: Y.Doc): string[] {
  const o = deckMap(ydoc).get("order");
  return Array.isArray(o) ? (o as string[]) : [];
}

/** The slides, in order: frames listed in the deck's order first, then any
 *  other frame by where it is (top to bottom, left to right). */
export function slidesOf<T extends FrameLike>(elements: readonly T[], order: string[]): T[] {
  const frames = elements.filter((e) => e.type === "frame" && !e.isDeleted);
  const at = new Map(order.map((id, i) => [id, i]));
  return [...frames].sort((a, b) => {
    const ia = at.get(a.id);
    const ib = at.get(b.id);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return Math.round(a.y / 50) - Math.round(b.y / 50) || a.x - b.x;
  });
}

/** Where a new slide goes: to the right of the last one. */
export function nextSlidePosition(slides: readonly FrameLike[]): { x: number; y: number } {
  if (!slides.length) return { x: 0, y: 0 };
  const last = slides[slides.length - 1];
  return { x: last.x + last.width + SLIDE_GAP, y: last.y };
}

/** A version key for a slide's look: the frame and everything in it. */
export function slideKey(frame: FrameLike, elements: readonly FrameLike[]): string {
  let n = frame.version ?? 0;
  let c = 0;
  for (const e of elements) {
    if (e.frameId === frame.id) {
      n += (e.version ?? 0) * 31 + (e.isDeleted ? 7 : 0);
      c += 1;
    }
  }
  return `${frame.id}:${n}:${c}:${frame.width}x${frame.height}`;
}
