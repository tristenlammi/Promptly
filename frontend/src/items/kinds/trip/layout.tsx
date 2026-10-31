/* How wide the trip's own content column really is. On desktop the shell's
 * AI panel (≈420px) and the trips list share the screen, so the tabs choose
 * their layout from this width rather than from the viewport. */

import { createContext, useContext, useEffect, useRef, useState } from "react";

export const TripWidth = createContext<number>(1200);

/** The content column's width in px (1200 until measured). */
export function useTripWidth(): number {
  return useContext(TripWidth);
}

/** Measure an element's width (for the host). */
export function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((e) => setW(Math.round(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Width breakpoints for the trip's content column. */
export const RAIL_MIN = 1020; // the trips list beside the trip (else a top bar)
export const RAIL_W = 248;
export const TWO_COL = 760; // list + detail, money + budget side by side
export const THREE_COL = 1180; // days + plan + ideas
