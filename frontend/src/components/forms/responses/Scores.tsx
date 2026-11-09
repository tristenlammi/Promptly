import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, Check, ChevronRight, Loader2, Send, X } from "lucide-react";
import { useEffect, useState } from "react";

import { formsApi, type AnswerMarks, type OneResponse, type QuizStats } from "@/api/forms";
import { extractError } from "@/components/files/helpers";
import { ErrorState } from "@/components/shared/Callout";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { HistogramColumns } from "./charts";

/**
 * Quiz results for the people who can open the Responses (WP-F2.4):
 *
 * - the **Scores strip** on Summary: average, a histogram, how many are
 *   still to mark ("Next to mark"), **Release scores**, and the most
 *   missed questions;
 * - the **Scores view**: every answer ranked by score, tap to open it;
 * - **marks on one answer** (Individual): a paragraph gets a points stepper
 *   and Right / Wrong; any automatic mark can be changed; then "Next to
 *   mark ›".
 *
 * Respondents never see any of this — only their own result, on the
 * answer page.
 */

function pts(n: number): string {
  return `${n} ${n === 1 ? "point" : "points"}`;
}

export function ScoresStrip({
  fileId,
  stats,
  canMark,
  onScores,
  onNextToMark,
}: {
  fileId: string;
  stats: QuizStats;
  canMark: boolean;
  onScores: () => void;
  onNextToMark: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      const r = await formsApi.release(fileId);
      const done = r.released === 1 ? "Released 1 score." : `Released ${r.released} scores.`;
      toast.success(r.still_to_mark ? `${done} ${r.still_to_mark} still to mark.` : done);
      qc.invalidateQueries({ queryKey: ["form-summary", fileId] });
      qc.invalidateQueries({ queryKey: ["form-scores", fileId] });
      qc.invalidateQueries({ queryKey: ["form-response", fileId] });
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  // Answers waiting for a hand mark stay back until they're marked.
  const ready = stats.unreleased - stats.pending;
  return (
    <section aria-labelledby="quiz-scores-title" className="mt-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="scores-strip">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 id="quiz-scores-title" className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <Award className="h-4 w-4 text-[var(--accent-text)]" aria-hidden="true" /> Scores
          </h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Out of {pts(stats.max)} · {stats.marked === 1 ? "1 answer" : `${stats.marked} answers`}
            {stats.release === "later" && ` · ${stats.released} released`}
          </p>
        </div>
        <button type="button" onClick={onScores} className="text-sm font-medium text-[var(--accent-text)] hover:underline">
          See every score
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Stat label="Average" value={stats.average ?? "–"} />
        <Stat label="Middle score" value={stats.median ?? "–"} />
        <Stat label="Top score" value={stats.top ?? "–"} />
      </dl>
      {stats.histogram.length > 0 && stats.marked > 0 && (
        <>
          <HistogramColumns bins={stats.histogram} of={stats.marked} />
          <table className="sr-only">
            <caption>How many people got each score</caption>
            <tbody>
              {stats.histogram.map((b) => (
                <tr key={b.label}>
                  <th scope="row">{b.label}</th>
                  <td>{b.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {stats.pending > 0 && canMark && (
          <button
            type="button"
            onClick={onNextToMark}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
          >
            {stats.pending === 1 ? "1 to mark" : `${stats.pending} to mark`} <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {stats.pending > 0 && !canMark && <span className="text-sm text-[var(--text-muted)]">{stats.pending} to mark</span>}
        {canMark && stats.release === "later" && stats.unreleased > 0 && (
          <button
            type="button"
            onClick={() => void release()}
            disabled={busy || ready <= 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            title={ready <= 0 ? "Mark the waiting answers first" : undefined}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />} Release scores
          </button>
        )}
        {canMark && stats.release === "later" && stats.pending > 0 && (
          <span className="text-xs text-[var(--text-muted)]">
            {stats.pending === 1 ? "1 still to mark: it's released once it's marked." : `${stats.pending} still to mark: they're released once they're marked.`}
          </span>
        )}
      </div>
      {stats.most_missed.length > 0 && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Most missed</h4>
          <ul className="mt-1 space-y-1">
            {stats.most_missed.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-[var(--text)]">{m.title}</span>
                <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{m.right_pct}% right</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-[var(--bg)] px-2 py-2">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-[var(--text)]">{value}</dd>
    </div>
  );
}

/** Every marked answer, best score first. */
export function ScoresView({ fileId, total, onAnswer }: { fileId: string; total: number; onAnswer: (n: number) => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["form-scores", fileId, total],
    queryFn: () => formsApi.scores(fileId),
  });
  if (isLoading)
    return (
      <p className="mt-6 text-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  if (error || !data) return <div className="mt-4"><ErrorState>Couldn&apos;t load the scores. {extractError(error)}</ErrorState></div>;
  if (!data.length)
    return <p className="mt-4 rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">No marked answers yet.</p>;
  let rank = 0;
  let last: number | null = null;
  return (
    <ol className="mt-4 divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]" data-testid="scores-list" aria-label="Scores, best first">
      {data.map((s, i) => {
        if (s.score !== last) rank = i + 1;
        last = s.score;
        return (
          <li key={s.number}>
            <button
              type="button"
              onClick={() => onAnswer(s.number)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            >
              <span className="w-7 shrink-0 text-right text-sm tabular-nums text-[var(--text-muted)]">{rank}.</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--text)]">
                  {s.who.name}
                  {s.who.kind === "email" && <span className="text-[var(--text-muted)]"> (typed, not checked)</span>}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  #{s.number}
                  {s.pending ? ` · ${s.pending} to mark` : ""}
                  {!s.released ? " · not released" : ""}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text)]">
                {s.score} / {s.max}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The number of the next answer with something to mark after ``from`` (wrapping round). */
export async function nextToMark(fileId: string, from: number | null): Promise<number | null> {
  const list = await formsApi.scores(fileId);
  const waiting = list.filter((s) => s.pending > 0).map((s) => s.number).sort((a, b) => a - b);
  if (!waiting.length) return null;
  return waiting.find((n) => from === null || n > from) ?? waiting[0];
}

/** The marks on one answered question, in the Individual view. */
export function QuestionMark({
  fileId,
  number,
  answer,
  marks,
  canMark,
  onMarked,
}: {
  fileId: string;
  number: number;
  answer: OneResponse["answers"][number];
  marks: AnswerMarks;
  canMark: boolean;
  onMarked: (m: AnswerMarks) => void;
}) {
  const m = marks.items[answer.id];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number>(m?.points ?? 0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(m?.points ?? 0);
    setEditing(false);
  }, [m?.points, number]);
  if (!m) return null;
  const waiting = m.points === null;
  const save = async (p: number | null) => {
    setBusy(true);
    try {
      const r = await formsApi.mark(fileId, number, { [answer.id]: p });
      onMarked(r);
      setEditing(false);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const showEditor = canMark && (waiting || editing);
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={`mark-${answer.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {waiting ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-800 dark:text-amber-300">To mark · up to {pts(m.max)}</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
              m.right === true ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300" : m.right === false ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-[var(--hover)] text-[var(--text)]"
            )}
          >
            {m.right === true ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : m.right === false ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {m.points} / {m.max}
            {m.by === "owner" ? " · marked by hand" : ""}
          </span>
        )}
        {canMark && !waiting && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="font-medium text-[var(--accent-text)] hover:underline">
            Change mark
          </button>
        )}
      </div>
      {showEditor && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Mark: ${answer.title}`}>
          <button type="button" disabled={busy} onClick={() => void save(m.max)} className="inline-flex h-9 items-center gap-1 rounded-md border border-emerald-600/40 px-3 text-sm font-medium text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-300">
            <Check className="h-4 w-4" aria-hidden="true" /> Right
          </button>
          <button type="button" disabled={busy} onClick={() => void save(0)} className="inline-flex h-9 items-center gap-1 rounded-md border border-red-600/30 px-3 text-sm font-medium text-red-700 hover:bg-red-500/10 dark:text-red-300">
            <X className="h-4 w-4" aria-hidden="true" /> Wrong
          </button>
          {m.max > 1 && (
            <span className="inline-flex items-center gap-1">
              <label className="sr-only" htmlFor={`pts-${answer.id}`}>
                Points for {answer.title}
              </label>
              <input
                id={`pts-${answer.id}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={m.max}
                value={value}
                onChange={(e) => setValue(Math.max(0, Math.min(m.max, Math.round(Number(e.target.value) || 0))))}
                className="h-9 w-16 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm tabular-nums"
              />
              <span className="text-sm text-[var(--text-muted)]">/ {m.max}</span>
              <button type="button" disabled={busy} onClick={() => void save(value)} className="h-9 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white disabled:opacity-60">
                Save
              </button>
            </span>
          )}
          {editing && m.by === "owner" && answer.kind !== "paragraph" && (
            <button type="button" disabled={busy} onClick={() => void save(null)} className="text-sm text-[var(--text-muted)] hover:underline">
              Mark automatically again
            </button>
          )}
          {editing && (
            <button type="button" onClick={() => setEditing(false)} className="text-sm text-[var(--text-muted)] hover:underline">
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
