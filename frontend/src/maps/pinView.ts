/**
 * Keeping the chosen pin in sight as the panel over the map grows and shrinks.
 *
 * - "centre": the map was put on this place for you, so the pin stays in the
 *   middle of whatever map is still showing.
 * - "visible": you dropped the pin yourself, so the map is left where you had
 *   it unless the panel would cover the pin.
 * - "off": you've moved the map since. It's yours; nothing follows.
 */
export type PinHold = "centre" | "visible" | "off";

export interface Covered {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Closer to the middle than this and a nudge would only be a twitch. */
const NEAR_ENOUGH = 12;
/** How near the edge of the clear map a pin may sit before it counts as hidden. */
const EDGE = 28;
/** The pin is drawn above its point, so it needs more room at the top. */
const PIN_HEIGHT = 44;
/** Less clear map than this and there's nowhere sensible to put it. */
const TOO_SMALL = 120;

/**
 * Where on screen the pin should be moved to, or null to leave the map alone.
 * `pin` is where it's drawn now; all in pixels from the map's top-left.
 */
export function pinTarget(
  pin: { x: number; y: number },
  size: { w: number; h: number },
  covered: Covered,
  hold: PinHold,
): { x: number; y: number } | null {
  if (hold === "off") return null;
  const clearW = size.w - covered.left - covered.right;
  const clearH = size.h - covered.top - covered.bottom;
  if (clearW < TOO_SMALL || clearH < TOO_SMALL) return null;
  const middle = { x: covered.left + clearW / 2, y: covered.top + clearH / 2 };
  if (hold === "centre") {
    return Math.hypot(pin.x - middle.x, pin.y - middle.y) > NEAR_ENOUGH ? middle : null;
  }
  const inSight =
    pin.x >= covered.left + EDGE &&
    pin.x <= size.w - covered.right - EDGE &&
    pin.y >= covered.top + PIN_HEIGHT &&
    pin.y <= size.h - covered.bottom - EDGE;
  return inSight ? null : middle;
}
