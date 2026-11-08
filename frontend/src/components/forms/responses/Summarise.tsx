import { Loader2, Sparkles, X } from "lucide-react";
import { useState } from "react";

import { formsApi, type AnswerSummary } from "@/api/forms";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Summarise (Forms WP-F1.7) on a text question: themes with how many said
 * so, and a few short quotes that open their answers. Labelled as an AI
 * summary to check against the answers; shown as plain text, kept only
 * while it's on screen (never saved, never remembered).
 */
export function Summarise({ fileId, questionId, answered, onAnswer }: { fileId: string; questionId: string; answered: number; onAnswer: (n: number) => void }) {
  const { providerId, modelId } = useEditorModel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [got, setGot] = useState<AnswerSummary | null>(null);
  if (answered < 2) return null;
  const run = async () => {
    if (!providerId || !modelId) {
      setError(NO_MODEL_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setGot(await formsApi.summarise(fileId, questionId, { provider_id: providerId, model_id: modelId }));
    } catch (e) {
      setError(apiErrorMessage(e, "The summary couldn't be made. Try again."));
    } finally {
      setBusy(false);
    }
  };
  if (!got)
    return (
      <div className="mt-2 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="inline-flex min-h-[36px] items-center gap-1.5 self-start rounded-md border border-[var(--border)] px-2.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
          {busy ? "Summarising…" : "Summarise"}
        </button>
        {error && (
          <p role="alert" className="text-xs text-[var(--danger,#b91c1c)]">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <section aria-label="AI summary" className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3" data-testid="answer-summary">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI summary of {got.answers} answers: check the answers
        </p>
        <button type="button" aria-label="Close the summary" onClick={() => setGot(null)} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="flex flex-col gap-3">
        {got.themes.map((t, i) => (
          <li key={i}>
            <p className="text-sm text-[var(--text)]">
              <span className="font-semibold">{t.title}</span>
              {t.count > 0 && <span className="text-[var(--text-muted)]"> · {t.count === 1 ? "1 person" : `${t.count} people`}</span>}
            </p>
            {t.summary && <p className="text-sm text-[var(--text-muted)]">{t.summary}</p>}
            {t.quotes.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {t.quotes.map((q, j) => (
                  <li key={j}>
                    <button
                      type="button"
                      onClick={() => onAnswer(q.number)}
                      className="text-left text-xs text-[var(--text)] hover:underline"
                      title={`Open answer #${q.number}`}
                    >
                      “{q.text}” <span className="text-[var(--accent-text)]">#{q.number}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
