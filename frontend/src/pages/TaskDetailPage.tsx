import { Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Copy,
  FileDown,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Play,
  Workflow,
} from "lucide-react";

import { lazyWithRetry } from "@/utils/lazyWithRetry";

import {
  useRunTask,
  useTask,
  useTaskRun,
  useTaskRuns,
} from "@/hooks/useTasks";
import { tasksApi } from "@/api/tasks";
import { TaskFormModal } from "@/components/tasks/TaskFormModal";
import { TaskRunDocument } from "@/components/tasks/TaskRunDocument";
import { RunStatusChip } from "@/components/tasks/RunStatusChip";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

// React Flow is a heavy chunk — only load it when the Flow view is opened.
const TaskFlowEditor = lazyWithRetry(
  () =>
    import("@/components/tasks/TaskFlowEditor").then((m) => ({
      default: m.TaskFlowEditor,
    })),
  "TaskFlowEditor"
);

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task } = useTask(id);
  const runTask = useRunTask();
  const [editOpen, setEditOpen] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runs } = useTaskRuns(id, true);
  const runsPolling = useMemo(
    () => (runs ?? []).some((r) => r.status === "pending" || r.status === "running"),
    [runs]
  );
  // ``useTaskRuns`` already polls; we keep the call above stable and rely
  // on the 4s interval. Select the newest run by default.
  useEffect(() => {
    if (!selectedRunId && runs && runs.length > 0) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  const selectedSummary = (runs ?? []).find((r) => r.id === selectedRunId);
  const selectedPolling =
    selectedSummary?.status === "pending" ||
    selectedSummary?.status === "running";
  const { data: run } = useTaskRun(id, selectedRunId ?? undefined, selectedPolling);

  const onRunNow = async () => {
    if (!id) return;
    const created = await runTask.mutateAsync(id);
    setSelectedRunId(created.id);
  };

  const [copied, setCopied] = useState(false);
  const [actionBusy, setActionBusy] = useState<"pdf" | "chat" | null>(null);

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const safeName = (task?.title ?? "report").replace(/[^a-z0-9 \-_]/gi, "_");

  const onCopy = async () => {
    if (!run?.output_markdown) return;
    await navigator.clipboard.writeText(run.output_markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const onDownloadMd = () => {
    if (!run?.output_markdown) return;
    downloadBlob(
      new Blob([run.output_markdown], { type: "text/markdown" }),
      `${safeName}.md`
    );
  };

  const onDownloadPdf = async () => {
    if (!id || !run) return;
    setActionBusy("pdf");
    try {
      const blob = await tasksApi.downloadPdf(id, run.id);
      downloadBlob(blob, `${safeName}.pdf`);
    } finally {
      setActionBusy(null);
    }
  };

  const onFollowUp = async () => {
    if (!id || !run) return;
    setActionBusy("chat");
    try {
      const { conversation_id } = await tasksApi.toChat(id, run.id);
      navigate(`/chat/${conversation_id}`);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <>
      <TopNav
        title={
          <span className="flex items-center gap-1.5">
            <button
              onClick={() => navigate("/tasks")}
              className="-ml-1 shrink-0 rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
              aria-label="Back to tasks"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span className="truncate">{task?.title ?? "Task"}</span>
          </span>
        }
        subtitle={
          task
            ? `${task.schedule_label}${!task.enabled ? " · Paused" : ""}`
            : undefined
        }
        actions={
          <>
            <Button
              variant={showFlow ? "primary" : "secondary"}
              size="sm"
              leftIcon={<Workflow className="h-3.5 w-3.5" />}
              onClick={() => setShowFlow((v) => !v)}
              title="Open the node-graph flow editor"
            >
              Flow
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Pencil className="h-3.5 w-3.5" />}
              onClick={() => setEditOpen(true)}
            >
              Edit
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Play className="h-3.5 w-3.5" />}
              onClick={() => void onRunNow()}
              loading={runTask.isPending}
            >
              Run now
            </Button>
          </>
        }
      />

      {showFlow && id && (
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading flow…
              </div>
            }
          >
            <TaskFlowEditor taskId={id} />
          </Suspense>
        </div>
      )}

      <div
        className={cn(
          "mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-3 px-4 py-4 md:flex-row md:gap-4",
          showFlow && "hidden"
        )}
      >
        {/* Mobile run selector — a horizontal strip so the report gets
            the full width instead of a cramped 224px side rail. */}
        {(runs ?? []).length > 0 && (
          <div className="shrink-0 md:hidden">
            <div className="promptly-scroll flex gap-1.5 overflow-x-auto pb-1">
              {(runs ?? []).map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRunId(r.id)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition",
                    r.id === selectedRunId
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  )}
                >
                  <RunStatusChip status={r.status} />
                  <span>{fmtDate(r.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Run history rail — desktop only; mobile uses the strip above. */}
        <aside className="promptly-scroll hidden w-56 shrink-0 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] p-2 md:block">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Runs {runsPolling && "· live"}
          </div>
          {(runs ?? []).length === 0 ? (
            <p className="px-2 py-3 text-xs text-[var(--text-muted)]">
              No runs yet. Hit “Run now” to test it.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {(runs ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setSelectedRunId(r.id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-sm transition",
                      r.id === selectedRunId
                        ? "bg-[var(--accent)]/10"
                        : "hover:bg-[var(--hover)]"
                    )}
                  >
                    <span className="line-clamp-2 font-medium text-[var(--text)]">
                      {r.title ||
                        (r.status === "failed"
                          ? "Run failed"
                          : r.status === "success"
                            ? "Untitled report"
                            : "In progress…")}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <RunStatusChip status={r.status} />
                      <span>{fmtDate(r.created_at)}</span>
                      {r.trigger === "manual" && (
                        <span className="text-[10px]">manual</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Report viewer */}
        <main className="promptly-scroll min-w-0 flex-1 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] p-6">
          {!selectedRunId ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
              Select a run to read its report.
            </div>
          ) : run ? (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                  <RunStatusChip status={run.status} />
                  {run.finished_at && <span>{fmtDate(run.finished_at)}</span>}
                  {run.cost_usd != null && run.cost_usd > 0 && (
                    <span>${run.cost_usd.toFixed(4)}</span>
                  )}
                  {run.completion_tokens != null && (
                    <span>{run.completion_tokens} tok</span>
                  )}
                </div>
                {run.status === "success" && run.output_markdown && (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => void onCopy()}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-[var(--success)]" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button
                      onClick={onDownloadMd}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
                    >
                      <FileDown className="h-3.5 w-3.5" /> .md
                    </button>
                    <button
                      onClick={() => void onDownloadPdf()}
                      disabled={actionBusy === "pdf"}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)] disabled:opacity-50"
                    >
                      <FileDown className="h-3.5 w-3.5" />
                      {actionBusy === "pdf" ? "Rendering…" : "PDF"}
                    </button>
                    <button
                      onClick={() => void onFollowUp()}
                      disabled={actionBusy === "chat"}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      <MessageSquarePlus className="h-3.5 w-3.5" />
                      {actionBusy === "chat" ? "Opening…" : "Follow up in chat"}
                    </button>
                  </div>
                )}
              </div>
              <TaskRunDocument run={run} />
            </>
          ) : (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}
        </main>
      </div>

      {task && (
        <TaskFormModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          task={task}
        />
      )}
    </>
  );
}
