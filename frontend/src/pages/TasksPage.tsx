import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarClock,
  Globe,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import {
  useDeleteTask,
  useRunTask,
  useTasks,
  useUpdateTask,
} from "@/hooks/useTasks";
import { tasksApi, type Task } from "@/api/tasks";
import { TaskFormModal } from "@/components/tasks/TaskFormModal";
import { NewAutomationChooser } from "@/components/tasks/NewAutomationChooser";
import { RunStatusChip, relativeTime } from "@/components/tasks/RunStatusChip";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Skeleton } from "@/components/shared/Skeleton";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

export function TasksPage() {
  const { data: tasks, isLoading } = useTasks();
  const navigate = useNavigate();
  const runTask = useRunTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"simple" | "advanced">("simple");

  const openNew = () => setChooserOpen(true);
  const handleChoose = (mode: "simple" | "advanced") => {
    setChooserOpen(false);
    setEditing(null);
    setCreateMode(mode);
    setFormOpen(true);
  };
  const openEdit = (task: Task) => {
    setEditing(task);
    setFormOpen(true);
    setMenuFor(null);
  };

  const onRunNow = async (task: Task) => {
    await runTask.mutateAsync(task.id);
    navigate(`/tasks/${task.id}`);
  };

  return (
    <>
      <TopNav
        title="Automations"
        subtitle="Scheduled prompts that produce a fresh report on their own"
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={openNew}
          >
            New automation
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 py-6">
          {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-3 h-3 w-1/3" />
              <div className="mt-4 flex items-center justify-between">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : !tasks || tasks.length === 0 ? (
        <EmptyState onCreate={openNew} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={cn(
                "group relative cursor-pointer rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--accent)]/50"
              )}
              onClick={() => navigate(`/tasks/${task.id}`)}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 truncate font-medium">
                  {task.title}
                </h3>
                <div className="relative shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === task.id ? null : task.id);
                    }}
                    className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover-strong)]"
                    aria-label="Automation actions"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  {menuFor === task.id && (
                    <div
                      className="absolute right-0 top-7 z-10 w-36 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => openEdit(task)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)]"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button
                        onClick={async () => {
                          setMenuFor(null);
                          const ok = await confirm({
                            title: "Delete automation",
                            message: `Delete "${task.title}" and its runs? This can't be undone.`,
                            confirmLabel: "Delete",
                            danger: true,
                          });
                          if (!ok) return;
                          try {
                            await remove.mutateAsync(task.id);
                            toast.success("Automation deleted");
                          } catch {
                            toast.error(
                              "Couldn't delete the automation. Please try again."
                            );
                          }
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                <span>{task.schedule_label}</span>
                {task.use_web_search && (
                  <span className="inline-flex items-center gap-1">
                    <Globe className="h-3 w-3" /> Web
                  </span>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {task.latest_run ? (
                    <RunStatusChip status={task.latest_run.status} />
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">
                      No runs yet
                    </span>
                  )}
                  {task.enabled ? (
                    <span className="text-xs text-[var(--text-muted)]">
                      Next {relativeTime(task.next_run_at)}
                    </span>
                  ) : (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      Paused
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      update.mutate({
                        id: task.id,
                        input: { enabled: !task.enabled },
                      });
                    }}
                    className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover-strong)]"
                  >
                    {task.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRunNow(task);
                    }}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10"
                  >
                    <Play className="h-3 w-3" /> Run now
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

          <NewAutomationChooser
            open={chooserOpen}
            onClose={() => setChooserOpen(false)}
            onChoose={handleChoose}
          />

          <TaskFormModal
            open={formOpen}
            onClose={() => setFormOpen(false)}
            task={editing}
            onSaved={(t) => {
              if (editing) return;
              // Advanced → promote to a flow graph and open the flow editor;
              // Simple → the classic report view.
              if (createMode === "advanced") {
                void tasksApi
                  .promote(t.id)
                  .finally(() => navigate(`/tasks/${t.id}?flow=1`));
              } else {
                navigate(`/tasks/${t.id}`);
              }
            }}
          />
        </div>
      </div>
    </>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-card border border-dashed border-[var(--border)] py-16 text-center">
      <CalendarClock className="h-10 w-10 text-[var(--text-muted)]" />
      <h2 className="mt-3 text-base font-medium">No automations yet</h2>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">
        Create a scheduled automation and Promptly will run it automatically — like
        a daily news digest or a weekly summary — saving each run as its own
        report.
      </p>
      <button
        onClick={onCreate}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white"
      >
        <Plus className="h-4 w-4" /> New automation
      </button>
    </div>
  );
}
