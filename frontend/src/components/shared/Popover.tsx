import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

import { isTopLayer, pushLayer, removeLayer } from "./overlayStack";
import { usePresence } from "./usePresence";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";
/** An element to hang off, or a point on screen (a right-click). */
export type PopoverAnchor = HTMLElement | { x: number; y: number } | null | undefined;

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** What it opens next to. An element (a button) or ``{x, y}`` in viewport pixels. */
  anchor: PopoverAnchor;
  /** Preferred side and edge. Flips and nudges itself to stay on screen. Default "bottom-start". */
  placement?: PopoverPlacement;
  /** Gap between the anchor and the panel, px. Default 6. */
  offset?: number;
  /** Make the panel at least as wide as its anchor (select-style lists). */
  matchWidth?: boolean;
  /** Extra classes for the panel (width, padding). */
  className?: string;
  children: ReactNode;
  role?: string;
  "aria-label"?: string;
  id?: string;
  /** Where to put focus on open: the panel itself (default), or leave it where it is. */
  focusOnOpen?: "panel" | "none";
  /** Ref to the panel element, for callers that manage focus inside (Menu). */
  panelRef?: React.MutableRefObject<HTMLDivElement | null>;
}

/**
 * The shared floating panel (motion set, A1): anything that pops open next
 * to a button or under the pointer — pickers, small forms, filters. For a
 * list of actions use ``Menu`` (built on this); for a hint use ``Tooltip``.
 *
 * - Renders in a portal with fixed positioning, so a scrolling or clipped
 *   parent can't cut it off. Stays on screen: flips above/below and slides
 *   sideways as needed, and follows its anchor on scroll and resize.
 * - Pops in from the corner nearest its anchor and pops out on close (it
 *   stays mounted ~120ms after ``open`` goes false).
 * - Closes on Escape (top layer only: a popover inside a dialog closes
 *   first, the dialog stays), on a press outside, and on Tab leaving it.
 *   A press on the anchor itself is left to the anchor's own onClick, so a
 *   toggle button toggles.
 * - Focus goes back to where it was when it closes.
 *
 *   const [open, setOpen] = useState(false);
 *   const btn = useRef<HTMLButtonElement>(null);
 *   <button ref={btn} onClick={() => setOpen((o) => !o)}>Filter</button>
 *   <Popover open={open} onClose={() => setOpen(false)} anchor={btn.current} placement="bottom-end">
 *     …
 *   </Popover>
 */
export function Popover(props: PopoverProps) {
  const { open, onClose } = props;
  const lastOpen = useRef(props);
  if (open) lastOpen.current = props;
  const view = open ? props : lastOpen.current;
  const { anchor, placement = "bottom-start", offset = 6, matchWidth, className, children, role, id, focusOnOpen = "panel", panelRef } = view;
  const { mounted, closing } = usePresence(open);

  const panel = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string; minWidth?: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // Place it. Runs before paint so it never flashes in the wrong spot.
  const place = () => {
    const el = panel.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r =
      a instanceof HTMLElement
        ? a.getBoundingClientRect()
        : { left: a.x, right: a.x, top: a.y, bottom: a.y, width: 0, height: 0 };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const gap = a instanceof HTMLElement ? offset : 2;
    let below = placement.startsWith("bottom");
    const roomBelow = vh - r.bottom - gap - margin;
    const roomAbove = r.top - gap - margin;
    if (below && h > roomBelow && roomAbove > roomBelow) below = false;
    else if (!below && h > roomAbove && roomBelow > roomAbove) below = true;
    let end = placement.endsWith("end");
    let left = end ? r.right - w : r.left;
    if (left < margin && !end) left = margin;
    if (left + w > vw - margin) {
      // Doesn't fit to the right: hang from the anchor's right edge instead.
      if (!end && r.right - w >= margin) {
        end = true;
        left = r.right - w;
      } else left = vw - margin - w;
    }
    if (left < margin) left = margin;
    let top = below ? r.bottom + gap : r.top - gap - h;
    top = Math.max(margin, Math.min(top, vh - margin - h));
    setPos({
      left: Math.round(left),
      top: Math.round(top),
      origin: `${below ? "top" : "bottom"} ${end ? "right" : "left"}`,
      minWidth: matchWidth && a instanceof HTMLElement ? r.width : undefined,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchor, placement, offset, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const me = pushLayer();
    if (focusOnOpen === "panel") panel.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer(me)) return;
      if (e.key === "Escape") {
        // Handled here: the dialog or sheet underneath must not close too.
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && panel.current?.contains(document.activeElement)) {
        // Let Tab leave through the last / first control, then close.
        const nodes = panel.current.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (nodes.length === 0 || (e.shiftKey ? active === first || active === panel.current : active === last)) {
          e.preventDefault();
          closeRef.current();
        }
      }
    };
    const onPress = (e: Event) => {
      if (!isTopLayer(me)) return;
      const t = e.target as Node | null;
      if (!t || panel.current?.contains(t)) return;
      const a = anchorRef.current;
      // The anchor's own click decides (a toggle button closes it itself).
      if (a instanceof HTMLElement && a.contains(t)) return;
      closeRef.current();
    };
    const onMove = (e: Event) => {
      // Scrolling inside the panel is fine; anything else moves the anchor.
      if (e.type === "scroll" && panel.current?.contains(e.target as Node | null)) return;
      if (anchorRef.current instanceof HTMLElement) place();
      else closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      removeLayer(me);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      // Hand focus back, unless something else has already taken it (a
      // dialog the chosen action opened, a field the person clicked).
      const active = document.activeElement;
      if (!active || active === document.body || panel.current?.contains(active)) back?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!mounted) return null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: pos.origin, minWidth: pos.minWidth }
    : { left: 0, top: 0, visibility: "hidden" };

  return createPortal(
    <div
      ref={(el) => {
        panel.current = el;
        if (panelRef) panelRef.current = el;
      }}
      id={id}
      role={role}
      aria-label={view["aria-label"]}
      aria-hidden={closing || undefined}
      tabIndex={-1}
      style={style}
      className={cn(
        "fixed z-[80] max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-xl border outline-none",
        "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-lg)]",
        pos && (closing ? "motion-pop-out pointer-events-none" : "motion-pop-in"),
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
