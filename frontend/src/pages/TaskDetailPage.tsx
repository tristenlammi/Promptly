import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Copy,
  FileDown,
  MessageSquarePlus,
  Pencil,
  Play,
} from "lucide-react";

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
import { cn } from "@/utils/cn";

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
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-4 py-4">
      {/* Header */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => navigate("/tasks")}
          className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          aria-label="Back to tasks"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {task?.title ?? "Task"}
          </h1>
          {task && (
            <p className="text-xs text-[var(--text-muted)]">
              {task.schedule_label}
              {!task.enabled && " · Paused"}
            </p>
          )}
        </div>
        <button
          onClick={() => setEditOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          onClick={() => void onRunNow()}
          disabled={runTask.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" /> Run now
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Run history rail */}
        <aside className="promptly-scroll w-56 shrink-0 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] p-2">
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
                        : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    )}
                  >
                    <span className="text-xs">{fmtDate(r.created_at)}</span>
                    <span className="flex items-center gap-1.5">
                      <RunStatusChip status={r.status} />
                      {r.trigger === "manual" && (
                        <span className="text-[10px] text-[var(--text-muted)]">
                          manual
                        </span>
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
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button
                      onClick={onDownloadMd}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    >
                      <FileDown className="h-3.5 w-3.5" /> .md
                    </button>
                    <button
                      onClick={() => void onDownloadPdf()}
                      disabled={actionBusy === "pdf"}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.06]"
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
    </div>
  );
}
