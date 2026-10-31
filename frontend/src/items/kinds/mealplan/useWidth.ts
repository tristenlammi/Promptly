import { useCallback, useRef, useState } from "react";

/** The rendered width of an element (0 until measured). Layouts here key off
 *  the space they actually get — on desktop the AI panel and the app sidebar
 *  can leave a tab well under the viewport's breakpoint. Returns a callback
 *  ref, so it follows the element even when the branch that renders it
 *  changes. */
export function useWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    ro.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth((old) => (Math.abs(old - w) < 1 ? old : w));
    });
    ro.current.observe(el);
  }, []);
  // No unmount effect: React calls the ref with null on unmount (an effect
  // cleanup would also fire on StrictMode's re-run and drop the observer).
  return [ref, width] as const;
}
