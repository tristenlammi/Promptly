import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { studyApi, studyError, type Ask, type AskMode, type Step } from "@/api/study";
import { cn } from "@/utils/cn";

import { Thinking } from "./ui/bits";
import { Md } from "./ui/Md";

/*
 * Ask the teacher, about the step in front of you. One-tap "explain it
 * differently" buttons, or your own question. While the step is unanswered
 * the teacher helps without giving the answer away (the server's rule).
 */

const QUICK: { mode: AskMode; label: string; said: string }[] = [
  { mode: "simpler", label: "Say it more simply", said: "Can you say that more simply?" },
  { mode: "analogy", label: "Compare it to something", said: "Can you compare it to something I know?" },
  { mode: "example", label: "Show an example", said: "Can you show me an example?" },
  { mode: "deeper", label: "Go deeper", said: "Why is that? Go a bit deeper." },
];

export function AskPanel({ step, onAsks, className }: { step: Step; onAsks: (asks: Ask[]) => void; className?: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stepId = useRef(step.id);
  stepId.current = step.id;

  useEffect(() => {
    setError(null);
    setBusy(null);
    setText("");
  }, [step.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [step.asks.length, busy]);

  const ask = async (mode: AskMode, said: string, question?: string) => {
    if (busy) return;
    const id = step.id;
    setBusy(said);
    setError(null);
    try {
      const out = await studyApi.ask(id, mode, question);
      if (stepId.current !== id) return;
      onAsks(out.asks);
      if (mode === "question") setText("");
    } catch (e) {
      if (stepId.current === id) setError(studyError(e).message);
    } finally {
      if (stepId.current === id) setBusy(null);
    }
  };

  const send = () => {
    const q = text.trim();
    if (q) void ask("question", q, q);
  };

  const pending = step.status === "pending" && step.kind !== "explain";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3" role="log" aria-label="Your questions to the teacher">
        {step.asks.length === 0 && !busy && (
          <p className="rounded-xl bg-[var(--st-softer)] px-3 py-2.5 text-sm text-[var(--text-muted)]">
            Stuck, or curious? Ask anything about this step.
            {pending && " The teacher will help you think, without giving the answer away."}
          </p>
        )}
        <div className="flex flex-col gap-2.5">
          {step.asks.map((a, i) =>
            a.role === "learner" ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--accent-strong)] px-3.5 py-2 text-[15px] leading-snug text-white">
                  {a.text || QUICK.find((q) => q.mode === a.mode)?.said || "Explain it differently"}
                </p>
              </div>
            ) : (
              <div key={i} className="study-in max-w-[94%] rounded-2xl rounded-bl-md border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5">
                <Md text={a.text} compact />
              </div>
            )
          )}
          {busy && (
            <>
              <div className="flex justify-end">
                <p className="max-w-[88%] rounded-2xl rounded-br-md bg-[var(--accent-strong)] px-3.5 py-2 text-[15px] leading-snug text-white opacity-80">{busy}</p>
              </div>
              <Thinking />
            </>
          )}
          {error && (
            <p role="alert" className="rounded-xl border border-[var(--st-bad-border)] bg-[var(--st-bad-bg)] px-3 py-2 text-sm text-[var(--st-bad)]">
              {error}
            </p>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--border)] px-4 pb-3 pt-2.5">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.mode}
              type="button"
              disabled={!!busy}
              onClick={() => void ask(q.mode, q.said)}
              className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] transition hover:border-[var(--st-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] disabled:opacity-50"
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Ask the teacher a question</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 2000))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Ask a question…"
              className="max-h-32 min-h-[44px] w-full resize-none rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-[16px] leading-snug text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-soft)]"
            />
          </label>
          <button
            type="button"
            onClick={send}
            disabled={!!busy || !text.trim()}
            aria-label="Ask"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:opacity-40"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
