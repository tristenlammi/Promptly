import type { CodeCheck, Figure, Opt, Step, StepKind, WStep } from "@/api/study";

import type { RunResult } from "../code/runner";
import { figureAnswer, initialFigureState, stateFromAnswer, type FigureState } from "../figures/Figure";

/*
 * What the learner has entered on a step so far (a draft), whether it is
 * enough to send, and the exact object the server wants for each kind.
 * Pure, so the shapes are tested once here and not in every renderer.
 */

export interface Draft {
  optionId: string | null;
  lineId: string | null;
  order: string[];
  /** left id → right id */
  pairs: Record<string, string>;
  /** worked-example step id → option id */
  blanks: Record<string, string>;
  text: string;
  /** Where an explore step's figure is set. */
  fig: FigureState | null;
  /** A write-code step: the code, the last run, and the code that run was of. */
  code: string;
  run: RunResult | null;
  ranCode: string | null;
  /** The step's own answer failed its own checks: it proves nothing. */
  faulty: boolean;
}

export function emptyDraft(step?: Pick<Step, "kind" | "public">): Draft {
  const d: Draft = { optionId: null, lineId: null, order: [], pairs: {}, blanks: {}, text: "", fig: null, code: "", run: null, ranCode: null, faulty: false };
  if (step?.kind === "order_steps") d.order = (step.public as { items: Opt[] }).items.map((i) => i.id);
  if (step?.kind === "explore") d.fig = initialFigureState((step.public as { figure: Figure }).figure);
  if (step?.kind === "write_code") d.code = (step.public as { starter: string }).starter;
  return d;
}

export const CODE_MAX = 8000;

export const WRITTEN_MIN = 2;
export const WRITTEN_MAX = 4000;
/** A capstone answer draws several ideas together: more room. */
export const CAPSTONE_MAX = 8000;

const blankSteps = (steps: WStep[]) => steps.filter((s): s is Extract<WStep, { blank: true }> => s.blank);

/** Enough has been entered to check the answer. */
export function isReady(step: Pick<Step, "kind" | "public" | "turns">, d: Draft): boolean {
  switch (step.kind) {
    case "explain":
      return true;
    case "predict":
    case "mcq":
      return d.optionId !== null;
    case "spot_error":
      return d.lineId !== null;
    case "order_steps": {
      const items = (step.public as { items: Opt[] }).items;
      return d.order.length === items.length && new Set(d.order).size === items.length;
    }
    case "match_pairs": {
      const p = step.public as { left: Opt[]; right: Opt[] };
      const rights = Object.values(d.pairs);
      return p.left.every((l) => d.pairs[l.id]) && new Set(rights).size === rights.length && rights.length === p.left.length;
    }
    case "worked_example":
      return blankSteps((step.public as { steps: WStep[] }).steps).every((s) => d.blanks[s.id]);
    case "explain_back":
    case "scenario": {
      const n = d.text.trim().length;
      return n >= WRITTEN_MIN && n <= WRITTEN_MAX;
    }
    case "capstone": {
      const n = d.text.trim().length;
      return n >= WRITTEN_MIN && n <= CAPSTONE_MAX;
    }
    case "teach_student":
      return step.turns.some((t) => t.role === "learner");
    case "explore": {
      // A figure nobody has touched isn't an answer.
      const fig = (step.public as { figure: Figure }).figure;
      return !!d.fig && (fig.type === "parts" ? d.fig.partId !== null : d.fig.touched);
    }
    case "write_code":
      // Handed in only after a run of exactly this code.
      return d.code.trim().length > 0 && d.code.length <= CODE_MAX && !!d.run && !d.run.unavailable && d.ranCode === d.code;
  }
}

/** The ``answer`` object for ``POST /steps/{id}/answer``. */
export function buildAnswer(step: Pick<Step, "kind" | "public">, d: Draft): Record<string, unknown> {
  switch (step.kind) {
    case "explain":
    case "teach_student":
      return {};
    case "predict":
    case "mcq":
      return { option_id: d.optionId };
    case "spot_error":
      return { line_id: d.lineId };
    case "order_steps":
      return { order: [...d.order] };
    case "match_pairs": {
      const left = (step.public as { left: Opt[] }).left;
      return { pairs: Object.fromEntries(left.filter((l) => d.pairs[l.id]).map((l) => [l.id, d.pairs[l.id]])) };
    }
    case "worked_example": {
      const ids = blankSteps((step.public as { steps: WStep[] }).steps).map((s) => s.id);
      return { blanks: Object.fromEntries(ids.filter((id) => d.blanks[id]).map((id) => [id, d.blanks[id]])) };
    }
    case "explain_back":
    case "scenario":
      return { text: d.text.trim().slice(0, WRITTEN_MAX) };
    case "capstone":
      return { text: d.text.trim().slice(0, CAPSTONE_MAX) };
    case "explore": {
      const fig = (step.public as { figure: Figure }).figure;
      return { ...figureAnswer(fig, d.fig ?? initialFigureState(fig)) };
    }
    case "write_code": {
      const checks = (step.public as { run: { checks: CodeCheck[] } }).run.checks;
      return {
        code: d.code,
        results: Object.fromEntries(checks.map((c) => [c.id, d.run?.results[c.id] === true])),
        output: (d.run?.output ?? "").slice(0, 2000),
        error: (d.run?.error ?? "").slice(0, 500),
        ...(d.faulty ? { faulty: true } : {}),
      };
    }
  }
}

export const DONT_KNOW = { dont_know: true } as const;

/** "I don't know" is offered on every graded kind except the student chat. */
export const canSayDontKnow = (kind: StepKind) => kind !== "explain" && kind !== "teach_student";

/** Kinds graded by code (instant); the rest wait on the teacher. */
export const isInstant = (kind: StepKind) =>
  kind === "predict" ||
  kind === "mcq" ||
  kind === "order_steps" ||
  kind === "match_pairs" ||
  kind === "spot_error" ||
  kind === "worked_example" ||
  kind === "explore" ||
  kind === "write_code";

/** A draft rebuilt from what was sent, to show an answered step again. */
export function draftFromAnswer(step: Pick<Step, "kind" | "public" | "answer">): Draft {
  const d = emptyDraft(step);
  const a = (step.answer ?? {}) as Record<string, unknown>;
  if (typeof a.option_id === "string") d.optionId = a.option_id;
  if (typeof a.line_id === "string") d.lineId = a.line_id;
  if (Array.isArray(a.order)) d.order = a.order.filter((x): x is string => typeof x === "string");
  if (a.pairs && typeof a.pairs === "object") d.pairs = { ...(a.pairs as Record<string, string>) };
  if (a.blanks && typeof a.blanks === "object") d.blanks = { ...(a.blanks as Record<string, string>) };
  if (typeof a.text === "string") d.text = a.text;
  if (step.kind === "explore") d.fig = stateFromAnswer((step.public as { figure: Figure }).figure, step.answer);
  if (step.kind === "write_code") {
    if (typeof a.code === "string") d.code = a.code;
    if (a.results && typeof a.results === "object") {
      d.run = { results: a.results as Record<string, boolean>, got: {}, output: typeof a.output === "string" ? a.output : "", error: typeof a.error === "string" ? a.error : "" };
      d.ranCode = d.code;
    }
    d.faulty = a.faulty === true;
  }
  return d;
}

/** Move the item at ``from`` to ``to`` (order-the-steps: buttons and drag). */
export function moveItem(order: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = [...order];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Pair ``left`` with ``right``; a right side already used elsewhere moves here. */
export function setPair(pairs: Record<string, string>, left: string, right: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [l, r] of Object.entries(pairs)) if (l !== left && r !== right) next[l] = r;
  next[left] = right;
  return next;
}

export function clearPair(pairs: Record<string, string>, left: string): Record<string, string> {
  const next = { ...pairs };
  delete next[left];
  return next;
}

export const KIND_LABEL: Record<StepKind, string> = {
  explain: "New idea",
  predict: "What do you think?",
  mcq: "Quick check",
  order_steps: "Put in order",
  match_pairs: "Match them up",
  spot_error: "Spot the mistake",
  worked_example: "Work it through",
  explain_back: "In your own words",
  scenario: "Use it",
  teach_student: "You're the teacher",
  capstone: "Put it together",
  explore: "Try it yourself",
  write_code: "Write the code",
};

/** The kinds answered in writing: these can be dictated. */
export const isWritten = (kind: StepKind) => kind === "explain_back" || kind === "scenario" || kind === "capstone";
