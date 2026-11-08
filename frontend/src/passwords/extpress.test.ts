// The inline menu's rule for a key press (passwords/extension/src/press.ts). From the review's
// suspicions: a page moves focus into the menu while someone types, so their Tab and space press
// a row.
import { describe, expect, it } from "vitest";

// Loaded by a path the main app's type check doesn't follow (see extclipboard.test.ts).
const PRESS = "../../../passwords/extension/src/press";
const { KEY_DWELL_MS, keyPressCounts } = (await import(/* @vite-ignore */ PRESS)) as {
  KEY_DWELL_MS: number;
  keyPressCounts: (s: { typed: boolean; focusAt: number | null; now: number }) => boolean;
};

describe("a key press in the inline menu", () => {
  it("counts once a row has had focus a moment, with nothing typed into the menu", () => {
    expect(keyPressCounts({ typed: false, focusAt: 1000, now: 1000 + KEY_DWELL_MS })).toBe(true);
  });

  it("doesn't count straight after focus arrives, as a Tab then space in passing would", () => {
    expect(keyPressCounts({ typed: false, focusAt: 1000, now: 1100 })).toBe(false);
    expect(keyPressCounts({ typed: false, focusAt: null, now: 5000 })).toBe(false);
  });

  it("doesn't count after letters were typed here, meant for the page", () => {
    expect(keyPressCounts({ typed: true, focusAt: 1000, now: 9000 })).toBe(false);
  });
});
