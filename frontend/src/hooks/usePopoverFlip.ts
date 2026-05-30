import { useEffect, useState, type RefObject } from "react";

/**
 * Decide whether a popover anchored to `anchorRef` should open *upward*
 * (above the anchor) instead of the default downward, based on the
 * viewport geometry at the moment it opens.
 *
 * This stops popovers anchored near the bottom of the screen — e.g. the
 * action row of the last message in a conversation, which sits just
 * above the composer — from clipping under the viewport edge on mobile.
 *
 * Measured once per open: popovers here are short-lived, so we don't
 * re-measure on scroll/resize. Returns `false` until measured.
 *
 * Usage:
 *   const flipUp = usePopoverFlip(open, anchorRef);
 *   <div className={flipUp ? "bottom-full mb-1" : "top-full mt-1"} />
 */
export function usePopoverFlip(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  estimatedHeight = 240,
): boolean {
  const [flipUp, setFlipUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Flip up only when there genuinely isn't room below *and* there's
    // more room above — otherwise the default downward placement wins.
    setFlipUp(spaceBelow < estimatedHeight && spaceAbove > spaceBelow);
  }, [open, anchorRef, estimatedHeight]);

  return flipUp;
}
