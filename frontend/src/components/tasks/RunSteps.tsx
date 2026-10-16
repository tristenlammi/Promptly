import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Pin, Sparkles, XCircle } from "lucide-react";

import { tasksApi, type NodeRun, type TaskRun } from "@/api/tasks";
import { apiErrorMessage } from "@/utils/apiError";

/** The status icon for one step. Skipped and pinned steps aren't failures —
 *  they used to get the same red cross as a broken step (R-146). */
function StepIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />;
  if (status === "error") return <XCircle className="h-3.5 w-3.5 shrink-0 text-[var(--danger)]" />;
  if (status === "pinned") return <Pin className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />;
  return <CircleDashed className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />;
}

/** Per-step results of a run, with each step's output and any template
 *  variables that had no value. Failed runs now keep the steps that ran and
 *  the one that broke (R-146, R-150). */
export function RunSteps({ steps }: { steps: NodeRun[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map((s, i) => (
        <details
          key={`${s.node_id}-${i}`}
          open={s.status === "error"}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)]"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
            <StepIcon status={s.status} />
            <span className="min-w-0 truncate font-medium text-[var(--text)]">{s.label || s.type}</span>
            {s.status === "skipped" && <span className="text-[var(--text-muted)]">skipped</span>}
            {(s.unresolved?.length ?? 0) > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[var(--warning)]"
                title={`No value for: ${s.unresolved!.join(", ")}`}
              >
                <AlertTriangle className="h-3 w-3" />
                {s.unresolved!.length} unfilled
              </span>
            )}
            {(s.completion_tokens ?? 0) > 0 && (
              <span className="ml-auto shrink-0 text-[var(--text-muted)]">{s.completion_tokens} tok</span>
            )}
          </summary>
          {(s.unresolved?.length ?? 0) > 0 && (
            <p className="border-t border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--warning)]">
              These variables had no value and were left as written:{" "}
              {s.unresolved!.map((v) => `{{${v}}}`).join(", ")}
            </p>
          )}
          <pre className="promptly-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--border)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {s.output || "(no output)"}
          </pre>
        </details>
      ))}
    </div>
  );
}

/** "Diagnose" for a failed run — the AI reads the flow and the steps that
 *  ran and says what broke (R-146: it existed but nothing called it). */
export function DiagnoseRun({ run }: { run: TaskRun }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (run.status !== "failed") return null;
  return (
    <div className="space-y-2">
      {!text && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              setText(await tasksApi.diagnoseRun(run.task_id, run.id));
            } catch (e) {
              setErr(apiErrorMessage(e, "Couldn't diagnose this run."));
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Diagnose
        </button>
      )}
      {text && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]">
          {text}
        </div>
      )}
      {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
    </div>
  );
}
