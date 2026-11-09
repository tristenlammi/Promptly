import { Check, Clock, X } from "lucide-react";
import { useRef, useState } from "react";

import type { QuizResultView } from "@/api/formAnswer";

/**
 * A quiz answer's result, on the answer page (WP-F2.3): only this person's
 * own marks, and only what the form's owner chose to show — a score card
 * ("7 out of 10"), then each question with a tick or a cross, the right
 * answer, points and the owner's feedback line. Before the scores are
 * released it just says they're coming.
 */
export function QuizResult({ result }: { result: QuizResultView }) {
  if (!result.released) {
    return (
      <div className="flex items-start gap-2 rounded-xl p-3 text-[15px]" style={{ background: "var(--pf-hover)" }} data-testid="quiz-waiting">
        <Clock className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--pf-accent)" }} aria-hidden="true" />
        <p>Your answers are in. Scores come once they&apos;ve been checked.</p>
      </div>
    );
  }
  const items = result.items ?? [];
  const pending = result.pending ?? 0;
  return (
    <section className="flex flex-col gap-3" aria-label="Your score" data-testid="quiz-result">
      {result.score !== undefined && result.max !== undefined && (
        <div className="flex flex-col items-center gap-1 rounded-xl px-4 py-5 text-center" style={{ background: "var(--pf-selected)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--pf-muted)" }}>
            Your score
          </p>
          <p className="text-4xl font-semibold tabular-nums" data-testid="quiz-score">
            {result.score} <span className="text-2xl font-medium" style={{ color: "var(--pf-muted)" }}>out of {result.max}</span>
          </p>
          {pending > 0 && (
            <p className="text-sm" style={{ color: "var(--pf-muted)" }}>
              {pending === 1 ? "1 answer is still to be marked." : `${pending} answers are still to be marked.`}
            </p>
          )}
        </div>
      )}
      {result.score === undefined && pending > 0 && (
        <p className="text-sm" style={{ color: "var(--pf-muted)" }}>
          {pending === 1 ? "1 answer is still to be marked." : `${pending} answers are still to be marked.`}
        </p>
      )}
      {items.length > 0 && (
        <ol className="flex flex-col divide-y" style={{ borderColor: "var(--pf-border)" }}>
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-3 py-3" style={{ borderColor: "var(--pf-border)" }}>
              <Mark right={it.right} waiting={it.waiting} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="font-medium [overflow-wrap:anywhere]">{it.title}</p>
                {it.waiting ? (
                  <p className="text-sm" style={{ color: "var(--pf-muted)" }}>
                    Still to be marked
                  </p>
                ) : (
                  it.points !== undefined && it.points !== null && (
                    <p className="text-sm tabular-nums" style={{ color: "var(--pf-muted)" }}>
                      {it.points} of {it.max} {it.max === 1 ? "point" : "points"}
                    </p>
                  )
                )}
                {it.correct && (
                  <p className="text-sm [overflow-wrap:anywhere]">
                    <span style={{ color: "var(--pf-muted)" }}>Right answer: </span>
                    {it.correct}
                  </p>
                )}
                {it.feedback && <p className="whitespace-pre-line text-sm [overflow-wrap:anywhere]">{it.feedback}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Mark({ right, waiting }: { right?: boolean | null; waiting: boolean }) {
  if (waiting || right === undefined)
    return <span className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />;
  if (right === true)
    return (
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--pf-accent)", color: "var(--pf-on-accent)" }}>
        <Check className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Right</span>
      </span>
    );
  if (right === false)
    return (
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2" style={{ borderColor: "var(--pf-error)", color: "var(--pf-error)" }}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Not right</span>
      </span>
    );
  return (
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold" style={{ borderColor: "var(--pf-accent)", color: "var(--pf-accent)" }}>
      ½<span className="sr-only">Part marks</span>
    </span>
  );
}

/** "Save this link to see your score later", with Copy (link answers). */
export function ResultLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      field.current?.select();
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--pf-hover)" }}>
      <label htmlFor="form-result-link" className="text-sm font-medium">
        Save this link to see your score later
      </label>
      <div className="flex gap-2">
        <input ref={field} id="form-result-link" readOnly value={url} className="pf-input min-w-0 flex-1 text-sm" onFocus={(e) => e.target.select()} />
        <button type="button" className="pf-btn pf-btn-primary shrink-0" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs" style={{ color: "var(--pf-muted)" }}>
        It&apos;s kept on this device too. It only shows your own answer&apos;s marks.
      </p>
    </div>
  );
}
