import { useEffect, type RefObject } from "react";

/**
 * Shared dismissal contract for popovers/menus: closes on an outside
 * pointer press (mouse or touch) and on Escape. Consolidates the
 * effect that was hand-rolled in WebSearchToggle, ReasoningEffortToggle,
 * ComposerMoreMenu, RegenerateControl, etc. so every popover behaves
 * identically.
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   usePopoverDismiss(open, ref, () => setOpen(false));
 *   return <div ref={ref}>…</div>;
 *
 * Pair with `usePopoverFlip` for viewport-aware vertical placement.
 */
export function usePopoverDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const root = containerRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, containerRef, onDismiss]);
}
