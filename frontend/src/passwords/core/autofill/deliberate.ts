// Was a press on a surface the page can't cover still meant for that surface? The toolbar
// panel can't be hidden or covered by a page, but on Firefox a page can get it opened (a
// click in our on-page menu opens it, D-FIREFOX-1). Then the second click of a double
// click, aimed at the page, can land on the panel as it appears under a still cursor:
// Paulos Yibelo's "DoubleClickjacking" (2024). So once a page has opened the panel, a
// press only counts when the panel has been up for a short while and the person has
// moved the pointer, or moved focus with the keyboard, since it opened. A person reaching
// for a button does both without noticing. A still cursor double-clicking does neither.

/** Long enough for a panel to draw and be seen; short next to moving to a button. */
export const DELIBERATE_MS = 500;
/** Two pointer positions at least this far apart count as the pointer moving. A browser
 *  may report one position when something opens under a still cursor. */
const MOVE_PX = 2;
/** Keys that move focus between buttons: a keyboard user's way of reaching for one. */
const FOCUS_KEYS = new Set(["Tab", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);

export type DeliberateGate = {
  /** A pointer position, from pointermove. */
  move: (x: number, y: number, at: number) => void;
  /** A key going down, from keydown. */
  key: (key: string, repeat: boolean, at: number) => void;
  /** A pointer going down, from pointerdown. */
  pointerDown: (at: number) => void;
  /** Does the press behind the click that's happening now count? */
  allows: () => boolean;
};

export function deliberateGate(openedAt: number, ms = DELIBERATE_MS): DeliberateGate {
  let last: { x: number; y: number } | null = null;
  // When the person first reached for something: moved the pointer or moved focus.
  let reachedAt: number | null = null;
  let pressAt: number | null = null;
  const reached = (at: number) => {
    reachedAt ??= at;
  };
  return {
    move: (x, y, at) => {
      if (last && Math.abs(x - last.x) + Math.abs(y - last.y) >= MOVE_PX) reached(at);
      last = { x, y };
    },
    key: (key, repeat, at) => {
      // A held key repeats from before the panel opened: none of it counts.
      if (repeat) return;
      if (FOCUS_KEYS.has(key)) reached(at);
      else if (key === "Enter" || key === " ") pressAt = at;
    },
    pointerDown: (at) => {
      pressAt = at;
    },
    allows: () => {
      if (pressAt === null || reachedAt === null) return false;
      // The press has to start after both the wait and the reaching.
      return pressAt >= Math.max(openedAt + ms, reachedAt);
    },
  };
}
