import { describe, expect, it } from "vitest";

import { cursorFor, step } from "./paletteCursor";

describe("the Ctrl+K selection", () => {
  it("is the list's default until the person picks a row", () => {
    expect(cursorFor(null, "join lounge", ["a:join", "a:maps"], 0)).toBe(0);
    expect(cursorFor(null, "dentist", ["a:maps"], -1)).toBe(-1);
  });

  it("is right in the same render the row arrives in (the Enter that used to be lost)", () => {
    // "join lounge" typed: nothing to do yet, nothing selected.
    expect(cursorFor(null, "join lounge", ["a:maps"], -1)).toBe(-1);
    // The voice rooms load: the Join row is first and sure. Selected at once.
    expect(cursorFor(null, "join lounge", ["a:voice-join", "a:maps"], 0)).toBe(0);
  });

  it("keeps a picked row when results land or rows arrive above it", () => {
    const pick = { query: "dentist", key: "a:maps" };
    expect(cursorFor(pick, "dentist", ["a:maps"], -1)).toBe(0);
    expect(cursorFor(pick, "dentist", ["a:maps", "h:1", "h:2"], 1)).toBe(0);
    expect(cursorFor(pick, "dentist", ["a:call", "a:maps", "h:1"], 0)).toBe(1);
  });

  it("drops the pick when the words change or the row has gone", () => {
    const pick = { query: "dentist", key: "h:2" };
    expect(cursorFor(pick, "dentists", ["a:maps", "h:2"], 1)).toBe(1);
    expect(cursorFor(pick, "dentist", ["a:maps", "h:1"], 1)).toBe(1);
  });

  it("never points past the end of the list", () => {
    expect(cursorFor(null, "x", [], 0)).toBe(-1);
    expect(cursorFor(null, "x", ["a:maps"], 1)).toBe(-1);
  });

  it("steps with the arrows, stopping at both ends", () => {
    const rows = ["a:one", "a:two", "h:1"];
    expect(step(-1, 1, rows)).toBe("a:one");
    expect(step(-1, -1, rows)).toBe("a:one");
    expect(step(0, 1, rows)).toBe("a:two");
    expect(step(2, 1, rows)).toBe("h:1");
    expect(step(0, -1, rows)).toBe("a:one");
    expect(step(2, -1, rows)).toBe("a:two");
    expect(step(0, 1, [])).toBeNull();
  });
});
