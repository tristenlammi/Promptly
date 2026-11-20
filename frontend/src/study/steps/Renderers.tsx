import { ArrowDown, ArrowUp, Check, GripVertical, Play, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Opt, PublicByKind, RevealByKind, Step, StepKind, WStep } from "@/api/study";
import { cn } from "@/utils/cn";

import { isSound, passedAll, runCode } from "../code/runner";
import { Figure, initialFigureState } from "../figures/Figure";
import { Thinking } from "../ui/bits";
import { Diagram } from "../ui/Diagram";
import { Md } from "../ui/Md";
import { DictateButton } from "../ui/Voice";
import { CAPSTONE_MAX, clearPair, CODE_MAX, moveItem, setPair, WRITTEN_MAX, type Draft } from "./answers";
import { appendDictation } from "./speech";

/*
 * One renderer per step kind. Each shows the step, takes the learner's
 * draft, and once the step is answered shows the key on top of what they
 * chose. Sending, hints and feedback belong to the lesson player.
 */

export interface StepProps<K extends StepKind = StepKind> {
  step: Step<K>;
  draft: Draft;
  setDraft: (d: Draft) => void;
  /** Answered, or being sent: nothing can be changed. */
  locked: boolean;
  /** A written answer can be spoken (this server and browser can do it). */
  canDictate?: boolean;
}

const ANGLE_WORDS: Record<string, string> = {
  analogy: "Another way in: a comparison",
  example: "Another way in: a worked example",
  step_by_step: "Another way in: one step at a time",
  contrast: "Another way in: what it isn't",
};

function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: "soft" | "plain" }) {
  return (
    <div className={cn("rounded-2xl border p-4", tone === "soft" ? "border-transparent bg-[var(--st-soft)]" : "border-[var(--border)] bg-[var(--surface)]", className)}>
      {children}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{children}</p>;
}

type Mark = "right" | "wrong" | "missed" | null;

/** One choice in a list of choices. */
function Choice({
  selected,
  mark,
  onPick,
  disabled,
  index,
  children,
  note,
  mono,
}: {
  selected: boolean;
  mark: Mark;
  onPick: () => void;
  disabled: boolean;
  index?: number;
  children: ReactNode;
  note?: ReactNode;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onPick}
      data-mark={mark ?? undefined}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-[15px] leading-snug transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
        mark === "right" && "border-[var(--st-good-border)] bg-[var(--st-good-bg)]",
        mark === "wrong" && "study-shake border-[var(--st-bad-border)] bg-[var(--st-bad-bg)]",
        mark === "missed" && "border-dashed border-[var(--st-good-border)]",
        !mark && selected && "border-[var(--st-accent)] bg-[var(--st-soft)]",
        !mark && !selected && "border-[var(--border)] bg-[var(--surface)]",
        !disabled && !selected && "hover:border-[var(--st-accent)] active:scale-[0.99]",
        disabled && !mark && !selected && "opacity-60"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
          mark === "right" || mark === "missed"
            ? "border-transparent bg-[var(--st-good)] text-white"
            : mark === "wrong"
              ? "border-transparent bg-[var(--st-bad)] text-white"
              : selected
                ? "border-transparent bg-[var(--st-accent)] text-white"
                : "border-[var(--st-line)] text-[var(--text-muted)]"
        )}
      >
        {mark === "right" || mark === "missed" ? <Check className="h-3.5 w-3.5" /> : mark === "wrong" ? <X className="h-3.5 w-3.5" /> : index !== undefined ? index + 1 : ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[var(--text)]", mono && "font-mono text-sm")}>{children}</span>
        {mark && <span className="sr-only">{mark === "right" ? " (right, your answer)" : mark === "wrong" ? " (your answer, not right)" : " (the right answer)"}</span>}
        {note && <span className="mt-1 block text-sm text-[var(--text-muted)]">{note}</span>}
      </span>
    </button>
  );
}

function Options({
  options,
  picked,
  onPick,
  locked,
  correctId,
  notes,
  label,
}: {
  options: Opt[];
  picked: string | null;
  onPick: (id: string) => void;
  locked: boolean;
  correctId?: string;
  notes?: Record<string, string>;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {options.map((o, i) => {
        const mark: Mark = correctId ? (o.id === correctId ? (picked === o.id ? "right" : "missed") : picked === o.id ? "wrong" : null) : null;
        return (
          <Choice
            key={o.id}
            index={i}
            selected={picked === o.id}
            mark={mark}
            disabled={locked}
            onPick={() => onPick(o.id)}
            note={correctId && (o.id === correctId || picked === o.id) ? notes?.[o.id] : undefined}
          >
            <Md text={o.text} line />
          </Choice>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- explain

export function ExplainStep({ step }: StepProps<"explain">) {
  const p = step.public;
  return (
    <div className="flex flex-col gap-4">
      {ANGLE_WORDS[p.angle] && <p className="text-xs font-semibold uppercase tracking-wide text-[var(--st-accent-text)]">{ANGLE_WORDS[p.angle]}</p>}
      {p.title && <h2 className="text-xl font-semibold leading-tight text-[var(--text)]">{p.title}</h2>}
      <Md text={p.body_md} />
      {p.figure ? <Figure spec={p.figure} /> : p.diagram && <Diagram spec={p.diagram} />}
      {p.key_points.length > 0 && (
        <Card tone="soft">
          <Label>Take away</Label>
          <ul className="flex flex-col gap-1.5">
            {p.key_points.map((k, i) => (
              <li key={i} className="flex gap-2 text-[15px] text-[var(--text)]">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--st-accent-text)]" />
                <span>{k}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------- predict and mcq

export function PredictStep({ step, draft, setDraft, locked }: StepProps<"predict">) {
  const p = step.public;
  const r = step.reveal;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Label>Picture this</Label>
        <Md text={p.setup_md} />
      </Card>
      <div>
        <Md text={p.question_md} className="font-medium" />
        {!r && <p className="mt-1 text-sm text-[var(--text-muted)]">Commit to a guess before you're told. Being wrong here is useful.</p>}
      </div>
      <Options label="Your prediction" options={p.options} picked={draft.optionId} onPick={(id) => setDraft({ ...draft, optionId: id })} locked={locked} correctId={r?.correct_id} notes={r?.notes} />
      {r?.explain_md && (
        <Card tone="soft" className="study-in">
          <Label>What actually happens</Label>
          <Md text={r.explain_md} />
        </Card>
      )}
    </div>
  );
}

export function McqStep({ step, draft, setDraft, locked }: StepProps<"mcq">) {
  const p = step.public;
  const r = step.reveal;
  return (
    <div className="flex flex-col gap-4">
      <Md text={p.question_md} className="text-[17px] font-medium" />
      <Options label="Choices" options={p.options} picked={draft.optionId} onPick={(id) => setDraft({ ...draft, optionId: id })} locked={locked} correctId={r?.correct_id} notes={r?.notes} />
      {r?.explain_md && (
        <Card tone="soft" className="study-in">
          <Label>The idea</Label>
          <Md text={r.explain_md} compact />
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------ order steps

export function OrderStep({ step, draft, setDraft, locked }: StepProps<"order_steps">) {
  const p = step.public;
  const r = step.reveal;
  const byId = new Map(p.items.map((i) => [i.id, i]));
  const order = draft.order.length === p.items.length ? draft.order : p.items.map((i) => i.id);
  const listRef = useRef<HTMLOListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [moved, setMoved] = useState("");
  const orderRef = useRef(order);
  orderRef.current = order;

  const move = (from: number, to: number) => {
    const next = moveItem(orderRef.current, from, to);
    if (next === orderRef.current) return;
    setDraft({ ...draft, order: next });
    setMoved(`${byId.get(orderRef.current[from])?.text ?? "Step"} moved to place ${to + 1} of ${next.length}`);
  };

  // Drag by the handle: the row follows the pointer by changing places with
  // whichever row the pointer is over.
  const onDrag = (e: React.PointerEvent, id: string) => {
    if (locked) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(id);
  };
  const onDragMove = (e: React.PointerEvent, id: string) => {
    if (dragging !== id || !listRef.current) return;
    const rows = Array.from(listRef.current.children) as HTMLElement[];
    const from = orderRef.current.indexOf(id);
    let to = from;
    rows.forEach((row, i) => {
      const b = row.getBoundingClientRect();
      if (e.clientY >= b.top && e.clientY <= b.bottom) to = i;
    });
    if (rows.length) {
      const first = rows[0].getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      if (e.clientY < first.top) to = 0;
      if (e.clientY > last.bottom) to = rows.length - 1;
    }
    if (to !== from) move(from, to);
  };

  return (
    <div className="flex flex-col gap-4">
      <Md text={p.prompt_md} className="text-[17px] font-medium" />
      {!r && <p className="-mt-2 text-sm text-[var(--text-muted)]">Drag by the handle, or use the arrows. First at the top.</p>}
      <ol ref={listRef} className="flex flex-col gap-2">
        {order.map((id, i) => {
          const item = byId.get(id);
          if (!item) return null;
          const rightPlace = r ? r.order.indexOf(id) : -1;
          const ok = r ? rightPlace === i : null;
          return (
            <li
              key={id}
              className={cn(
                "flex items-center gap-2 rounded-xl border bg-[var(--surface)] py-2 pl-1.5 pr-2 transition-shadow",
                dragging === id ? "z-10 border-[var(--st-accent)] shadow-lg" : "border-[var(--border)]",
                ok === true && "border-[var(--st-good-border)] bg-[var(--st-good-bg)]",
                ok === false && "border-[var(--st-bad-border)] bg-[var(--st-bad-bg)]"
              )}
            >
              {!r && (
                <span
                  aria-hidden
                  onPointerDown={(e) => onDrag(e, id)}
                  onPointerMove={(e) => onDragMove(e, id)}
                  onPointerUp={() => setDragging(null)}
                  onPointerCancel={() => setDragging(null)}
                  className={cn("flex h-11 w-8 shrink-0 touch-none items-center justify-center rounded-md text-[var(--text-muted)]", locked ? "opacity-40" : "cursor-grab active:cursor-grabbing hover:bg-[var(--hover)]")}
                >
                  <GripVertical className="h-5 w-5" />
                </span>
              )}
              <span
                aria-hidden
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  ok === true ? "bg-[var(--st-good)] text-white" : ok === false ? "bg-[var(--st-bad)] text-white" : "bg-[var(--hover-strong)] text-[var(--text-muted)]",
                  r && "ml-2"
                )}
              >
                {ok === true ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1 text-[15px] leading-snug text-[var(--text)]">
                <Md text={item.text} line />
                {ok === false && <span className="mt-0.5 block text-xs text-[var(--text-muted)]">Belongs at place {rightPlace + 1}</span>}
              </span>
              {!r && (
                <span className="flex shrink-0 gap-0.5">
                  <button type="button" disabled={locked || i === 0} onClick={() => move(i, i - 1)} aria-label={`Move "${item.text}" up`} className="flex h-10 w-9 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] disabled:opacity-30">
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button type="button" disabled={locked || i === order.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move "${item.text}" down`} className="flex h-10 w-9 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] disabled:opacity-30">
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {moved}
      </p>
      {r?.explain_md && (
        <Card tone="soft" className="study-in">
          <Label>Why this order</Label>
          <Md text={r.explain_md} compact />
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------ match pairs

export function MatchStep({ step, draft, setDraft, locked }: StepProps<"match_pairs">) {
  const p = step.public;
  const r = step.reveal;
  const [active, setActive] = useState<string | null>(null);
  const rightById = new Map(p.right.map((x) => [x.id, x]));
  const used = new Set(Object.values(draft.pairs));
  // The next left side still without a partner is the one a tap on the right fills.
  const target = active ?? p.left.find((l) => !draft.pairs[l.id])?.id ?? null;

  const pickRight = (rid: string) => {
    if (locked || !target) return;
    setDraft({ ...draft, pairs: setPair(draft.pairs, target, rid) });
    setActive(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <Md text={p.prompt_md} className="text-[17px] font-medium" />
      {!r && <p className="-mt-2 text-sm text-[var(--text-muted)]">Tap one on the left, then the one it goes with.</p>}
      <ul className="flex flex-col gap-2">
        {p.left.map((l) => {
          const rid = draft.pairs[l.id];
          // Left blank (an "I don't know"): the answer is simply shown, not marked wrong.
          const ok = r && rid ? r.pairs[l.id] === rid : null;
          const isTarget = !r && target === l.id;
          return (
            <li
              key={l.id}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-2 rounded-xl border p-1.5",
                ok === true ? "border-[var(--st-good-border)] bg-[var(--st-good-bg)]" : ok === false ? "border-[var(--st-bad-border)] bg-[var(--st-bad-bg)]" : isTarget ? "border-[var(--st-accent)] bg-[var(--st-softer)]" : "border-[var(--border)] bg-[var(--surface)]"
              )}
            >
              <button
                type="button"
                disabled={locked}
                aria-pressed={isTarget}
                onClick={() => setActive(l.id)}
                className="rounded-lg px-2 py-2 text-left text-[15px] font-medium leading-snug text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
              >
                {l.text}
              </button>
              {rid ? (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setDraft({ ...draft, pairs: clearPair(draft.pairs, l.id) });
                    setActive(l.id);
                  }}
                  aria-label={r ? undefined : `${l.text} goes with ${rightById.get(rid)?.text}. Tap to change.`}
                  className={cn(
                    "study-pop flex items-center justify-between gap-1 rounded-lg px-2.5 py-2 text-left text-sm leading-snug text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
                    r ? "bg-transparent" : "bg-[var(--st-soft)]"
                  )}
                >
                  <span>
                    {rightById.get(rid)?.text}
                    {ok === false && r && <span className="mt-0.5 block text-xs text-[var(--text-muted)]">Goes with: {rightById.get(r.pairs[l.id])?.text}</span>}
                  </span>
                  {ok === true ? <Check aria-hidden className="h-4 w-4 shrink-0 text-[var(--st-good)]" /> : ok === false ? <X aria-hidden className="h-4 w-4 shrink-0 text-[var(--st-bad)]" /> : <X aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />}
                </button>
              ) : (
                <span className={cn("flex items-center rounded-lg border border-dashed px-2.5 py-2 text-sm", isTarget ? "border-[var(--st-accent)] text-[var(--st-accent-text)]" : "border-[var(--st-line)] text-[var(--text-muted)]")}>
                  {r ? <span className="text-[var(--text)]">{rightById.get(r.pairs[l.id])?.text}</span> : isTarget ? "Pick below" : "…"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!r && (
        <div role="group" aria-label="Goes with" className="flex flex-wrap gap-2">
          {p.right.map((x) => (
            <button
              key={x.id}
              type="button"
              disabled={locked || !target}
              onClick={() => pickRight(x.id)}
              className={cn(
                "rounded-xl border px-3 py-2 text-left text-sm leading-snug transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
                used.has(x.id) ? "border-dashed border-[var(--st-line)] text-[var(--text-muted)] opacity-60" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--st-accent)] active:scale-[0.98]"
              )}
            >
              {x.text}
            </button>
          ))}
        </div>
      )}
      {r?.explain_md && (
        <Card tone="soft" className="study-in">
          <Md text={r.explain_md} compact />
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------- spot error

export function SpotErrorStep({ step, draft, setDraft, locked }: StepProps<"spot_error">) {
  const p = step.public;
  const r = step.reveal;
  return (
    <div className="flex flex-col gap-4">
      <Md text={p.intro_md} className="text-[17px] font-medium" />
      {!r && <p className="-mt-2 text-sm text-[var(--text-muted)]">One line is wrong. Tap it.</p>}
      <div role="radiogroup" aria-label="Lines" className="flex flex-col gap-1.5">
        {p.lines.map((l, i) => {
          const mark: Mark = r ? (l.id === r.error_id ? (draft.lineId === l.id ? "right" : "missed") : draft.lineId === l.id ? "wrong" : null) : null;
          return (
            <Choice key={l.id} index={i} selected={draft.lineId === l.id} mark={mark} disabled={locked} onPick={() => setDraft({ ...draft, lineId: l.id })}>
              <Md text={l.text} line />
            </Choice>
          );
        })}
      </div>
      {r && (
        <Card tone="soft" className="study-in">
          {r.correction && (
            <>
              <Label>Put right</Label>
              <Md text={r.correction} compact className="mb-2 font-medium" />
            </>
          )}
          <Md text={r.explain_md} compact />
        </Card>
      )}
    </div>
  );
}

// --------------------------------------------------------- worked example

export function WorkedStep({ step, draft, setDraft, locked }: StepProps<"worked_example">) {
  const p = step.public;
  const r = step.reveal;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Label>The problem</Label>
        <Md text={p.problem_md} />
      </Card>
      <ol className="relative flex flex-col gap-3 border-l-2 border-[var(--st-line)] pl-4">
        {p.steps.map((s: WStep, i) => (
          <li key={s.id} className="relative">
            <span aria-hidden className={cn("absolute -left-[27px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold", s.blank ? "bg-[var(--st-accent)] text-white" : "bg-[var(--hover-strong)] text-[var(--text-muted)]")}>
              {i + 1}
            </span>
            {s.blank ? (
              <div className="flex flex-col gap-2">
                <Md text={s.text_md} compact className="font-medium" />
                <div role="radiogroup" aria-label={`Step ${i + 1}`} className="flex flex-col gap-1.5">
                  {s.options.map((o) => {
                    const picked = draft.blanks[s.id] === o.id;
                    const right = r?.blanks[s.id];
                    const mark: Mark = right ? (o.id === right ? (picked ? "right" : "missed") : picked ? "wrong" : null) : null;
                    return (
                      <Choice key={o.id} selected={picked} mark={mark} disabled={locked} onPick={() => setDraft({ ...draft, blanks: { ...draft.blanks, [s.id]: o.id } })}>
                        <Md text={o.text} line />
                      </Choice>
                    );
                  })}
                </div>
                {r?.notes[s.id] && <Md text={r.notes[s.id]} compact className="study-in rounded-lg bg-[var(--st-soft)] px-3 py-2" />}
              </div>
            ) : (
              <Md text={s.text_md} compact />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------ explain back / scenario

type WrittenKind = "explain_back" | "scenario" | "capstone";

function Written({
  step,
  draft,
  setDraft,
  locked,
  placeholder,
  canDictate,
  max = WRITTEN_MAX,
  rows = 6,
  owners,
}: StepProps<WrittenKind> & { placeholder: string; max?: number; rows?: number; owners?: string[] }) {
  const r = step.reveal as RevealByKind["explain_back"] | null;
  const met = new Set(((step.grade?.detail as { met?: number[] } | undefined)?.met ?? []) as number[]);
  const n = draft.text.length;
  if (r) {
    return (
      <div className="flex flex-col gap-3">
        <Card>
          <Label>Your answer</Label>
          <p className="whitespace-pre-wrap text-[15px] text-[var(--text)]">{draft.text || <span className="text-[var(--text-muted)]">No answer</span>}</p>
        </Card>
        <Rubric rubric={r.rubric} met={met} owners={owners} />
        <ModelAnswer text={r.model_answer_md} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
    <label className="flex flex-col gap-1.5">
      <span className="sr-only">Your answer</span>
      <textarea
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value.slice(0, max) })}
        disabled={locked}
        rows={rows}
        // A keyboard is already there on a computer; on a phone it would cover the question.
        autoFocus={typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true}
        placeholder={placeholder}
        className="min-h-[9rem] w-full resize-y rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-[16px] leading-relaxed text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-soft)] disabled:opacity-70"
      />
      <span className="flex justify-between text-xs text-[var(--text-muted)]">
        <span>Your own words. Spelling doesn't matter.</span>
        {n > max - 400 && <span>{max - n} left</span>}
      </span>
    </label>
    {canDictate && !locked && <DictateButton onText={(spoken) => setDraft({ ...draft, text: appendDictation(draft.text, spoken, max) })} />}
    </div>
  );
}

function Rubric({ rubric, met, owners }: { rubric: string[]; met: Set<number>; owners?: string[] }) {
  if (!rubric.length) return null;
  return (
    <Card>
      <Label>What a good answer covers</Label>
      <ul className="flex flex-col gap-1.5">
        {rubric.map((x, i) => (
          <li key={i} className="flex gap-2 text-[15px]">
            <span aria-hidden className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full", met.has(i) ? "bg-[var(--st-good)] text-white" : "border border-[var(--st-line)] text-transparent")}>
              <Check className="h-3 w-3" />
            </span>
            <span className={met.has(i) ? "text-[var(--text)]" : "text-[var(--text-muted)]"}>
              {x}
              <span className="sr-only">{met.has(i) ? " (you covered this)" : " (missing from your answer)"}</span>
              {owners?.[i] && <span className="block text-xs text-[var(--text-muted)]">Shows: {owners[i]}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ModelAnswer({ text }: { text: string }) {
  if (!text) return null;
  return (
    <details className="group rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold text-[var(--st-accent-text)] focus:outline-none focus-visible:underline">
        <span className="group-open:hidden">See a good answer</span>
        <span className="hidden group-open:inline">A good answer</span>
      </summary>
      <Md text={text} compact className="mt-2" />
    </details>
  );
}

export function ExplainBackStep(props: StepProps<"explain_back">) {
  return (
    <div className="flex flex-col gap-4">
      <Md text={props.step.public.prompt_md} className="text-[17px] font-medium" />
      <Written {...(props as unknown as StepProps<WrittenKind>)} placeholder="Explain it the way you'd say it out loud…" />
    </div>
  );
}

export function ScenarioStep(props: StepProps<"scenario">) {
  const p = props.step.public;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Label>The situation</Label>
        <Md text={p.scenario_md} />
      </Card>
      <Md text={p.question_md} className="text-[17px] font-medium" />
      <Written {...(props as unknown as StepProps<WrittenKind>)} placeholder="What would you do, and why?" />
    </div>
  );
}

// ---------------------------------------------------------------- capstone

/** A unit's (or the subject's) applied task: several ideas, used together. */
export function CapstoneStep(props: StepProps<"capstone">) {
  const p = props.step.public;
  const r = props.step.reveal;
  const title = new Map(p.concepts.map((c) => [c.id, c.title]));
  const owners = r?.rubric_concepts.map((id) => title.get(id) ?? "");
  return (
    <div className="flex flex-col gap-4" data-testid="study-capstone">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--st-accent-text)]">{p.scope === "final" ? "The final task" : "Unit task"}</p>
        <h2 className="mt-0.5 text-xl font-semibold leading-tight text-[var(--text)]">{p.title}</h2>
      </div>
      <Card>
        <Label>The task</Label>
        <Md text={p.task_md} />
      </Card>
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">It draws on</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Ideas this task draws on">
          {p.concepts.map((c) => (
            <li key={c.id} className="rounded-full bg-[var(--st-soft)] px-2.5 py-1 text-xs font-medium text-[var(--st-accent-text)]">
              {c.title}
            </li>
          ))}
        </ul>
      </div>
      <Written {...(props as unknown as StepProps<WrittenKind>)} placeholder="Take your time. Use what you've learned, and say why." max={CAPSTONE_MAX} rows={9} owners={owners} />
    </div>
  );
}

// ---------------------------------------------------------- teach student

export function TeachStudentStep({
  step,
  locked,
  onTurn,
  sending,
  error,
}: StepProps<"teach_student"> & { onTurn: (text: string) => void; sending: boolean; error: string | null }) {
  const p = step.public as PublicByKind["teach_student"];
  const r = step.reveal;
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const turnsLeft = step.turns_left ?? Math.max(0, p.max_turns - step.turns.filter((t) => t.role === "learner").length);
  const last = step.turns[step.turns.length - 1];
  const resolved = last?.role === "student" && last.resolved === true;
  const canWrite = !locked && !r && turnsLeft > 0 && !resolved && !sending;
  const met = new Set(((step.grade?.detail as { met?: number[] } | undefined)?.met ?? []) as number[]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [step.turns.length, sending]);

  // The reply arrived: clear the box (it is kept while a send fails).
  const sentCount = useRef(step.turns.length);
  useEffect(() => {
    if (step.turns.length > sentCount.current) setText("");
    sentCount.current = step.turns.length;
  }, [step.turns.length]);

  const send = () => {
    const t = text.trim();
    if (!t || !canWrite) return;
    onTurn(t);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--text-muted)]">
        {p.student_name} has the wrong idea. Put {p.student_name} right, the way a good teacher would. You have {p.max_turns} goes.
      </p>
      <div className="flex flex-col gap-2.5" role="log" aria-label={`Conversation with ${p.student_name}`}>
        <Bubble who={p.student_name}>
          <Md text={p.opening_md} compact />
        </Bubble>
        {step.turns.map((t, i) =>
          t.role === "learner" ? (
            <Bubble key={i} mine>
              <p className="whitespace-pre-wrap">{t.text}</p>
            </Bubble>
          ) : (
            <Bubble key={i} who={p.student_name} happy={t.resolved}>
              <Md text={t.text} compact />
            </Bubble>
          )
        )}
        {sending && (
          <Bubble who={p.student_name}>
            <Thinking label={`${p.student_name} is thinking`} />
          </Bubble>
        )}
        <div ref={endRef} />
      </div>
      {error && <p className="text-sm text-[var(--st-bad)]">{error}</p>}
      {!r && (
        <>
          {resolved ? (
            <p className="study-in rounded-xl bg-[var(--st-good-bg)] px-3 py-2 text-sm text-[var(--text)]">{p.student_name} gets it now. Finish to see how you did.</p>
          ) : turnsLeft === 0 ? (
            <p className="rounded-xl bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text-muted)]">That's your {p.max_turns} goes. Finish to see how you did.</p>
          ) : (
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Your explanation for {p.student_name}</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, 2000))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  disabled={!canWrite}
                  rows={3}
                  placeholder={`Explain it to ${p.student_name}…`}
                  className="w-full resize-none rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[16px] leading-snug text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-soft)] disabled:opacity-70"
                />
              </label>
              <button
                type="button"
                onClick={send}
                disabled={!canWrite || !text.trim()}
                aria-label={`Send to ${p.student_name}`}
                className="mb-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:opacity-40"
              >
                <Send className="h-5 w-5" />
              </button>
            </div>
          )}
          {turnsLeft > 0 && !resolved && (
            <p className="text-xs text-[var(--text-muted)]">
              {turnsLeft} {turnsLeft === 1 ? "go" : "goes"} left
            </p>
          )}
        </>
      )}
      {r && (
        <div className="flex flex-col gap-3">
          {r.misconception && (
            <Card>
              <Label>What {p.student_name} had wrong</Label>
              <p className="text-[15px] text-[var(--text)]">{r.misconception}</p>
            </Card>
          )}
          <Rubric rubric={r.rubric} met={met} />
          <ModelAnswer text={r.model_answer_md} />
        </div>
      )}
    </div>
  );
}

function Bubble({ children, who, mine, happy }: { children: ReactNode; who?: string; mine?: boolean; happy?: boolean }) {
  return (
    <div className={cn("study-in flex flex-col", mine ? "items-end" : "items-start")}>
      <span className="mb-0.5 px-1 text-xs text-[var(--text-muted)]">{mine ? "You" : who}</span>
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-snug",
          mine ? "rounded-br-md bg-[var(--accent-strong)] text-white" : happy ? "rounded-bl-md border border-[var(--st-good-border)] bg-[var(--st-good-bg)] text-[var(--text)]" : "rounded-bl-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
        )}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- explore

const EXPLORE_HOW: Record<string, string> = {
  plot: "Move the sliders. The curve follows.",
  scale: "Drag the point to where it belongs.",
  parts: "Tap the part you think it is.",
  table: "Change the numbers and watch what they do.",
};

export function ExploreStep({ step, draft, setDraft, locked }: StepProps<"explore">) {
  const p = step.public;
  const r = step.reveal;
  // Once answered the figure comes back whole (a parts figure's notes with it).
  const spec = r?.figure ?? p.figure;
  const state = draft.fig ?? initialFigureState(spec);
  const right = step.grade?.outcome === "correct";
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Md text={p.prompt_md} className="text-[17px] font-medium" />
        {!r && <p className="mt-1 text-sm text-[var(--text-muted)]">{EXPLORE_HOW[spec.type]}</p>}
      </div>
      <Figure spec={spec} state={state} onChange={(fig) => setDraft({ ...draft, fig })} locked={locked} pick targets={p.targets} solution={r && !right ? r.solution : undefined} />
      {r?.explain_md && (
        <Card tone="soft" className="study-in">
          <Label>Why</Label>
          <Md text={r.explain_md} compact />
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------- write code

export function WriteCodeStep({ step, draft, setDraft, locked }: StepProps<"write_code">) {
  const p = step.public;
  const r = step.reveal;
  const checks = p.run.checks;
  const [running, setRunning] = useState(false);
  // Whether this step's own answer passes its own checks (found out once, when a run fails).
  const sound = useRef<boolean | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const area = useRef<HTMLTextAreaElement>(null);

  const run = async () => {
    if (running || locked) return;
    const code = draftRef.current.code;
    setRunning(true);
    const result = await runCode(code, checks);
    let faulty = false;
    if (!result.unavailable && !passedAll(result, checks)) {
      if (sound.current === null) sound.current = await isSound(p.run.solution, checks);
      faulty = sound.current === false;
    }
    setRunning(false);
    setDraft({ ...draftRef.current, run: result, ranCode: code, faulty });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void run();
      return;
    }
    // Tab indents (Escape first to tab out of the box, as code editors do).
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const el = e.currentTarget;
      if (el.dataset.escaped === "1") return;
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = el;
      const next = `${value.slice(0, a)}  ${value.slice(b)}`;
      setDraft({ ...draft, code: next });
      requestAnimationFrame(() => {
        if (area.current) area.current.selectionStart = area.current.selectionEnd = a + 2;
      });
    } else if (e.key === "Escape") {
      e.currentTarget.dataset.escaped = "1";
    } else {
      delete e.currentTarget.dataset.escaped;
    }
  };

  const res = draft.run;
  const stale = !!res && draft.ranCode !== draft.code;
  const lines = Math.min(22, Math.max(6, draft.code.split("\n").length + 1));
  const labels = Object.fromEntries((r?.checks ?? []).map((c) => [c.id, c.label]));
  return (
    <div className="flex flex-col gap-4">
      <Md text={p.prompt_md} className="text-[16px]" />
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor={`code-${step.id}`} className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Your code <span className="font-normal normal-case">(JavaScript)</span>
          </label>
          {!locked && draft.code !== p.starter && (
            <button
              type="button"
              onClick={() => setDraft({ ...draft, code: p.starter })}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
            >
              <RotateCcw aria-hidden className="h-3.5 w-3.5" /> Start again
            </button>
          )}
        </div>
        <textarea
          ref={area}
          id={`code-${step.id}`}
          data-testid="code-editor"
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value.slice(0, CODE_MAX) })}
          onKeyDown={onKeyDown}
          readOnly={locked}
          rows={lines}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-describedby={`code-help-${step.id}`}
          className="block w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[13.5px] leading-relaxed text-[var(--text)] [tab-size:2] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-accent)]"
        />
        <p id={`code-help-${step.id}`} className="mt-1 text-xs text-[var(--text-muted)]">
          Tab indents (press Escape first to move on with Tab). Ctrl+Enter runs it. It runs here in your browser, shut off from everything else.
        </p>
      </div>
      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || !draft.code.trim()}
            data-testid="code-run"
            className="study-press flex min-h-[2.5rem] items-center gap-1.5 rounded-full border border-[var(--st-accent)] px-4 text-sm font-semibold text-[var(--st-accent-text)] hover:bg-[var(--st-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] disabled:opacity-50"
          >
            <Play aria-hidden className="h-4 w-4" /> {running ? "Running…" : res ? "Run again" : "Run"}
          </button>
          {stale && !running && <span className="text-sm text-[var(--text-muted)]">You've changed the code since the last run. Run it again before you hand it in.</span>}
        </div>
      )}
      {res && (
        <section aria-label="What happened when it ran" aria-live="polite" data-testid="code-result" className={cn("flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4", stale && "opacity-60")}>
          {res.unavailable ? (
            <p role="alert" className="text-sm text-[var(--st-bad)]">
              {res.error} You can still say "I don't know" to move on.
            </p>
          ) : (
            <>
              {res.error && (
                <p className="rounded-xl border border-[var(--st-bad-border)] bg-[var(--st-bad-bg)] px-3 py-2 font-mono text-[13px] text-[var(--text)]" data-testid="code-error">
                  {res.line ? `Line ${res.line}: ` : ""}
                  {res.error}
                </p>
              )}
              <ul className="flex flex-col gap-1.5" aria-label="Checks">
                {checks.map((c) => {
                  const ok = res.results[c.id] === true;
                  return (
                    <li key={c.id} className="flex items-start gap-2 text-sm text-[var(--text)]" data-testid={`code-check-${c.id}`} data-pass={ok}>
                      <span aria-hidden className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white", ok ? "bg-[var(--st-good)]" : "bg-[var(--st-bad)]")}>
                        {ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0">
                        <span className="sr-only">{ok ? "Passed: " : "Failed: "}</span>
                        {labels[c.id] ?? (c.label || c.call)}
                        {!ok && !res.error && (
                          <span className="mt-0.5 block font-mono text-[12.5px] text-[var(--text-muted)]">
                            {c.call} should give {JSON.stringify(c.expect)}
                            {res.got[c.id] !== undefined ? `, but gave ${res.got[c.id]}` : ""}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {res.output && (
                <div>
                  <Label>What it printed</Label>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--bg)] p-3 font-mono text-[12.5px] text-[var(--text)]">{res.output}</pre>
                </div>
              )}
              {draft.faulty && !locked && (
                <p className="rounded-xl border border-[var(--st-warn-border)] bg-[var(--st-warn-bg)] px-3 py-2 text-sm text-[var(--text)]" data-testid="code-faulty">
                  This task has a fault in it: its own answer doesn't pass these checks. Hand it in and it won't count against you.
                </p>
              )}
            </>
          )}
        </section>
      )}
      {r && (
        <>
          {r.explain_md && (
            <Card tone="soft" className="study-in">
              <Label>The idea</Label>
              <Md text={r.explain_md} compact />
            </Card>
          )}
          <details className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--text)]">One way to write it</summary>
            <pre className="mt-3 overflow-auto rounded-xl bg-[var(--bg)] p-3 font-mono text-[13px] leading-relaxed text-[var(--text)]" data-testid="code-solution">
              {r.solution}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- switch

export function StepBody(props: StepProps & { onTurn: (text: string) => void; sending: boolean; turnError: string | null }) {
  const { onTurn, sending, turnError, ...rest } = props;
  switch (props.step.kind) {
    case "explain":
      return <ExplainStep {...(rest as StepProps<"explain">)} />;
    case "predict":
      return <PredictStep {...(rest as StepProps<"predict">)} />;
    case "mcq":
      return <McqStep {...(rest as StepProps<"mcq">)} />;
    case "order_steps":
      return <OrderStep {...(rest as StepProps<"order_steps">)} />;
    case "match_pairs":
      return <MatchStep {...(rest as StepProps<"match_pairs">)} />;
    case "spot_error":
      return <SpotErrorStep {...(rest as StepProps<"spot_error">)} />;
    case "worked_example":
      return <WorkedStep {...(rest as StepProps<"worked_example">)} />;
    case "explain_back":
      return <ExplainBackStep {...(rest as StepProps<"explain_back">)} />;
    case "scenario":
      return <ScenarioStep {...(rest as StepProps<"scenario">)} />;
    case "teach_student":
      return <TeachStudentStep {...(rest as StepProps<"teach_student">)} onTurn={onTurn} sending={sending} error={turnError} />;
    case "capstone":
      return <CapstoneStep {...(rest as StepProps<"capstone">)} />;
    case "explore":
      return <ExploreStep {...(rest as StepProps<"explore">)} />;
    case "write_code":
      return <WriteCodeStep {...(rest as StepProps<"write_code">)} />;
    default:
      return <p className="text-sm text-[var(--text-muted)]">This kind of step can't be shown here yet. Update Promptly, or skip it.</p>;
  }
}
