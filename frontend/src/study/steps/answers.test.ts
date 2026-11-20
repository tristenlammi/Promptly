import { describe, expect, it } from "vitest";

import type { Step, StepKind } from "@/api/study";

import { buildAnswer, canSayDontKnow, clearPair, draftFromAnswer, emptyDraft, isInstant, isReady, moveItem, setPair } from "./answers";

function step<K extends StepKind>(kind: K, pub: object, extra: Partial<Step> = {}): Step {
  return {
    id: "s1", session_id: "se", concept_id: "c", position: 1, kind, role: "", status: "pending", graded: kind !== "explain",
    public: { sources: [], ...pub } as never, hints_shown: [], hints_left: 2, confidence: null, answer: null, turns: [], asks: [],
    grade: null, reveal: null, created_at: "", answered_at: null, ...extra,
  } as Step;
}
const opts = (...ids: string[]) => ids.map((id) => ({ id, text: id.toUpperCase() }));

describe("the answer sent for each kind of step", () => {
  it("explain: always ready, sends nothing", () => {
    const s = step("explain", { title: "", body_md: "", key_points: [], diagram: null, angle: "plain" });
    expect(isReady(s, emptyDraft(s))).toBe(true);
    expect(buildAnswer(s, emptyDraft(s))).toEqual({});
  });

  it("mcq and predict: the chosen option", () => {
    for (const kind of ["mcq", "predict"] as const) {
      const s = step(kind, { question_md: "?", options: opts("a", "b") });
      const d = emptyDraft(s);
      expect(isReady(s, d)).toBe(false);
      d.optionId = "b";
      expect(isReady(s, d)).toBe(true);
      expect(buildAnswer(s, d)).toEqual({ option_id: "b" });
    }
  });

  it("spot the error: the chosen line", () => {
    const s = step("spot_error", { intro_md: "", lines: opts("l1", "l2") });
    const d = { ...emptyDraft(s), lineId: "l2" };
    expect(isReady(s, emptyDraft(s))).toBe(false);
    expect(buildAnswer(s, d)).toEqual({ line_id: "l2" });
  });

  it("order the steps: starts in the order given, sends every id in the learner's order", () => {
    const s = step("order_steps", { prompt_md: "", items: opts("x", "y", "z") });
    const d = emptyDraft(s);
    expect(d.order).toEqual(["x", "y", "z"]);
    expect(isReady(s, d)).toBe(true);
    d.order = moveItem(d.order, 2, 0);
    expect(buildAnswer(s, d)).toEqual({ order: ["z", "x", "y"] });
    expect(isReady(s, { ...d, order: ["z", "x"] })).toBe(false);
    expect(isReady(s, { ...d, order: ["z", "x", "x"] })).toBe(false);
  });

  it("match pairs: every left once, each right once", () => {
    const s = step("match_pairs", { prompt_md: "", left: opts("l1", "l2"), right: opts("r1", "r2") });
    let d = emptyDraft(s);
    d = { ...d, pairs: setPair(d.pairs, "l1", "r2") };
    expect(isReady(s, d)).toBe(false);
    d = { ...d, pairs: setPair(d.pairs, "l2", "r1") };
    expect(isReady(s, d)).toBe(true);
    expect(buildAnswer(s, d)).toEqual({ pairs: { l1: "r2", l2: "r1" } });
    // Giving l2 the right side l1 holds takes it away from l1.
    d = { ...d, pairs: setPair(d.pairs, "l2", "r2") };
    expect(d.pairs).toEqual({ l2: "r2" });
    expect(isReady(s, d)).toBe(false);
    expect(clearPair({ l1: "r1" }, "l1")).toEqual({});
  });

  it("worked example: an option for every blank step, and only those", () => {
    const s = step("worked_example", {
      problem_md: "",
      steps: [
        { id: "w1", blank: false, text_md: "shown" },
        { id: "w2", blank: true, text_md: "next?", options: opts("a", "b") },
        { id: "w3", blank: true, text_md: "then?", options: opts("c", "d") },
      ],
    });
    const d = emptyDraft(s);
    d.blanks = { w2: "a" };
    expect(isReady(s, d)).toBe(false);
    d.blanks = { w2: "a", w3: "d", w1: "junk" };
    expect(isReady(s, d)).toBe(true);
    expect(buildAnswer(s, d)).toEqual({ blanks: { w2: "a", w3: "d" } });
  });

  it("written kinds: trimmed text, at least two characters", () => {
    for (const kind of ["explain_back", "scenario"] as const) {
      const s = step(kind, { prompt_md: "", scenario_md: "", question_md: "" });
      expect(isReady(s, { ...emptyDraft(s), text: " a " })).toBe(false);
      const d = { ...emptyDraft(s), text: "  the moon pulls  " };
      expect(isReady(s, d)).toBe(true);
      expect(buildAnswer(s, d)).toEqual({ text: "the moon pulls" });
    }
  });

  it("teach the student: ready after one turn, sends nothing", () => {
    const s = step("teach_student", { student_name: "Sam", opening_md: "", max_turns: 3 });
    expect(isReady(s, emptyDraft(s))).toBe(false);
    const said = { ...s, turns: [{ role: "learner" as const, text: "hi" }] };
    expect(isReady(said, emptyDraft(said))).toBe(true);
    expect(buildAnswer(said, emptyDraft(said))).toEqual({});
  });
});

describe("helpers", () => {
  it("offers I-do-not-know on graded kinds except the student chat", () => {
    expect(canSayDontKnow("mcq")).toBe(true);
    expect(canSayDontKnow("explain_back")).toBe(true);
    expect(canSayDontKnow("explain")).toBe(false);
    expect(canSayDontKnow("teach_student")).toBe(false);
  });

  it("knows which kinds are marked at once", () => {
    expect(isInstant("order_steps")).toBe(true);
    expect(isInstant("scenario")).toBe(false);
  });

  it("moveItem ignores moves that go nowhere", () => {
    const o = ["a", "b", "c"];
    expect(moveItem(o, 0, 0)).toBe(o);
    expect(moveItem(o, 0, 5)).toBe(o);
    expect(moveItem(o, 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("rebuilds what was sent, to show an answered step again", () => {
    const s = step("match_pairs", { prompt_md: "", left: opts("l1"), right: opts("r1") }, { answer: { pairs: { l1: "r1" } } });
    expect(draftFromAnswer(s).pairs).toEqual({ l1: "r1" });
    const o = step("order_steps", { prompt_md: "", items: opts("x", "y") }, { answer: { order: ["y", "x"] } });
    expect(draftFromAnswer(o).order).toEqual(["y", "x"]);
    const dk = step("order_steps", { prompt_md: "", items: opts("x", "y") }, { answer: { dont_know: true } });
    expect(draftFromAnswer(dk).order).toEqual(["x", "y"]);
  });
});
