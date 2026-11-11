import { useEffect, useState } from "react";

/** True when the person has asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Keeps something mounted for a moment after it closes, so it can play a
 * closing animation (part of the motion set, UI plan A1).
 *
 *   const { mounted, closing } = usePresence(open);
 *   if (!mounted) return null;
 *   return <div className={closing ? "motion-pop-out" : "motion-pop-in"}>…</div>;
 *
 * ``exitMs`` should be at least as long as the "out" animation (the
 * ``--motion-fast`` exits are 120ms; sheets use ``--motion-base``, 180ms).
 * With reduced motion on, it unmounts straight away.
 */
export function usePresence(open: boolean, exitMs = 130): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  // Opening: mount in the same render, no extra frame.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, mounted, exitMs]);

  return { mounted: open || mounted, closing: !open && mounted };
}
