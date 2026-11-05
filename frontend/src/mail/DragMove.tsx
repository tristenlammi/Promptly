import { Mail } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { personName, type ThreadRow } from "./api";

const START_AFTER_PX = 6;
// A small pill level with the pointer and to its right, so it never covers the row
// you're aiming at or the ones either side of it.
const BESIDE_X = 16;
const BESIDE_Y = -13;
const SETTLE_MS = 220;
const EDGE_PX = 36;

interface Hover {
  id: string;
  name: string;
  colour?: string;
}

function calm(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Drag a conversation by its row. Anything marked ``data-mail-drop`` is somewhere it
 *  can land. The card follows the pointer directly rather than through React state,
 *  so it stays smooth however long the list is. Mouse only: phones have swipes. */
export function useThreadDrag(onDrop: (row: ThreadRow, target: string) => void) {
  const [dragging, setDragging] = useState<ThreadRow | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const finish = useRef<(() => void) | null>(null);

  const start = useCallback((event: ReactPointerEvent<HTMLElement>, row: ThreadRow) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const from = event.currentTarget.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let over: Element | null = null;
    let scroller: Element | null = null;
    let scrollBy = 0;
    let frame = 0;
    let x = startX;
    let y = startY;

    const place = () => {
      if (ghost.current) ghost.current.style.transform = `translate3d(${x + BESIDE_X}px, ${y + BESIDE_Y}px, 0)`;
    };

    const scrollEdge = () => {
      if (scroller && scrollBy) scroller.scrollTop += scrollBy;
      frame = window.requestAnimationFrame(scrollEdge);
    };

    const look = () => {
      // The card ignores the pointer, so this finds what's underneath it.
      const under = document.elementFromPoint(x, y);
      const target = under?.closest("[data-mail-drop]") ?? null;
      if (target !== over) {
        over = target;
        setHover(target ? {
          id: target.getAttribute("data-mail-drop") ?? "",
          name: target.getAttribute("data-mail-drop-name") ?? "",
          colour: target.getAttribute("data-mail-drop-colour") ?? undefined,
        } : null);
      }
      const list = under?.closest("[data-mail-rail-scroll]") ?? null;
      scroller = list;
      if (list) {
        const box = list.getBoundingClientRect();
        scrollBy = y < box.top + EDGE_PX ? -6 : y > box.bottom - EDGE_PX ? 6 : 0;
      } else {
        scrollBy = 0;
      }
    };

    const stopListening = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
      window.cancelAnimationFrame(frame);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    /** Glide the card somewhere, then take it away. */
    const glide = (transform: string, fade: boolean) => {
      const card = ghost.current;
      const done = () => {
        setDragging(null);
        setHover(null);
      };
      if (!card || calm()) return done();
      card.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${SETTLE_MS}ms ease-out`;
      card.style.transform = transform;
      if (fade) card.style.opacity = "0";
      window.setTimeout(done, SETTLE_MS);
    };

    const cancel = () => {
      stopListening();
      if (active) glide(`translate3d(${from.left}px, ${from.top}px, 0)`, false);
    };

    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!active) {
        if (Math.hypot(x - startX, y - startY) < START_AFTER_PX) return;
        active = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        window.getSelection()?.removeAllRanges();
        setDragging(row);
        frame = window.requestAnimationFrame(scrollEdge);
        window.requestAnimationFrame(place);
      }
      place();
      look();
    };

    const onUp = () => {
      stopListening();
      if (!active) return;
      // The release lands on the row as a click: that shouldn't open it.
      const swallow = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
      const target = over;
      if (!target) return glide(`translate3d(${from.left}px, ${from.top}px, 0)`, false);
      const box = target.getBoundingClientRect();
      onDrop(row, target.getAttribute("data-mail-drop") ?? "");
      glide(`translate3d(${box.left + 8}px, ${box.top + box.height / 2 - 13}px, 0) scale(0.4)`, true);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };

    finish.current = cancel;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
  }, [onDrop]);

  useEffect(() => () => finish.current?.(), []);

  const card = dragging && createPortal(
    <div
      ref={ghost}
      aria-hidden
      style={{ transformOrigin: "left center", willChange: "transform" }}
      className="pointer-events-none fixed left-0 top-0 z-[70] flex h-[26px] max-w-[170px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-[var(--text)] shadow-lg"
    >
      {hover ? <span style={{ backgroundColor: hover.colour ?? "#D97757" }} className="h-2 w-2 shrink-0 rounded-full" /> : <Mail className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />}
      <span className="min-w-0 truncate">{hover?.name ?? personName(dragging.from)}</span>
    </div>,
    document.body,
  );

  return { dragging, hover: hover?.id ?? null, startDrag: start, card };
}
