import { describe, expect, it } from "vitest";

import { pollOf, voiceOf } from "@/api/rooms";

import { clock } from "./voicePlayer";
import { micProblem, shrinkPeaks } from "./voiceRecorder";

describe("a voice message's meta", () => {
  it("reads a well-formed one", () => {
    const v = voiceOf({ meta: { voice: { att: "a1", duration_ms: 12_400, peaks: [0.1, 0.9], play: true, state: "done", transcript: "hello" } } });
    expect(v).toEqual({ att: "a1", duration_ms: 12_400, peaks: [0.1, 0.9], play: true, state: "done", transcript: "hello" });
  });

  it("fills in what's missing, and ignores what isn't one", () => {
    expect(voiceOf({ meta: { voice: { att: "a1", peaks: ["x", 0.5, NaN] } } })).toEqual({
      att: "a1",
      duration_ms: 0,
      peaks: [0.5],
      play: false,
      state: "pending",
      transcript: undefined,
    });
    expect(voiceOf({ meta: { voice: { duration_ms: 5 } } })).toBeNull();
    expect(voiceOf({ meta: null })).toBeNull();
  });
});

describe("a poll's meta", () => {
  it("reads a well-formed one", () => {
    const p = pollOf({ meta: { poll: { question: "Lunch?", options: [{ id: "1", text: "Thai" }, { id: "2", text: "Pizza" }], multiple: true, anonymous: false, closes_at: null, closed_at: null } } });
    expect(p?.question).toBe("Lunch?");
    expect(p?.options.map((o) => o.text)).toEqual(["Thai", "Pizza"]);
    expect(p?.multiple).toBe(true);
  });

  it("needs a question and two real answers", () => {
    expect(pollOf({ meta: { poll: { question: "Lunch?", options: [{ id: "1", text: "Thai" }, { id: 2 }] } } })).toBeNull();
    expect(pollOf({ meta: { poll: { options: [] } } })).toBeNull();
    expect(pollOf({ meta: {} })).toBeNull();
  });
});

describe("recording", () => {
  it("shrinks the measured levels to a waveform, loudest at 1", () => {
    const levels = Array.from({ length: 300 }, (_, i) => (i % 50 === 0 ? 0.4 : 0.02));
    const out = shrinkPeaks(levels, 64);
    expect(out).toHaveLength(64);
    expect(Math.max(...out)).toBe(1);
    expect(out.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(shrinkPeaks([])).toEqual([]);
    expect(shrinkPeaks([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("says why the microphone didn't start in plain words", () => {
    expect(micProblem({ name: "NotAllowedError" })).toMatch(/isn't allowed to use the microphone/);
    expect(micProblem({ name: "NotFoundError" })).toMatch(/No microphone/);
    expect(micProblem({ name: "NotReadableError" })).toMatch(/busy in another app/);
    expect(micProblem(new Error("x"))).toMatch(/couldn't be started/);
  });

  it("shows a length as minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(12_400)).toBe("0:12");
    expect(clock(605_000)).toBe("10:05");
  });
});
