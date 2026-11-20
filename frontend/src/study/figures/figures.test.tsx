import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Figure as FigureSpec, Step, StepKind } from "@/api/study";

import { passedAll, tidy } from "../code/runner";
import { buildAnswer, draftFromAnswer, emptyDraft, isInstant, isReady } from "../steps/answers";
import { StepBody } from "../steps/Renderers";
import { speechFor } from "../steps/speech";
import cases from "./expr.cases.json";
import { ExprError, parse, value } from "./expr";
import { curve, Figure, figureAnswer, fmt, initialFigureState, stateFromAnswer, ticks } from "./Figure";

const PLOT: FigureSpec = {
  type: "plot", title: "Height of the tide", expr: "a*sin(x) + b",
  x: { min: 0, max: 6, label: "hours" }, y: { min: -5, max: 9, label: "metres" },
  params: [
    { name: "a", label: "range", unit: "m", min: 0, max: 4, step: 0.5, value: 1 },
    { name: "b", label: "mean level", unit: "", min: 0, max: 4, step: 1, value: 0 },
  ],
};
const SCALE: FigureSpec = {
  type: "scale", title: "Hours after high water", min: 0, max: 12, step: 0.5, value: 0, unit: "h",
  marks: [{ value: 6, label: "low water" }], readout: { label: "fraction of the cycle", expr: "v / 12", unit: "", decimals: 2 },
};
const PARTS: FigureSpec = {
  type: "parts", title: "The pull", layout: "row",
  parts: [{ id: "p1", label: "Moon", note: "" }, { id: "p2", label: "Near sea", note: "" }, { id: "p3", label: "Earth", note: "" }],
};
const TABLE: FigureSpec = {
  type: "table", title: "Tide height", inputs: [{ name: "r", label: "range", unit: "m", min: 0, max: 10, step: 1, value: 2 }],
  outputs: [{ label: "high water", expr: "3 + r / 2", unit: "m", decimals: 1 }],
};

function step(kind: StepKind, pub: object, extra: Partial<Step> = {}): Step {
  return {
    id: "s1", session_id: "se", concept_id: "c", position: 1, kind, role: "", status: "pending", graded: kind !== "explain",
    public: { sources: [], ...pub } as never, hints_shown: [], hints_left: 2, confidence: null, answer: null, turns: [], asks: [],
    grade: null, reveal: null, created_at: "", answered_at: null, ...extra,
  } as Step;
}
const html = (s: Step) =>
  renderToStaticMarkup(
    <StepBody step={s} draft={s.status === "answered" ? draftFromAnswer(s) : emptyDraft(s)} setDraft={() => undefined} locked={s.status === "answered"} onTurn={() => undefined} sending={false} turnError={null} />
  );

describe("the formula evaluator (the same cases as the server's)", () => {
  it.each(cases.values)("$expr", (c) => {
    const got = value(c.expr, c.env as Record<string, number>);
    if (c.value === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(c.value, 9);
  });

  it.each(cases.bad.map((src) => ({ src })))("refuses $src", ({ src }) => {
    expect(() => parse(src)).toThrow(ExprError);
  });

  it("is the server's table, to the letter", () => {
    const theirs = path.resolve(__dirname, "../../../../backend/tests/study_expr_cases.json");
    if (!fs.existsSync(theirs)) return;
    expect(JSON.parse(fs.readFileSync(theirs, "utf8"))).toEqual(cases);
  });

  it("never reaches anything but arithmetic", () => {
    for (const src of ["(".repeat(5000), "1" + "+1".repeat(5000), "-".repeat(5000) + "1", "2^".repeat(300) + "2", null, 5, ["x"], {}]) {
      expect(() => parse(src)).toThrow(ExprError);
    }
    // Names on Object.prototype are not variables, constants or functions.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(value(name, {})).toBeNull();
      expect(() => parse(`${name}(1)`)).toThrow(ExprError);
    }
    expect(value("x + 1", { x: Infinity })).toBeNull();
    expect(value("x + 1", { x: NaN })).toBeNull();
    expect(value("x + 1", { x: "1" as unknown as number })).toBeNull();
    expect(value("9 ^ 9 ^ 9", {})).toBeNull();
  });
});

describe("figure helpers", () => {
  it("ticks are round numbers across the range", () => {
    expect(ticks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(ticks(-1, 1)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(ticks(0, 0.3).every((v) => String(v).length <= 5)).toBe(true); // no 0.30000000000000004
    expect(ticks(5, 5)).toEqual([5]);
  });

  it("numbers are written the way people write them", () => {
    expect(fmt(0.1 + 0.2)).toBe("0.3");
    expect(fmt(-0.0001)).toBe("0");
    expect(fmt(NaN)).toBe("–");
    expect(fmt(2.5, 0)).toMatch(/^[23]$/);
  });

  it("the curve follows the sliders and breaks where the formula has no value", () => {
    const flat = curve(PLOT as Extract<FigureSpec, { type: "plot" }>, { a: 0, b: 3 }, 12);
    expect(flat).toHaveLength(1);
    expect(flat[0].every((p) => p.y === 3)).toBe(true);
    const broken = curve({ ...(PLOT as Extract<FigureSpec, { type: "plot" }>), expr: "1 / (x - 3)" }, {}, 12);
    expect(broken).toHaveLength(2); // nothing at x = 3
    expect(curve({ ...(PLOT as Extract<FigureSpec, { type: "plot" }>), expr: "not a formula (" }, {}, 12)).toEqual([]);
  });

  it("the answer for each figure, and back again", () => {
    const s = initialFigureState(PLOT);
    expect(s).toEqual({ values: { a: 1, b: 0 }, value: 0, partId: null, touched: false });
    expect(figureAnswer(PLOT, { ...s, values: { a: 2, b: 3 } })).toEqual({ values: { a: 2, b: 3 } });
    expect(figureAnswer(SCALE, { ...initialFigureState(SCALE), value: 6.5 })).toEqual({ value: 6.5 });
    expect(figureAnswer(PARTS, { ...initialFigureState(PARTS), partId: "p2" })).toEqual({ part_id: "p2" });
    expect(stateFromAnswer(PLOT, { values: { a: 2, b: 3, zz: 9 } }).values).toEqual({ a: 2, b: 3 });
    expect(stateFromAnswer(SCALE, { value: 4 }).value).toBe(4);
    expect(stateFromAnswer(PARTS, { part_id: "p3" }).partId).toBe("p3");
  });
});

describe("each figure draws from its data and nothing else", () => {
  it("plot: a curve, a slider per parameter with its label, the target", () => {
    const out = renderToStaticMarkup(<Figure spec={PLOT} targets={[{ x: 0, y: 3 }]} />);
    expect(out).toContain('data-testid="fig-plot"');
    expect(out.match(/type="range"/g)).toHaveLength(2);
    expect(out).toContain("mean level");
    expect(out).toContain('data-testid="fig-plot-target"');
    expect(out).toContain("The curve must pass through");
  });

  it("scale: one range input, the marks, the readout worked out by the evaluator", () => {
    const out = renderToStaticMarkup(<Figure spec={SCALE} state={{ ...initialFigureState(SCALE), value: 6 }} />);
    expect(out.match(/type="range"/g)).toHaveLength(1);
    expect(out).toContain("low water");
    expect(out).toContain("0.5"); // 6 / 12
  });

  it("parts: buttons; a radio group when tapping is the answer", () => {
    const explain = renderToStaticMarkup(<Figure spec={PARTS} />);
    expect(explain.match(/<button/g)).toHaveLength(3);
    expect(explain).toContain("Tap a part to see what it does");
    const pick = renderToStaticMarkup(<Figure spec={PARTS} pick state={{ ...initialFigureState(PARTS), partId: "p1" }} solution={{ part_id: "p2" }} />);
    expect(pick.match(/role="radio"/g)).toHaveLength(3);
    expect(pick).toContain("the right part");
    expect(pick).toContain("your pick");
  });

  it("table: sliders in, numbers out", () => {
    const out = renderToStaticMarkup(<Figure spec={TABLE} state={{ ...initialFigureState(TABLE), values: { r: 8 } }} />);
    expect(out).toContain('data-testid="fig-out-0"');
    expect(out).toContain("7 m");
  });

  it("text in a spec is only ever text", () => {
    const evil = { ...PARTS, title: "<img src=x onerror=alert(1)>", parts: [{ id: "p1", label: "<script>alert(1)</script>", note: "" }, ...(PARTS as Extract<FigureSpec, { type: "parts" }>).parts.slice(1)] } as FigureSpec;
    const out = renderToStaticMarkup(<Figure spec={evil} />);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("the explore step", () => {
  const s = step("explore", { prompt_md: "Bring the curve through the dot.", figure: PLOT, targets: [{ x: 0, y: 3 }] });

  it("isn't an answer until something has been moved", () => {
    const d = emptyDraft(s);
    expect(d.fig).toEqual(initialFigureState(PLOT));
    expect(isReady(s, d)).toBe(false);
    d.fig = { ...d.fig!, values: { a: 1, b: 3 }, touched: true };
    expect(isReady(s, d)).toBe(true);
    expect(buildAnswer(s, d)).toEqual({ values: { a: 1, b: 3 } });
    const parts = step("explore", { prompt_md: "Tap it.", figure: PARTS });
    const pd = emptyDraft(parts);
    expect(isReady(parts, pd)).toBe(false);
    pd.fig = { ...pd.fig!, partId: "p2", touched: true };
    expect(buildAnswer(parts, pd)).toEqual({ part_id: "p2" });
    expect(isInstant("explore")).toBe(true);
  });

  it("draws the task; once answered wrong, the right answer and why", () => {
    const before = html(s);
    expect(before).toContain("Bring the curve through the dot.");
    expect(before).toContain("Move the sliders");
    expect(before).not.toContain("fig-plot-solution");
    const after = html({
      ...s, status: "answered", answer: { values: { a: 1, b: 1 } }, grade: { outcome: "wrong" },
      reveal: { solution: { values: { a: 1, b: 3 } }, goal: {}, figure: PLOT, explain_md: "The mean level lifts the whole curve." } as never,
    });
    expect(after).toContain("fig-plot-solution");
    expect(after).toContain("The mean level lifts the whole curve.");
    expect(after).toContain("disabled");
  });

  it("is read aloud as its task", () => {
    expect(speechFor(s)).toContain("Bring the curve through the dot.");
  });
});

describe("the write-code step", () => {
  const checks = [
    { id: "k1", call: "double(2)", expect: 4, label: "doubles 2" },
    { id: "k2", call: "double(0)", expect: 0, label: "keeps 0" },
  ];
  const s = step("write_code", { prompt_md: "Write `double(n)`.", lang: "javascript", starter: "function double(n) {\n}", run: { checks, solution: "function double(n) { return n * 2 }" } });

  it("can only be handed in after a run of exactly this code", () => {
    const d = emptyDraft(s);
    expect(d.code).toBe("function double(n) {\n}");
    expect(isReady(s, d)).toBe(false);
    d.run = { results: { k1: true, k2: false }, got: { k2: "undefined" }, output: "hi", error: "" };
    d.ranCode = d.code;
    expect(isReady(s, d)).toBe(true);
    expect(buildAnswer(s, d)).toEqual({ code: d.code, results: { k1: true, k2: false }, output: "hi", error: "" });
    d.code += " ";
    expect(isReady(s, d)).toBe(false); // changed since the run
    d.ranCode = d.code;
    d.run = { ...d.run, unavailable: true };
    expect(isReady(s, d)).toBe(false); // nothing actually ran
    d.run = { results: { k1: false, k2: false }, got: {}, output: "", error: "" };
    d.faulty = true;
    expect(buildAnswer(s, d)).toMatchObject({ faulty: true });
  });

  it("shows the editor and never the checks or the answer before a run", () => {
    const out = html(s);
    expect(out).toContain('data-testid="code-editor"');
    expect(out).toContain('data-testid="code-run"');
    expect(out).not.toContain("return n * 2");
    expect(out).not.toContain("doubles 2");
  });

  it("afterwards: each check plainly, what was printed, one way to write it", () => {
    const out = html({
      ...s, status: "answered", grade: { outcome: "partial" },
      answer: { code: "function double(n) { return n + 2 }", results: { k1: true, k2: false }, output: "trying", error: "" },
      reveal: { solution: "function double(n) { return n * 2 }", explain_md: "Multiply.", checks: [{ id: "k1", label: "doubles 2" }, { id: "k2", label: "keeps 0" }] } as never,
    });
    expect(out).toContain('data-testid="code-check-k1" data-pass="true"');
    expect(out).toContain('data-testid="code-check-k2" data-pass="false"');
    expect(out).toContain("double(0) should give 0");
    expect(out).toContain("trying");
    expect(out).toContain("return n * 2");
    expect(out).not.toContain('data-testid="code-run"');
  });

  it("trusts nothing that comes back from the sandbox", () => {
    const r = tidy({ results: { k1: "yes", k2: true, extra: true }, got: { k1: 5, k2: "x".repeat(900) }, output: 7, error: { a: 1 }, line: "3" }, checks);
    expect(r.results).toEqual({ k1: false, k2: true });
    expect(r.got.k1).toBeUndefined();
    expect(r.got.k2).toHaveLength(200);
    expect(r.output).toBe("");
    expect(r.error).toBe("");
    expect(r.line).toBeNull();
    expect(passedAll(r, checks)).toBe(false);
    expect(passedAll(tidy({ results: { k1: true, k2: true } }, checks), checks)).toBe(true);
    expect(tidy(null, checks).results).toEqual({ k1: false, k2: false });
  });
});
