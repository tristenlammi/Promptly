import { describe, expect, it } from "vitest";

import { loweredWords, reconnectWords, videoPlan, WeakLink } from "./link";

describe("WeakLink", () => {
  it("turns weak after 4 s of poor, and strong after 10 s of good", () => {
    const w = new WeakLink();
    expect(w.input("poor", 0)).toBe(false);
    expect(w.tick(3000)).toBe(false);
    expect(w.tick(4000)).toBe(true);
    expect(w.input("good", 5000)).toBe(true);
    expect(w.tick(14000)).toBe(true);
    expect(w.tick(15000)).toBe(false);
  });

  it("is weak at once when the link is lost, and ignores unknown", () => {
    const w = new WeakLink();
    expect(w.input("unknown", 0)).toBe(false);
    expect(w.input("lost", 10)).toBe(true);
    expect(w.input("unknown", 20)).toBe(true);
  });

  it("doesn't flap on a short dip", () => {
    const w = new WeakLink();
    w.input("good", 0);
    w.input("poor", 1000);
    expect(w.input("good", 3000)).toBe(false);
    expect(w.tick(20000)).toBe(false);
  });
});

describe("videoPlan", () => {
  it("lowers video on a weak link or with Data saver", () => {
    expect(videoPlan(false, false)).toEqual({ lowered: null, receive: "high", sendHeight: 720 });
    expect(videoPlan(true, false)).toEqual({ lowered: "weak", receive: "low", sendHeight: 360 });
    expect(videoPlan(false, true)).toEqual({ lowered: "saver", receive: "low", sendHeight: 360 });
    expect(loweredWords("weak")).toBe("Weak connection: video lowered");
    expect(loweredWords(null)).toBeNull();
  });
});

describe("reconnectWords", () => {
  it("says what's happening while the call gets back", () => {
    expect(reconnectWords({ status: "connected", offline: false, phone: false })).toBeNull();
    expect(reconnectWords({ status: "reconnecting", offline: false, phone: false })).toMatch(/Getting you back/);
    expect(reconnectWords({ status: "connected", offline: true, phone: false })).toMatch(/offline/);
    expect(reconnectWords({ status: "reconnecting", offline: false, phone: true })).toMatch(/in the app/);
  });
});
