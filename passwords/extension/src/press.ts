// Did a person press this frame while they could see it? Decided here, inside our own
// frame, because the page can't reach in here. Anything the page's content can see, the
// page can arrange: a cover can stay up until the moment of the press and drop on its blur
// event, so checking anything at click time, or from the page's side, is too late.
//
// IntersectionObserver v2 is the only thing a frame has that sees over its own edge: what
// its ancestors paint over it, and what they do to its opacity. It has to report the frame
// visible, without a break, for this long before the press counts. A browser without it
// has nothing trustworthy to ask, so nothing counts there: see inlineCanAct.
// 300 ms, not the 500 it was (D77): at 500, an ordinary click straight onto the menu was
// often refused. 300 is still longer than the observer's 100 ms delay, so a cover dropped
// at the last moment is still caught; what's given up is a little time against a page
// that gets someone clicking fast where the menu's about to be.
export const MIN_VISIBLE_MS = 300;

/** A key press counts only once what has focus here has had it this long. */
export const KEY_DWELL_MS = 500;

/** Keys go wherever focus is, and a page can move focus into this frame while someone's typing
 *  into it, so a Tab, then a space or Enter meant for the page, would press a row. Someone using
 *  the menu by keyboard moves to a row and stops on it; someone typing has typed characters here,
 *  or is moving too fast. */
export function keyPressCounts(s: { typed: boolean; focusAt: number | null; now: number }): boolean {
  return !s.typed && s.focusAt !== null && s.now - s.focusAt >= KEY_DWELL_MS;
}

export function inlineCanAct(): boolean {
  return typeof IntersectionObserverEntry !== "undefined" && "isVisible" in IntersectionObserverEntry.prototype;
}

export type PressGuard = {
  /** The rows changed. What's there now has to be there for the full time as well. */
  rendered: () => void;
  /** Was the press behind this click a good one? Answers once per press. */
  take: (e: Event) => boolean;
  /** Why the last press didn't count: hidden at some point, or just too soon. */
  why: () => "hidden" | "soon";
};

export function pressGuard(target: Element): PressGuard {
  let visibleSince: number | null = null;
  let renderedAt = performance.now();
  let good = false;
  let why: "hidden" | "soon" = "soon";

  if (inlineCanAct()) {
    new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1] as unknown as { isVisible: boolean };
        if (!last.isVisible) visibleSince = null;
        else visibleSince ??= performance.now();
      },
      { threshold: [0, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    ).observe(target);
  }

  const judge = (e: Event) => {
    const now = performance.now();
    good = e.isTrusted && visibleSince !== null && now - visibleSince >= MIN_VISIBLE_MS && now - renderedAt >= MIN_VISIBLE_MS;
    // Hidden or covered within the wait, against just pressed early.
    why = visibleSince === null || (now - renderedAt >= MIN_VISIBLE_MS && now - visibleSince < MIN_VISIBLE_MS) ? "hidden" : "soon";
  };
  document.addEventListener("pointerdown", judge, true);
  // Keyboard users reach the rows too, under the same rule, and keyPressCounts.
  let typed = false;
  let focusAt: number | null = null;
  document.addEventListener("focusin", () => {
    focusAt = performance.now();
  }, true);
  window.addEventListener("blur", () => {
    typed = false;
    focusAt = null;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key.length === 1 && e.key !== " ") typed = true;
    if (e.key !== "Enter" && e.key !== " ") return;
    judge(e);
    if (good && !keyPressCounts({ typed, focusAt, now: performance.now() })) {
      good = false;
      why = "soon";
    }
  }, true);

  return {
    rendered: () => {
      renderedAt = performance.now();
      good = false;
    },
    take: (e) => {
      const was = good && e.isTrusted;
      good = false;
      return was;
    },
    why: () => why,
  };
}
