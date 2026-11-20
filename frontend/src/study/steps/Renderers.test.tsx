import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Diagram as DiagramSpec, Step, StepKind } from "@/api/study";

import { clipToBox, describeDiagram, Diagram, flowRows, treeRows } from "../ui/Diagram";
import { draftFromAnswer, emptyDraft } from "./answers";
import { StepBody } from "./Renderers";

function step(kind: StepKind, pub: object, extra: Partial<Step> = {}): Step {
  return {
    id: "s1", session_id: "se", concept_id: "c", position: 1, kind, role: "", status: "pending", graded: kind !== "explain",
    public: { sources: [], ...pub } as never, hints_shown: [], hints_left: 2, confidence: null, answer: null, turns: [], asks: [],
    grade: null, reveal: null, created_at: "", answered_at: null, ...extra,
  } as Step;
}
const opts = (...texts: string[]) => texts.map((text, i) => ({ id: `o${i}`, text }));
const html = (s: Step) =>
  renderToStaticMarkup(
    <StepBody step={s} draft={s.status === "answered" ? draftFromAnswer(s) : emptyDraft(s)} setDraft={() => undefined} locked={s.status === "answered"} onTurn={() => undefined} sending={false} turnError={null} />
  );
const answered = (s: Step, answer: object, reveal: object, detail: object = {}): Step => ({
  ...s, status: "answered", answer: answer as never, reveal: reveal as never, grade: { outcome: "wrong", feedback_md: "", misconception: null, detail: detail as never, gap_concept_id: null },
});

describe("each kind of step draws, before and after it is answered", () => {
  it("explain: title, body, take-aways, the diagram and the angle taken", () => {
    const out = html(
      step("explain", {
        title: "Why the sea bulges", body_md: "The **moon** pulls.", key_points: ["It pulls"], angle: "analogy",
        diagram: { type: "bars", title: "Pull", unit: "N", bars: [{ label: "Moon", value: 2 }, { label: "Sun", value: 1 }] },
      })
    );
    expect(out).toContain("Why the sea bulges");
    expect(out).toContain("<strong>moon</strong>");
    expect(out).toContain("It pulls");
    expect(out).toContain("Another way in");
    expect(out).toContain('data-testid="diagram-bars"');
  });

  it("mcq: choices as radios; afterwards the right one and the note for the one picked", () => {
    const s = step("mcq", { question_md: "Which?", options: opts("Alpha", "Beta") });
    const before = html(s);
    expect(before.match(/role="radio"/g)).toHaveLength(2);
    expect(before).not.toContain("data-mark");
    const after = html(answered(s, { option_id: "o1" }, { correct_id: "o0", notes: { o0: "Because A.", o1: "B is the mix-up." }, misconceptions: {}, explain_md: "" }));
    expect(after).toContain('data-mark="missed"');
    expect(after).toContain('data-mark="wrong"');
    expect(after).toContain("Because A.");
    expect(after).toContain("B is the mix-up.");
  });

  it("predict: the reveal only shows once answered", () => {
    const s = step("predict", { setup_md: "The moon is overhead.", question_md: "What happens?", options: opts("Up", "Down") });
    expect(html(s)).not.toContain("What actually happens");
    const after = html(answered(s, { option_id: "o0" }, { correct_id: "o0", notes: {}, misconceptions: {}, explain_md: "The sea bulges." }));
    expect(after).toContain("What actually happens");
    expect(after).toContain("The sea bulges.");
    expect(after).toContain('data-mark="right"');
  });

  it("order the steps: up and down buttons for every row; afterwards where each belongs", () => {
    const s = step("order_steps", { prompt_md: "Order these", items: opts("One", "Two", "Three") });
    const before = html(s);
    expect(before.match(/aria-label="Move &quot;/g)).toHaveLength(6);
    const after = html(answered(s, { order: ["o1", "o0", "o2"] }, { order: ["o0", "o1", "o2"], explain_md: "In that order." }));
    expect(after).toContain("Belongs at place 1");
    expect(after).toContain("Belongs at place 2");
    expect(after).not.toContain("Belongs at place 3");
    expect(after).toContain("In that order.");
    expect(after).not.toContain("Move &quot;");
  });

  it("match pairs: both columns; afterwards what a wrong one goes with", () => {
    const s = step("match_pairs", { prompt_md: "Match", left: [{ id: "l1", text: "Cat" }, { id: "l2", text: "Dog" }], right: [{ id: "r1", text: "Meow" }, { id: "r2", text: "Woof" }] });
    const before = html(s);
    for (const t of ["Cat", "Dog", "Meow", "Woof"]) expect(before).toContain(t);
    const after = html(answered(s, { pairs: { l1: "r2", l2: "r1" } }, { pairs: { l1: "r1", l2: "r2" }, explain_md: "" }));
    expect(after).toContain("Goes with: Meow");
    expect(after).toContain("Goes with: Woof");
  });

  it("spot the error: afterwards the line put right", () => {
    const s = step("spot_error", { intro_md: "One line is wrong", lines: opts("fine", "broken") });
    const after = html(answered(s, { line_id: "o0" }, { error_id: "o1", explain_md: "That one.", correction: "mended", misconception: "" }));
    expect(after).toContain("mended");
    expect(after).toContain('data-mark="wrong"');
    expect(after).toContain('data-mark="missed"');
  });

  it("worked example: shown steps as text, blank steps as choices", () => {
    const s = step("worked_example", {
      problem_md: "Work it out",
      steps: [{ id: "w1", blank: false, text_md: "Start here" }, { id: "w2", blank: true, text_md: "Next?", options: opts("Add", "Subtract") }],
    });
    const before = html(s);
    expect(before).toContain("Start here");
    expect(before.match(/role="radio"/g)).toHaveLength(2);
    const after = html(answered(s, { blanks: { w2: "o0" } }, { blanks: { w2: "o0" }, notes: { w2: "You add." } }));
    expect(after).toContain("You add.");
    expect(after).toContain('data-mark="right"');
  });

  it("written kinds: a box to write in; afterwards the points covered and a good answer", () => {
    const s = step("explain_back", { prompt_md: "Explain tides to a friend" });
    expect(html(s)).toContain("<textarea");
    const after = html(answered(s, { text: "the moon" }, { rubric: ["the moon pulls", "the sea bulges"], model_answer_md: "Full answer." }, { met: [0] }));
    expect(after).not.toContain("<textarea");
    expect(after).toContain("the moon");
    expect(after).toContain("(you covered this)");
    expect(after).toContain("(missing from your answer)");
    expect(after).toContain("Full answer.");
    const sc = html(step("scenario", { scenario_md: "At the beach.", question_md: "Why is the water high?" }));
    expect(sc).toContain("At the beach.");
    expect(sc).toContain("Why is the water high?");
  });

  it("teach the student: the opening, the turns so far and how many goes are left", () => {
    const s = step("teach_student", { student_name: "Sam", opening_md: "I think the sea pushes the moon.", max_turns: 3 }, {
      turns: [{ role: "learner", text: "No, the moon pulls." }, { role: "student", text: "Oh!", resolved: false }], turns_left: 2,
    });
    const out = html(s);
    expect(out).toContain("I think the sea pushes the moon.");
    expect(out).toContain("No, the moon pulls.");
    expect(out).toContain("2 goes left");
    const done = html({ ...s, turns: [...s.turns, { role: "learner", text: "x" }, { role: "student", text: "Got it", resolved: true }], turns_left: 1 });
    expect(done).toContain("Sam gets it now");
    expect(done).not.toContain("<textarea");
  });

  it("never renders HTML the model wrote", () => {
    const out = html(step("mcq", { question_md: 'Hi <img src=x onerror="alert(1)"> <script>alert(1)</script>', options: opts("A") }));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
  });
});

describe("diagrams", () => {
  it("flow: each box a row below the furthest thing that leads to it, loops ignored", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(flowRows(nodes, [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }, { from: "d", to: "a" }])).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("tree: children under their parent, row by row", () => {
    expect(treeRows([{ id: "r", parent: null }, { id: "x", parent: "r" }, { id: "y", parent: "r" }, { id: "z", parent: "x" }])).toEqual([["r"], ["x", "y"], ["z"]]);
  });

  it("clips a line to the edge of a box", () => {
    expect(clipToBox({ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 100 }, 80, 40)).toEqual({ x: 0, y: 20 });
    expect(clipToBox({ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 }, 80, 40)).toEqual({ x: 40, y: 0 });
  });

  it("every type draws, with words for a screen reader on the picture ones", () => {
    const specs: DiagramSpec[] = [
      { type: "flow", title: "F", nodes: [{ id: "a", label: "Moon", note: "" }, { id: "b", label: "Sea", note: "" }], edges: [{ from: "a", to: "b", label: "pulls" }] },
      { type: "cycle", title: "C", nodes: [{ id: "a", label: "High", note: "" }, { id: "b", label: "Low", note: "" }], edges: [{ from: "a", to: "b", label: "" }, { from: "b", to: "a", label: "" }] },
      { type: "tree", title: "T", nodes: [{ id: "a", label: "Tides", note: "", parent: null }, { id: "b", label: "Spring", note: "", parent: "a" }] },
      { type: "timeline", title: "L", items: [{ label: "High water", when: "06:00", note: "" }] },
      { type: "compare", title: "P", columns: ["Spring", "Neap"], rows: [{ label: "Range", cells: ["Big", "Small"] }] },
      { type: "bars", title: "B", unit: "m", bars: [{ label: "Spring", value: 4.5 }] },
    ];
    for (const spec of specs) {
      const out = renderToStaticMarkup(<Diagram spec={spec} />);
      expect(out).toContain(`data-testid="diagram-${spec.type}"`);
      expect(describeDiagram(spec).length).toBeGreaterThan(10);
    }
    expect(describeDiagram(specs[0])).toBe("A flow: Moon leads to Sea (pulls).");
    expect(renderToStaticMarkup(<Diagram spec={specs[4]} />)).toContain("Small");
    expect(renderToStaticMarkup(<Diagram spec={specs[3]} />)).toContain("06:00");
  });
});
