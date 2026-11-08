import { describe, expect, it } from "vitest";

import { DELIBERATE_MS, deliberateGate } from "./deliberate";

describe("deliberateGate (a panel a page opened)", () => {
  it("lets through a person who moves to a button and clicks", () => {
    const g = deliberateGate(0);
    g.move(300, 40, 120);
    g.move(250, 90, 180);
    g.pointerDown(700);
    expect(g.allows()).toBe(true);
  });

  it("refuses the second click of a double click under a still cursor", () => {
    const g = deliberateGate(0);
    // What a browser may report when the panel draws under the pointer.
    g.move(250, 90, 40);
    g.pointerDown(110);
    expect(g.allows()).toBe(false);
  });

  it("refuses a still cursor however long it waits", () => {
    const g = deliberateGate(0);
    g.move(250, 90, 40);
    g.move(250, 90, 900);
    g.pointerDown(5000);
    expect(g.allows()).toBe(false);
  });

  it("refuses a quick press even with the pointer moving", () => {
    const g = deliberateGate(0);
    g.move(250, 90, 20);
    g.move(260, 95, 60);
    g.pointerDown(DELIBERATE_MS - 1);
    expect(g.allows()).toBe(false);
    g.pointerDown(DELIBERATE_MS + 50);
    expect(g.allows()).toBe(true);
  });

  it("needs a press after the reaching, not one held from before", () => {
    const g = deliberateGate(0);
    g.pointerDown(DELIBERATE_MS + 10);
    g.move(250, 90, DELIBERATE_MS + 20);
    g.move(240, 90, DELIBERATE_MS + 30);
    expect(g.allows()).toBe(false);
  });

  it("takes a keyboard user who moves focus and then presses Enter", () => {
    const g = deliberateGate(0);
    g.key("Tab", false, 600);
    g.key("Enter", false, 700);
    expect(g.allows()).toBe(true);
  });

  it("refuses Enter alone, and a held key", () => {
    const g = deliberateGate(0);
    g.key("Enter", false, 900);
    expect(g.allows()).toBe(false);
    const h = deliberateGate(0);
    h.key("Tab", true, 600);
    h.key("Enter", true, 700);
    expect(h.allows()).toBe(false);
  });

  it("has no press at all before anything happens", () => {
    expect(deliberateGate(0).allows()).toBe(false);
  });
});
