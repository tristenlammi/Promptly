import { useEffect, useState } from "react";

/**
 * Reactive viewport-width media query.
 *
 * Returns true while the viewport is at or below ``breakpoint`` pixels
 * wide. Updates live as the viewport resizes (or the device rotates), so
 * components using this hook re-render when crossing the threshold.
 *
 * Used to swap the static desktop sidebar for a slide-in drawer on
 * phone-sized viewports — the desktop layout is left byte-identical.
 *
 * Default breakpoint matches Tailwind's ``md`` so the cutoff lines up
 * with the rest of the design system.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${breakpoint}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync once in case the viewport changed between render and effect.
    setMatches(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return matches;
}
