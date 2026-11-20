import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Step, StepKind } from "@/api/study";

import { reviewWhen, statsWords } from "../ui/words";
import { buildAnswer, CAPSTONE_MAX, canSayDontKnow, draftFromAnswer, emptyDraft, isInstant, isReady, isWritten, KIND_LABEL, WRITTEN_MAX } from "./answers";
import { StepBody } from "./Renderers";
import { appendDictation, feedbackSpeech, speechFor } from "./speech";

/* Phase 2 on the screen: the capstone step, what is read aloud, dictation, and the wording of reviews and days studied. */

function step(kind: StepKind, pub: object, extra: Partial<Step> = {}): Step {
  return {
    id: "s1", session_id: "se", concept_id: "c", position: 1, kind, role: "", status: "pending", graded: kind !== "explain",
    public: { sources: [], ...pub } as never, hints_shown: [], hints_left: 0, confidence: null, answer: null, turns: [], asks: [],
    grade: null, reveal: null, created_at: "", answered_at: null, ...extra,
  } as Step;
}
const opts = (...texts: string[]) => texts.map((text, i) => ({ id: `o${i}`, text }));
const html = (s: Step, canDictate = false) =>
  renderToStaticMarkup(
    <StepBody step={s} draft={s.status === "answered" ? draftFromAnswer(s) : emptyDraft(s)} setDraft={() => undefined} locked={s.status === "answered"} onTurn={() => undefined} sending={false} turnError={null} canDictate={canDictate} />
  );

const CAP = {
  task_md: "Plan **tomorrow's sail** around the tide.", scope: "unit", title: "Why the sea moves",
  concepts: [{ id: "a", title: "Gravity reaches across space" }, { id: "b", title: "The two bulges" }],
};

describe("the capstone step", () => {
  it("shows the task and the ideas it draws on, with room to write", () => {
    const s = step("capstone", CAP, { role: "capstone" });
    const out = html(s);
    expect(out).toContain('data-testid="study-capstone"');
    expect(out).toContain("Unit task");
    expect(out).toContain("<strong>tomorrow&#x27;s sail</strong>");
    expect(out).toContain("Gravity reaches across space");
    expect(out).toContain("The two bulges");
    expect(out).toContain("<textarea");
    expect(html(step("capstone", { ...CAP, scope: "final" }))).toContain("The final task");
  });

  it("once answered, shows each rubric point, whether it was met, and the idea it shows", () => {
    const s: Step = {
      ...step("capstone", CAP, { role: "capstone" }),
      status: "answered",
      answer: { text: "Leave on the ebb." },
      reveal: { rubric: ["Uses the moon's pull", "Times it by the bulges"], rubric_concepts: ["a", "b"], model_answer_md: "Leave **early**." } as never,
      grade: { outcome: "partial", feedback_md: "Half of it.", misconception: null, detail: { met: [0] }, gap_concept_id: null },
    };
    const out = html(s);
    expect(out).toContain("Leave on the ebb.");
    expect(out).toContain("Uses the moon&#x27;s pull");
    expect(out).toContain("(you covered this)");
    expect(out).toContain("(missing from your answer)");
    expect(out).toContain("Shows: Gravity reaches across space");
    expect(out).toContain("Shows: The two bulges");
    expect(out).not.toContain("<textarea");
  });

  it("is ready with something written, sends its text, and takes more than other written steps", () => {
    const s = step("capstone", CAP);
    expect(isReady(s, emptyDraft(s))).toBe(false);
    expect(isReady(s, { ...emptyDraft(s), text: "ok then" })).toBe(true);
    expect(buildAnswer(s, { ...emptyDraft(s), text: "  an answer  " })).toEqual({ text: "an answer" });
    expect((buildAnswer(s, { ...emptyDraft(s), text: "x".repeat(CAPSTONE_MAX + 50) }).text as string).length).toBe(CAPSTONE_MAX);
    expect(CAPSTONE_MAX).toBeGreaterThan(WRITTEN_MAX);
    expect(canSayDontKnow("capstone")).toBe(true);
    expect(isInstant("capstone")).toBe(false);
    expect(KIND_LABEL.capstone).toBe("Put it together");
  });
});

describe("speaking an answer", () => {
  it("is offered on the written kinds only, and only when the server can do it", () => {
    expect(["explain_back", "scenario", "capstone"].every((k) => isWritten(k as StepKind))).toBe(true);
    expect(["mcq", "explain", "teach_student", "order_steps"].some((k) => isWritten(k as StepKind))).toBe(false);
  });

  it("adds what was said to what is already written", () => {
    expect(appendDictation("", " the moon pulls ", 100)).toBe("the moon pulls");
    expect(appendDictation("First. ", "Then the sea bulges.", 100)).toBe("First. Then the sea bulges.");
    expect(appendDictation("Kept", "   ", 100)).toBe("Kept");
    expect(appendDictation("abc", "defgh", 6)).toBe("abc de");
  });
});

describe("what is read aloud", () => {
  it("reads a step as a person would, without the markup", () => {
    const explain = speechFor(step("explain", { title: "Why the sea bulges", body_md: "The **moon** pulls on the sea.", key_points: ["It pulls", "Unevenly"], diagram: null, angle: "plain" }));
    expect(explain).toContain("Why the sea bulges");
    expect(explain).toContain("The moon pulls on the sea.");
    expect(explain).toContain("To take away: It pulls. Unevenly.");
    expect(explain).not.toContain("**");

    const mcq = speechFor(step("mcq", { question_md: "Which is it?", options: opts("The moon", "The wind") }));
    expect(mcq).toContain("Which is it?");
    expect(mcq).toContain("Option 1: The moon. Option 2: The wind.");

    expect(speechFor(step("predict", { setup_md: "The moon is overhead.", question_md: "What happens?", options: opts("It rises") }))).toContain("The moon is overhead.");
    expect(speechFor(step("order_steps", { prompt_md: "Order these.", items: opts("ebb", "flood") }))).toContain("In no particular order: ebb. flood.");
    expect(speechFor(step("match_pairs", { prompt_md: "Match.", left: opts("spring"), right: opts("big range") }))).toContain("On the other: big range.");
    expect(speechFor(step("spot_error", { intro_md: "One line is wrong.", lines: opts("a", "b") }))).toContain("Line 2: b.");
    const worked = speechFor(step("worked_example", { problem_md: "Work it out.", steps: [{ id: "1", blank: false, text_md: "Start." }, { id: "2", blank: true, text_md: "Next?", options: opts("six", "nine") }] }));
    expect(worked).toContain("Step 1: Start.");
    expect(worked).toContain("Step 2, for you: Next? Option 1: six. Option 2: nine.");
    expect(speechFor(step("explain_back", { prompt_md: "Explain it to a friend." }))).toBe("Explain it to a friend.");
    expect(speechFor(step("scenario", { scenario_md: "You are at the beach.", question_md: "Why is it high?" }))).toContain("Why is it high?");
    expect(speechFor(step("teach_student", { student_name: "Sam", opening_md: "The sea pushes the moon.", max_turns: 3 }))).toBe("Sam says: The sea pushes the moon.");
    expect(speechFor(step("capstone", CAP))).toBe("Plan tomorrow's sail around the tide.");
  });

  it("never reads out the answer key", () => {
    const s = step("mcq", { question_md: "Which?", options: opts("A", "B") }, { reveal: { correct_id: "o0", notes: { o0: "SECRET" }, misconceptions: {}, explain_md: "SECRET" } as never });
    expect(speechFor(s)).not.toContain("SECRET");
  });

  it("reads the feedback once a step is answered", () => {
    const g = (outcome: "correct" | "partial" | "wrong") => ({ outcome, feedback_md: "The **moon** does it.", misconception: null, detail: {}, gap_concept_id: null });
    expect(feedbackSpeech({ grade: g("correct") })).toBe("That's right. The moon does it.");
    expect(feedbackSpeech({ grade: g("partial") })).toMatch(/^Nearly\./);
    expect(feedbackSpeech({ grade: g("wrong") })).toMatch(/^Not quite\./);
    expect(feedbackSpeech({ grade: null })).toBe("");
  });
});

describe("wording", () => {
  it("says when a review comes back", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(reviewWhen("2026-11-20T20:00:00Z", now)).toBe("tomorrow");
    expect(reviewWhen("2026-11-25T04:00:00Z", now)).toBe("in 5 days");
    expect(reviewWhen("2026-12-11T04:00:00Z", now)).toBe("in about 3 weeks");
    expect(reviewWhen("2027-03-20T04:00:00Z", now)).toBe("in about 4 months");
  });

  it("says how often you've studied without making a show of it", () => {
    expect(statsWords({ today: false, week: 0, streak: 0, total: 0 })).toBeNull(); // nothing to say before the first day
    expect(statsWords({ today: true, week: 1, streak: 1, total: 1 })).toBe("1 day this week · including today");
    expect(statsWords({ today: false, week: 3, streak: 3, total: 9 })).toBe("3 days in a row · 3 days this week");
    expect(statsWords({ today: false, week: 0, streak: 0, total: 4 })).toBe("Not yet this week"); // no streak to mourn
  });
});
