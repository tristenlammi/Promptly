import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  HelpCircle,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { studyApi } from "@/api/study";
import type { QuickReviewResponse, ReviewQueueItem } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { TopNav } from "@/components/layout/TopNav";
import { useReviewQueueQuery } from "@/hooks/useStudy";
import { cn } from "@/utils/cn";

// ---- Confidence selector ------------------------------------------

const CONFIDENCE_LABELS: Record<number, string> = {
  1: "Clueless",
  2: "Shaky",
  3: "Unsure",
  4: "Pretty sure",
  5: "Certain",
};

interface ConfidenceSelectorProps {
  value: number | null;
  onChange: (v: number) => void;
}
function ConfidenceSelector({ value, onChange }: ConfidenceSelectorProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-[var(--text-muted)]">
        Confidence before seeing the answer
      </span>
      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            title={CONFIDENCE_LABELS[n]}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md border text-xs font-semibold transition-colors",
              value === n
                ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            )}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Item card ----------------------------------------------------

interface ItemCardProps {
  item: ReviewQueueItem;
  index: number;
  total: number;
}
function ItemCard({ item, index, total }: ItemCardProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {item.unit_title} · objective {item.objective_index + 1}
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">
          {index + 1} / {total}
        </span>
      </div>
      <p className="text-sm font-medium text-[var(--text)]">
        {item.objective_text}
      </p>
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
        Mastery {item.mastery_score}/100 · {item.days_overdue}d overdue
      </p>
    </div>
  );
}

// ---- Feedback panel -----------------------------------------------

interface FeedbackPanelProps {
  result: QuickReviewResponse;
  onSelfGrade: (correct: boolean) => void;
  onNext: () => void;
  isLast: boolean;
}
function FeedbackPanel({
  result,
  onSelfGrade,
  onNext,
  isLast,
}: FeedbackPanelProps) {
  const showSelfGrade = result.assessor_unavailable && result.correct === null;

  return (
    <div className="space-y-3">
      {/* Grade indicator */}
      {result.correct !== null && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-3",
            result.correct
              ? "border-emerald-300/60 bg-emerald-50/60 dark:border-emerald-700/40 dark:bg-emerald-900/20"
              : "border-red-300/60 bg-red-50/60 dark:border-red-700/40 dark:bg-red-900/20"
          )}
        >
          {result.correct ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <XCircle className="h-5 w-5 shrink-0 text-red-500" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text)]">
              {result.correct ? "Correct!" : "Not quite."}
            </p>
            {result.feedback && (
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {result.feedback}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Self-grade fallback */}
      {showSelfGrade && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 dark:border-amber-700/40 dark:bg-amber-900/10">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <HelpCircle className="h-3.5 w-3.5" />
            No AI grader configured — did you get it right?
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 border-emerald-400/60 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
              onClick={() => onSelfGrade(true)}
            >
              Yes, got it
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1 border-red-400/60 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
              onClick={() => onSelfGrade(false)}
            >
              No, missed it
            </Button>
          </div>
        </div>
      )}

      {/* Next / Done */}
      {!showSelfGrade && (
        <Button variant="primary" className="w-full" onClick={onNext}>
          {isLast ? "Finish review" : "Next →"}
        </Button>
      )}
    </div>
  );
}

// ---- Main page ----------------------------------------------------

export function ReviewPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: queueData, isLoading } = useReviewQueueQuery(projectId ?? null);
  const items: ReviewQueueItem[] = useMemo(
    () => queueData?.items ?? [],
    [queueData]
  );

  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<"answering" | "feedback" | "done">(
    "answering"
  );
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [result, setResult] = useState<QuickReviewResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Summary counters
  const [correct, setCorrect] = useState(0);
  const [incorrect, setIncorrect] = useState(0);

  const currentItem = items[currentIndex];
  const isLast = currentIndex >= items.length - 1;

  const handleSubmit = useCallback(async () => {
    if (!projectId || !currentItem || !answer.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await studyApi.quickReview(projectId, {
        objective_id: currentItem.objective_id,
        answer,
        confidence,
      });
      setResult(res);
      setPhase("feedback");
      if (res.correct === true) setCorrect((c) => c + 1);
      if (res.correct === false) setIncorrect((c) => c + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }, [projectId, currentItem, answer, confidence]);

  const handleSelfGrade = useCallback(
    async (selfCorrect: boolean) => {
      if (!projectId || !currentItem) return;
      setSubmitting(true);
      try {
        const res = await studyApi.quickReview(projectId, {
          objective_id: currentItem.objective_id,
          answer,
          confidence,
          self_correct: selfCorrect,
        });
        setResult(res);
        if (selfCorrect) setCorrect((c) => c + 1);
        else setIncorrect((c) => c + 1);
        // Show updated result (now has correct set)
        setResult({ ...res, correct: selfCorrect });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setSubmitting(false);
      }
    },
    [projectId, currentItem, answer, confidence]
  );

  const handleNext = useCallback(() => {
    if (isLast) {
      setPhase("done");
    } else {
      setCurrentIndex((i) => i + 1);
      setAnswer("");
      setConfidence(null);
      setResult(null);
      setPhase("answering");
    }
  }, [isLast]);

  if (!projectId) return null;

  if (isLoading) {
    return (
      <>
        <TopNav title="Daily Review" />
        <div className="flex-1 p-6 text-sm text-[var(--text-muted)]">
          Loading review queue…
        </div>
      </>
    );
  }

  if (items.length === 0) {
    return (
      <>
        <TopNav
          title="Daily Review"
          actions={
            <button
              onClick={() => navigate(`/study/topics/${projectId}`)}
              className="inline-flex items-center gap-1.5 rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
          }
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <RotateCcw className="h-8 w-8 opacity-20" />
          <p className="text-sm font-medium">Nothing due right now</p>
          <p className="max-w-xs text-xs text-[var(--text-muted)]">
            All objectives are on schedule. Come back when items are due.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(`/study/topics/${projectId}`)}
          >
            Back to topic
          </Button>
        </div>
      </>
    );
  }

  if (phase === "done") {
    const total = correct + incorrect;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return (
      <>
        <TopNav title="Review complete" />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="text-4xl font-bold tabular-nums text-[var(--text)]">
            {pct}%
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            {correct} correct · {incorrect} incorrect · {total} reviewed
          </p>
          {result && result.items_remaining > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {result.items_remaining} more{" "}
              {result.items_remaining === 1 ? "item" : "items"} still due
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/study/topics/${projectId}`)}
            >
              Back to topic
            </Button>
            {result && result.items_remaining > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  // Reload the page to refresh the queue
                  window.location.reload();
                }}
              >
                Review more
              </Button>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopNav
        title="Daily Review"
        subtitle={`${items.length} item${items.length === 1 ? "" : "s"} due`}
        actions={
          <button
            onClick={() => navigate(`/study/topics/${projectId}`)}
            className="inline-flex items-center gap-1.5 rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 py-6 space-y-4">
          {/* Progress bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]/40">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{
                width: `${Math.round((currentIndex / items.length) * 100)}%`,
              }}
            />
          </div>

          {/* Objective card */}
          {currentItem && (
            <ItemCard
              item={currentItem}
              index={currentIndex}
              total={items.length}
            />
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-400/40 bg-red-50/40 px-3 py-2 text-xs text-red-600 dark:bg-red-900/10 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Answer phase */}
          {phase === "answering" && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                  Your answer (free recall)
                </label>
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Write everything you remember about this objective…"
                  rows={5}
                  className={cn(
                    "w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)]",
                    "px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)]",
                    "focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  )}
                />
              </div>
              <ConfidenceSelector
                value={confidence}
                onChange={setConfidence}
              />
              <Button
                variant="primary"
                className="w-full"
                onClick={handleSubmit}
                loading={submitting}
                disabled={!answer.trim()}
              >
                Submit answer
              </Button>
            </div>
          )}

          {/* Feedback phase */}
          {phase === "feedback" && result && (
            <FeedbackPanel
              result={result}
              onSelfGrade={handleSelfGrade}
              onNext={handleNext}
              isLast={isLast}
            />
          )}
        </div>
      </div>
    </>
  );
}
