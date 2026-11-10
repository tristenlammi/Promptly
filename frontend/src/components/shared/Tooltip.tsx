import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

/**
 * The shared tooltip (UI plan A5 / A9): use it instead of ``title=`` on
 * icon buttons. Unlike ``title`` it shows quickly, matches the theme, shows
 * on keyboard focus, and can carry a shortcut.
 *
 *   <Tooltip label="Rename" shortcut="F2">
 *     <button aria-label="Rename" onClick={…}><Pencil /></button>
 *   </Tooltip>
 *
 * Rules
 * - Wrap exactly ONE element that takes a ref and pointer / focus handlers
 *   (a button, a link, a ``forwardRef`` component such as the shared
 *   ``Button``). Your own handlers on it still run.
 * - Keep ``aria-label`` on icon-only buttons: the tooltip is a visual hint,
 *   not the button's name. Remove the old ``title=`` (two bubbles
 *   otherwise).
 * - Mouse: shows after a short pause (400ms, or at once when another
 *   tooltip was showing a moment ago). Keyboard: shows on focus. Touch:
 *   never (a tap should act, not explain); long labels belong in the UI.
 * - Hides on leave, blur, press, scroll and Escape.
 *
 * Props: ``label`` (the text; falsy = no tooltip), ``shortcut`` (small
 * right-hand key hint), ``side`` ("top" default, or "bottom"; flips when
 * there's no room), ``delay`` (ms).
 */
export function Tooltip({
  label,
  shortcut,
  side = "top",
  delay = 400,
  children,
}: {
  label: ReactNode;
  shortcut?: string;
  side?: "top" | "bottom";
  delay?: number;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const id = useId();

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (wait: number) => {
    clear();
    if (!label) return;
    // One tooltip just closed: the next opens at once (scanning a toolbar).
    const warm = Date.now() - lastShownAt < 300;
    timer.current = window.setTimeout(() => setOpen(true), warm ? 0 : wait);
  };
  const hide = () => {
    clear();
    setOpen((was) => {
      if (was) lastShownAt = Date.now();
      return false;
    });
  };

  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onScroll = () => hide();
    document.addEventListener("keydown", onKey);
    // Also covers a press anywhere: a disabled button doesn't report the
    // pointer leaving it.
    document.addEventListener("pointerdown", onScroll, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onScroll, true);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current;
    const b = bubble.current;
    if (!a || !b) return;
    // The anchor went away (or was hidden) while we waited.
    if (!a.isConnected) {
      setOpen(false);
      return;
    }
    const r = a.getBoundingClientRect();
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const gap = 6;
    const margin = 6;
    let top = side === "top" ? r.top - gap - h : r.bottom + gap;
    if (top < margin) top = r.bottom + gap;
    else if (top + h > window.innerHeight - margin) top = r.top - gap - h;
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - margin - w));
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [open, side, label]);

  const child = children as ReactElement<Record<string, unknown>> & { ref?: unknown };
  const props = child.props as {
    onPointerEnter?: (e: PointerEvent) => void;
    onPointerLeave?: (e: PointerEvent) => void;
    onPointerDown?: (e: PointerEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
    "aria-describedby"?: string;
  };
  const childRef = child.ref;

  const trigger = cloneElement(child, {
    ref: (el: HTMLElement | null) => {
      anchor.current = el;
      if (typeof childRef === "function") childRef(el);
      else if (childRef && typeof childRef === "object") (childRef as { current: HTMLElement | null }).current = el;
    },
    onPointerEnter: (e: PointerEvent) => {
      props.onPointerEnter?.(e);
      if (e.pointerType === "mouse") show(delay);
    },
    onPointerLeave: (e: PointerEvent) => {
      props.onPointerLeave?.(e);
      hide();
    },
    onPointerDown: (e: PointerEvent) => {
      props.onPointerDown?.(e);
      hide();
    },
    onFocus: (e: FocusEvent) => {
      props.onFocus?.(e);
      // Keyboard focus only: a click also focuses, and has just hidden it.
      try {
        if ((e.target as HTMLElement).matches(":focus-visible")) show(0);
      } catch {
        /* old browser without :focus-visible */
      }
    },
    onBlur: (e: FocusEvent) => {
      props.onBlur?.(e);
      hide();
    },
    "aria-describedby": open ? id : props["aria-describedby"],
  });

  return (
    <>
      {trigger}
      {open &&
        label &&
        createPortal(
          <div
            ref={bubble}
            id={id}
            role="tooltip"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
            className={cn(
              "pointer-events-none fixed z-[100] flex max-w-[16rem] items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium",
              "bg-[var(--text)] text-[var(--bg)] shadow-[var(--shadow-md)]",
              pos && "motion-fade-in",
            )}
          >
            <span>{label}</span>
            {shortcut && <kbd className="rounded bg-white/15 px-1 font-sans text-xs opacity-80">{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}

/** When a tooltip last closed: lets the next one skip its delay. */
let lastShownAt = 0;
