import { useEffect, useMemo, useState } from "react";

import { Modal } from "@/components/shared/Modal";
import { useAvailableModels } from "@/hooks/useProviders";
import { useCreateTask, useUpdateTask } from "@/hooks/useTasks";
import type { Task, TaskFrequency, TaskInput } from "@/api/tasks";
import { cn } from "@/utils/cn";

const FREQUENCIES: { value: TaskFrequency; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const WEEKDAYS = [
  { value: 0, label: "Monday" },
  { value: 1, label: "Tuesday" },
  { value: 2, label: "Wednesday" },
  { value: 3, label: "Thursday" },
  { value: 4, label: "Friday" },
  { value: 5, label: "Saturday" },
  { value: 6, label: "Sunday" },
];

// AU-only for now; default to Sydney. A small curated list beats a
// 400-entry IANA dropdown for this audience.
const TIMEZONES = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Perth",
  "Australia/Hobart",
  "Australia/Darwin",
];

interface TaskFormModalProps {
  open: boolean;
  onClose: () => void;
  task?: Task | null;
  onSaved?: (task: Task) => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function TaskFormModal({
  open,
  onClose,
  task,
  onSaved,
}: TaskFormModalProps) {
  const { data: models } = useAvailableModels();
  const create = useCreateTask();
  const update = useUpdateTask();
  const editing = !!task;

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [frequency, setFrequency] = useState<TaskFrequency>("daily");
  const [time, setTime] = useState("07:00");
  const [weekday, setWeekday] = useState(0);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState("Australia/Sydney");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Hydrate when opening (create = blank defaults; edit = task values).
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (task) {
      setTitle(task.title);
      setPrompt(task.prompt);
      setModelKey(
        task.provider_id && task.model_id
          ? `${task.provider_id}::${task.model_id}`
          : ""
      );
      setUseWebSearch(task.use_web_search);
      setFrequency(task.frequency);
      setTime(`${pad(task.hour ?? 7)}:${pad(task.minute ?? 0)}`);
      setWeekday(task.weekday ?? 0);
      setDayOfMonth(task.day_of_month ?? 1);
      setTimezone(task.timezone);
      setEnabled(task.enabled);
    } else {
      setTitle("");
      setPrompt("");
      setModelKey("");
      setUseWebSearch(false);
      setFrequency("daily");
      setTime("07:00");
      setWeekday(0);
      setDayOfMonth(1);
      setTimezone("Australia/Sydney");
      setEnabled(true);
    }
  }, [open, task]);

  const modelOptions = useMemo(() => models ?? [], [models]);

  const buildPayload = (): TaskInput | null => {
    if (!title.trim()) {
      setError("Give the task a title.");
      return null;
    }
    if (!prompt.trim()) {
      setError("Write the prompt the task should run each time.");
      return null;
    }
    if (!modelKey) {
      setError("Pick a model.");
      return null;
    }
    const [providerId, modelId] = modelKey.split("::");
    const [hh, mm] = time.split(":").map((p) => parseInt(p, 10));
    return {
      title: title.trim(),
      prompt,
      provider_id: providerId,
      model_id: modelId,
      use_web_search: useWebSearch,
      frequency,
      hour: frequency === "hourly" ? null : isNaN(hh) ? 0 : hh,
      minute: isNaN(mm) ? 0 : mm,
      weekday: frequency === "weekly" ? weekday : null,
      day_of_month: frequency === "monthly" ? dayOfMonth : null,
      timezone,
      enabled,
      notify: true,
      retention_runs: 30,
    };
  };

  const submit = async () => {
    const payload = buildPayload();
    if (!payload) return;
    try {
      const saved = editing
        ? await update.mutateAsync({ id: task!.id, input: payload })
        : await create.mutateAsync(payload);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save the task. Try again."
      );
    }
  };

  const busy = create.isPending || update.isPending;
  const fieldCls =
    "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]";
  const labelCls = "mb-1 block text-xs font-medium text-[var(--text-muted)]";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit task" : "New task"}
      description="A scheduled prompt that produces a fresh report each run."
      widthClass="max-w-xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Create task"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelCls}>Title</label>
          <input
            className={fieldCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Morning AU news digest"
            maxLength={120}
          />
        </div>

        <div>
          <label className={labelCls}>Prompt</label>
          <textarea
            className={cn(fieldCls, "min-h-[120px] resize-y")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Compile the top 10 Australian news stories from the last 24 hours. Group by category, summarise each in 2 sentences, and link the source."
          />
        </div>

        <div>
          <label className={labelCls}>Model</label>
          <select
            className={fieldCls}
            value={modelKey}
            onChange={(e) => setModelKey(e.target.value)}
          >
            <option value="">Select a model…</option>
            {modelOptions.map((m) => (
              <option
                key={`${m.provider_id}::${m.model_id}`}
                value={`${m.provider_id}::${m.model_id}`}
              >
                {m.display_name} · {m.provider_name}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useWebSearch}
            onChange={(e) => setUseWebSearch(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span>
            Allow web search
            <span className="text-[var(--text-muted)]">
              {" "}
              — needed for news / fresh facts
            </span>
          </span>
        </label>

        {/* ---- Schedule ---- */}
        <div className="rounded-card border border-[var(--border)] p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Schedule
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Frequency</label>
              <select
                className={fieldCls}
                value={frequency}
                onChange={(e) =>
                  setFrequency(e.target.value as TaskFrequency)
                }
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            {frequency === "hourly" ? (
              <div>
                <label className={labelCls}>Minute past the hour</label>
                <input
                  type="number"
                  min={0}
                  max={59}
                  className={fieldCls}
                  value={parseInt(time.split(":")[1] || "0", 10)}
                  onChange={(e) =>
                    setTime(`00:${pad(Number(e.target.value) || 0)}`)
                  }
                />
              </div>
            ) : (
              <div>
                <label className={labelCls}>Time</label>
                <input
                  type="time"
                  className={fieldCls}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            )}

            {frequency === "weekly" && (
              <div>
                <label className={labelCls}>Day of week</label>
                <select
                  className={fieldCls}
                  value={weekday}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {frequency === "monthly" && (
              <div>
                <label className={labelCls}>Day of month (1–28)</label>
                <input
                  type="number"
                  min={1}
                  max={28}
                  className={fieldCls}
                  value={dayOfMonth}
                  onChange={(e) =>
                    setDayOfMonth(
                      Math.max(1, Math.min(28, Number(e.target.value) || 1))
                    )
                  }
                />
              </div>
            )}

            <div className={frequency === "daily" ? "" : "col-span-2"}>
              <label className={labelCls}>Timezone</label>
              <select
                className={fieldCls}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace("Australia/", "")}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span>Enabled — run on schedule</span>
        </label>

        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
