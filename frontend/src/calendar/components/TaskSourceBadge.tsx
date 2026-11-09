import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { calendarApi, type TaskEventSource } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { itemsApi } from "@/items/api";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { EXTRAS_KEY } from "../data";

/**
 * On an event made from a task (``ev.source.kind === "task"``): "From Tasks"
 * and a "Done" box that ticks the task off through the Tasks app's own
 * action (one source of truth). Mount it in the event's details:
 *
 *   {v.ev.source?.kind === "task" && <TaskSourceBadge source={v.ev.source} />}
 */
export function TaskSourceBadge({ source, onNavigate }: { source: TaskEventSource; onNavigate?: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ["calendar", "task-status", source.file_id, source.task_id];
  const { data } = useQuery({ queryKey: key, queryFn: () => calendarApi.taskStatus(source.file_id, source.task_id), staleTime: 15_000 });
  const [busy, setBusy] = useState(false);
  if (data && !data.exists) {
    return <p className="text-xs text-[var(--text-muted)]">Planned from a task that's no longer in Tasks.</p>;
  }
  const done = !!data?.done;
  const flip = async () => {
    if (busy || !data) return;
    setBusy(true);
    qc.setQueryData(key, { ...data, done: !done });
    try {
      await itemsApi.action(source.file_id, "complete_tasks", { tasks: [source.task_id], ...(done ? { done: false } : {}) });
      if (!done) toast.success(data.repeats ? "Done · next one's scheduled" : "Task done");
    } catch (err) {
      qc.setQueryData(key, data);
      toast.error(extractError(err) || "Couldn't update the task.");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: EXTRAS_KEY });
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
      <CircleCheck className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          navigate(`/apps/tasks/${source.file_id}`);
        }}
        className="min-w-0 flex-1 truncate text-left text-[var(--text-muted)] hover:text-[var(--text)] hover:underline"
      >
        From Tasks{data?.title ? ` · ${data.title}` : ""}
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        disabled={!data || busy}
        onClick={() => void flip()}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
      >
        <span
          className={cn("flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-[var(--item-accent)]", done && "bg-[var(--item-accent)]")}
        >
          {done && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </span>
        Done
      </button>
    </div>
  );
}
