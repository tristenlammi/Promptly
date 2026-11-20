import { describe, expect, it } from "vitest";

import { continueList } from "./listContinue";

/** Type a new line at `|` in `text`. */
function enter(text: string) {
  const at = text.indexOf("|");
  const prev = text.replace("|", "");
  const next = prev.slice(0, at) + "\n" + prev.slice(at);
  const got = continueList(prev, next, at + 1);
  return got ? got.value.slice(0, got.caret) + "|" + got.value.slice(got.caret) : null;
}

describe("continueList", () => {
  it("puts in the next number", () => {
    expect(enter("1. milk|")).toBe("1. milk\n2. |");
    expect(enter("list:\n9) eggs|")).toBe("list:\n9) eggs\n10) |");
  });

  it("carries a bullet on", () => {
    expect(enter("- milk|")).toBe("- milk\n- |");
    expect(enter("  * milk|")).toBe("  * milk\n  * |");
  });

  it("ends the list on an empty item", () => {
    expect(enter("1. milk\n2. |")).toBe("1. milk\n|");
    expect(enter("- |")).toBe("|");
  });

  it("renumbers the items below an inserted one", () => {
    expect(enter("1. a|\n2. b\n3. c\nend")).toBe("1. a\n2. |\n3. b\n4. c\nend");
  });

  it("leaves ordinary lines and mid-line breaks alone", () => {
    expect(enter("hello|")).toBeNull();
    expect(enter("1. mi|lk")).toBeNull();
    expect(enter("3.14 is pi|")).toBeNull();
    expect(enter("1.milk|")).toBeNull();
  });

  it("ignores edits that aren't one typed new line", () => {
    expect(continueList("1. a", "1. a\nb\n", 7)).toBeNull();
    expect(continueList("1. a", "1. ab", 5)).toBeNull();
  });
});
