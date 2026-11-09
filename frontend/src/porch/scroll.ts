import { useCallback, useEffect, useRef, useState } from "react";

/** The element Porch's pages scroll in (the middle column / the phone screen). */
export const SCROLLER_ID = "porch-scroll";

function scroller(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById(SCROLLER_ID);
}

export function scrollPorchTo(top: number): void {
  scroller()?.scrollTo({ top, behavior: "smooth" });
}

export function usePorchScroller(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(scroller()), []);
  return el;
}

/** A ref for an element at the end of a list: ``onReach`` runs when it's
 *  close to coming on screen (the next page loads before you get there). */
export function useSentinel(onReach: () => void): (el: HTMLElement | null) => void {
  const cb = useRef(onReach);
  cb.current = onReach;
  const io = useRef<IntersectionObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    io.current?.disconnect();
    io.current = null;
    if (!el) return;
    io.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { root: scroller(), rootMargin: "800px 0px" },
    );
    io.current.observe(el);
  }, []);
}
