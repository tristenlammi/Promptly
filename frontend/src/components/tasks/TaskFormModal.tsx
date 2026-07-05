import { useEffect, useMemo, useState } from "react";

import { Modal } from "@/components/shared/Modal";
import { useAvailableModels } from "@/hooks/useProviders";
import { useCreateTask, useUpdateTask } from "@/hooks/useTasks";
import {
  tasksApi,
  type AvailableTaskConnector,
  type Task,
  type TaskFrequency,
  type TaskInput,
} from "@/api/tasks";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

const FREQUENCIES: { value: TaskFrequency; label: string }[] = [
  { value: "minutes", label: "Every N minutes" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

// Every-N-minutes step options (backend clamps to 5–720).
const INTERVAL_OPTIONS = [5, 10, 15, 30, 45, 60, 120, 240, 360, 720];
const intervalLabel = (m: number) =>
  m < 60 ? `Every ${m} minutes` : m === 60 ? "Every hour" : `Every ${m / 60} hours`;

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
  /**
   * When the form is opened from a workspace navigator, the created task
   * is homed in that workspace (and gets its restricted connectors). Omit
   * for the standalone /tasks page (task stays top-level).
   */
  workspaceId?: string | null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function TaskFormModal({
  open,
  onClose,
  task,
  onSaved,
  workspaceId,
}: TaskFormModalProps) {
  const { data: models } = useAvailableModels();
  const create = useCreateTask();
  const update = useUpdateTask();
  const editing = !!task;

  // The task's home workspace: the existing one when editing, else the
  // one the form was opened from. Drives which connectors are available.
  const effectiveWorkspaceId = task?.workspace_id ?? workspaceId ?? null;

  // A new task defaults to the creator's own timezone (their profile /
  // personal-context setting), falling back to the AU default if unset.
  const userTimezone = useAuthStore((s) => {
    const tz = s.user?.settings?.timezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : null;
  });
  const defaultTimezone = userTimezone ?? "Australia/Sydney";

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [connectorIds, setConnectorIds] = useState<Set<string>>(new Set());
  const [connectors, setConnectors] = useState<AvailableTaskConnector[]>([]);
  const [frequency, setFrequency] = useState<TaskFrequency>("daily");
  const [time, setTime] = useState("07:00");
  const [weekday, setWeekday] = useState(0);
  // Weekly multi-day set (0=Mon…6=Sun); falls back to the single weekday.
  const [weekdays, setWeekdays] = useState<number[]>([0]);
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [enabled, setEnabled] = useState(true);
  const [concurrency, setConcurrency] = useState<"allow" | "skip">("allow");
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
      setConnectorIds(new Set(task.connector_ids));
      setFrequency(task.frequency);
      setTime(`${pad(task.hour ?? 7)}:${pad(task.minute ?? 0)}`);
      setWeekday(task.weekday ?? 0);
      setWeekdays(
        task.weekdays && task.weekdays.length
          ? task.weekdays
          : [task.weekday ?? 0]
      );
      setIntervalMinutes(task.interval_minutes ?? 30);
      setDayOfMonth(task.day_of_month ?? 1);
      setTimezone(task.timezone);
      setEnabled(task.enabled);
      setConcurrency(task.concurrency === "skip" ? "skip" : "allow");
    } else {
      setTitle("");
      setPrompt("");
      setModelKey("");
      setUseWebSearch(false);
      setConnectorIds(new Set());
      setFrequency("daily");
      setTime("07:00");
      setWeekday(0);
      setWeekdays([0]);
      setIntervalMinutes(30);
      setDayOfMonth(1);
      setTimezone(defaultTimezone);
      setEnabled(true);
      setConcurrency("allow");
    }
  }, [open, task, defaultTimezone]);

  // Load the connectors this user can attach (global + their grants +
  // the home workspace's restricted ones).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    tasksApi
      .availableConnectors(effectiveWorkspaceId)
      .then((c) => alive && setConnectors(c))
      .catch(() => alive && setConnectors([]));
    return () => {
      alive = false;
    };
  }, [open, effectiveWorkspaceId]);

  const modelOptions = useMemo(() => models ?? [], [models]);

  // Curated AU list, plus the user's own zone and the editing task's zone
  // if they fall outside it — so the <select> always has a matching option.
  const tzOptions = useMemo(() => {
    const set = new Set<string>(TIMEZONES);
    if (userTimezone) set.add(userTimezone);
    if (task?.timezone) set.add(task.timezone);
    return [...set];
  }, [userTimezone, task?.timezone]);

  const buildPayload = (): TaskInput | null => {
    if (!title.trim()) {
      setError("Give the automation a title.");
      return null;
    }
    if (!prompt.trim()) {
      setError("Write the prompt the automation should run each time.");
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
      workspace_id: effectiveWorkspaceId,
      connector_ids: [...connectorIds],
      frequency,
      hour:
        frequency === "hourly" || frequency === "minutes"
          ? null
          : isNaN(hh)
            ? 0
            : hh,
      minute: isNaN(mm) ? 0 : mm,
      weekday: frequency === "weekly" ? (weekdays[0] ?? weekday) : null,
      weekdays: frequency === "weekly" && weekdays.length ? weekdays : null,
      interval_minutes: frequency === "minutes" ? intervalMinutes : null,
      day_of_month: frequency === "monthly" ? dayOfMonth : null,
      timezone,
      enabled,
      notify: true,
      retention_runs: 30,
      concurrency,
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
        e instanceof Error ? e.message : "Could not save the automation. Try again."
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
      title={editing ? "Edit automation" : "New automation"}
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
            {busy ? "Saving…" : editing ? "Save changes" : "Create automation"}
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

        {/* ---- Connectors (MCP tool calls) ---- */}
        {connectors.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className={labelCls}>Connectors</label>
              <span className="text-[11px] text-[var(--text-muted)]">
                {connectorIds.size} selected
              </span>
            </div>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              Let this run call read-only tools from these connectors
              (e.g. list devices, fetch issues) and analyse what it finds.
            </p>
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
              {connectors.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-[var(--hover)]"
                >
                  <input
                    type="checkbox"
                    checked={connectorIds.has(c.id)}
                    onChange={() =>
                      setConnectorIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-[var(--text)]">{c.name}</span>
                  {c.kind !== "mcp" && (
                    <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                      {c.kind}
                    </span>
                  )}
                  <span className="ml-auto text-[var(--text-muted)]/70">
                    {c.tool_count} tool{c.tool_count === 1 ? "" : "s"}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

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

            {frequency === "minutes" ? (
              <div>
                <label className={labelCls}>Run every</label>
                <select
                  className={fieldCls}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                >
                  {INTERVAL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {intervalLabel(m)}
                    </option>
                  ))}
                </select>
              </div>
            ) : frequency === "hourly" ? (
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
              <div className="col-span-2">
                <label className={labelCls}>Days of week</label>
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((d) => {
                    const on = weekdays.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => {
                          const next = on
                            ? weekdays.filter((x) => x !== d.value)
                            : [...weekdays, d.value].sort((a, b) => a - b);
                          // Never allow an empty set — keep at least one day.
                          if (!next.length) return;
                          setWeekdays(next);
                          setWeekday(next[0]);
                        }}
                        className={cn(
                          "rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
                          on
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                            : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                        )}
                      >
                        {d.label.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
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
                {tzOptions.map((tz) => (
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

        <div>
          <label className={labelCls}>If a run is still going at the next fire</label>
          <select
            className={fieldCls}
            value={concurrency}
            onChange={(e) =>
              setConcurrency(e.target.value === "skip" ? "skip" : "allow")
            }
          >
            <option value="allow">Start it anyway (runs may overlap)</option>
            <option value="skip">Skip this fire — wait for the next slot</option>
          </select>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Use “skip” for long automations so a slow run can’t stack up.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
