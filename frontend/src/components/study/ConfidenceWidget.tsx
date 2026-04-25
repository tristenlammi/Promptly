import { useState } from "react";
import { Gauge } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useCaptureConfidence } from "@/hooks/useStudy";

interface ConfidenceWidgetProps {
  sessionId: string;
  /** Optional — which objective the rating is about, sent to the backend. */
  objectiveIndex?: number;
  /** Fired once the rating is successfully saved so the chat can hide the
   *  inline widget. */
  onCaptured?: (level: number) => void;
}

const LABELS: Record<number, string> = {
  1: "Very unsure",
  2: "A bit shaky",
  3: "Okay",
  4: "Confident",
  5: "Nailed it",
};

/** Inline 1–5 confidence slider rendered inside the chat when the tutor
 *  emits ``<request_confidence>``. Writes through to
 *  ``POST /study/sessions/{id}/confidence`` which flips
 *  ``session.confidence_captured_at`` — one of the mark_complete gate
 *  conditions. Until this runs, the tutor can't "mark complete" even
 *  if mastery is high, so we make the UI obvious.
 */
export function ConfidenceWidget({
  sessionId,
  objectiveIndex,
  onCaptured,
}: ConfidenceWidgetProps) {
  const [level, setLevel] = useState<number>(3);
  const [note, setNote] = useState("");
  const capture = useCaptureConfidence();
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="rounded-card border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        Thanks — confidence captured at {level}/5.
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-card border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--text)]">
        <Gauge className="h-3.5 w-3.5 text-[var(--accent)]" />
        How confident do you feel about this?
      </div>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setLevel(n)}
            className={
              "h-8 w-8 rounded-full border text-xs font-semibold transition " +
              (n === level
                ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)]/60")
            }
          >
            {n}
          </button>
        ))}
        <span className="ml-2 text-[11px] text-[var(--text-muted)]">
          {LABELS[level]}
        </span>
      </div>
      <input
        type="text"
        placeholder="Optional: one thing that's still fuzzy"
        className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={capture.isPending}
          onClick={() => {
            capture.mutate(
              {
                sessionId,
                level,
                objective_index: objectiveIndex ?? null,
                note: note.trim() || null,
              },
              {
                onSuccess: () => {
                  setDone(true);
                  onCaptured?.(level);
                },
              }
            );
          }}
        >
          Submit
        </Button>
      </div>
    </div>
  );
}
