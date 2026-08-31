import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarClock,
  Copy,
  LayoutGrid,
  Globe,
  KeyRound,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import {
  useCreateTask,
  useDeleteTask,
  useDuplicateTask,
  useRunTask,
  useTasks,
  useUpdateTask,
} from "@/hooks/useTasks";
import { useAvailableModels } from "@/hooks/useProviders";
import { tasksApi, type Task } from "@/api/tasks";
import { TaskFormModal } from "@/components/tasks/TaskFormModal";
import { CommandEditorModal } from "@/components/commands/CommandEditorModal";
import { CommandList } from "@/components/commands/CommandList";
import {
  duplicatePhrases,
  filterByType,
  useCommands,
} from "@/hooks/useCommands";
import type { Command, CommandActionType } from "@/api/commands";
import { NewAutomationChooser } from "@/components/tasks/NewAutomationChooser";
import { CredentialsModal } from "@/components/tasks/CredentialsModal";
import { RunStatusChip, relativeTime } from "@/components/tasks/RunStatusChip";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

type Tab = "prompts" | "commands" | "scheduled";

/** The three tabs are filtered views of ONE library plus the scheduled
 *  flows — not three features. What separates them for a user is simply
 *  what starts the thing: Scheduled runs itself; Prompts and Commands
 *  are started by you, by typing or (later) by speaking. */
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "prompts", label: "Prompts", hint: "Text you insert with /" },
  { key: "commands", label: "Commands", hint: "Things Promptly does when you ask" },
  { key: "scheduled", label: "Scheduled", hint: "Runs on its own" },
];

export function TasksPage() {
  // Prompts leads: it's the tab everyone uses daily, and Scheduled is
  // the desktop-gated one.
  const [tab, setTab] = useState<Tab>("prompts");
  const [commandEditing, setCommandEditing] = useState<Command | null>(null);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const { data: commands, isLoading: commandsLoading } = useCommands();
  const duplicates = useMemo(() => duplicatePhrases(commands), [commands]);

  const openCommandEditor = (existing: Command | null) => {
    setCommandEditing(existing);
    setCommandEditorOpen(true);
  };

  // ``all`` so workspace-homed automations show too — this page is the one
  // place to audit everything that runs on the account.
  const { data: tasks, isLoading } = useTasks("all");
  const navigate = useNavigate();
  const runTask = useRunTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const duplicate = useDuplicateTask();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);
  const create = useCreateTask();
  const { data: models } = useAvailableModels();

  const openNew = () => setChooserOpen(true);
  const handleChoose = async (mode: "simple" | "advanced") => {
    setChooserOpen(false);
    if (mode === "simple") {
      setEditing(null);
      setFormOpen(true);
      return;
    }
    // Advanced: create a blank automation and drop straight into the flow
    // editor — no form. Everything (prompt, model, schedule, output) is set
    // in the canvas. Seeds the first AI step with the default model.
    try {
      const first = (models ?? [])[0];
      const created = await create.mutateAsync({
        title: "Untitled automation",
        prompt: "Describe what this automation should do.",
        provider_id: first?.provider_id ?? null,
        model_id: first?.model_id ?? null,
        use_web_search: false,
        frequency: "daily",
        hour: 9,
        minute: 0,
        weekday: null,
        day_of_month: null,
        timezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone ||
          "Australia/Brisbane",
        enabled: true,
        notify: true,
        retention_runs: 30,
      });
      await tasksApi.promote(created.id);
      navigate(`/tasks/${created.id}?flow=1`);
    } catch {
      toast.error("Couldn't create the automation. Try again.");
    }
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

  // Personal automations first, then one section per home workspace —
  // the page is the account-wide audit view, but home still matters.
  const groups = useMemo(() => {
    const list = tasks ?? [];
    const personal = list.filter((t) => !t.workspace_id);
    const byWs = new Map<string, { title: string; tasks: Task[] }>();
    for (const t of list) {
      if (!t.workspace_id) continue;
      const g = byWs.get(t.workspace_id) ?? {
        title: t.workspace_title ?? "Workspace",
        tasks: [],
      };
      g.tasks.push(t);
      byWs.set(t.workspace_id, g);
    }
    const workspaces = [...byWs.entries()]
      .map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return { personal, workspaces };
  }, [tasks]);

  return (
    <>
      <TopNav
        title="Automations"
        subtitle={TABS.find((t) => t.key === tab)?.hint}
        actions={
          <div className="flex items-center gap-2">
            {tab === "scheduled" ? (
              <>
                <Button
                  variant="ghost"
                  leftIcon={<KeyRound className="h-4 w-4" />}
                  onClick={() => setCredsOpen(true)}
                  title="Manage API keys and tokens your automations use"
                >
                  Credentials
                </Button>
                <Button
                  variant="primary"
                  leftIcon={<Plus className="h-4 w-4" />}
                  onClick={openNew}
                >
                  New automation
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => openCommandEditor(null)}
              >
                {tab === "prompts" ? "New prompt" : "New command"}
              </Button>
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 py-6">
          <div
            role="tablist"
            aria-label="Automations sections"
            className="mb-5 flex gap-1 self-start rounded-lg bg-[var(--surface-2)] p-1"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition",
                  tab === t.key
                    ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab !== "scheduled" && (
            <CommandsTabBody
              tab={tab}
              loading={commandsLoading}
              commands={filterByType(
                commands,
                tab === "prompts" ? "prompt" : "action"
              )}
              duplicates={duplicates}
              onEdit={openCommandEditor}
            />
          )}

          {tab === "scheduled" && (isLoading ? (
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
        <TasksEmptyState onCreate={openNew} />
      ) : (
        <div className="flex flex-col gap-7">
          {[
            { id: "personal", title: "Personal", tasks: groups.personal },
            ...groups.workspaces,
          ]
            .filter((g) => g.tasks.length > 0)
            .map((g) => (
              <section key={g.id}>
                {/* A lone personal section needs no header — the grouping
                    only earns its label once workspace sections exist. */}
                {(groups.workspaces.length > 0 || g.id !== "personal") && (
                  <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {g.id !== "personal" && (
                      <LayoutGrid className="h-3.5 w-3.5" />
                    )}
                    {g.title}
                  </h2>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
          {g.tasks.map((task) => (
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
                          try {
                            await duplicate.mutateAsync(task.id);
                            toast.success(
                              "Duplicated — the copy is paused until you enable it"
                            );
                          } catch {
                            toast.error(
                              "Couldn't duplicate the automation. Please try again."
                            );
                          }
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)]"
                      >
                        <Copy className="h-3.5 w-3.5" /> Duplicate
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
              </section>
            ))}
        </div>
      ))}

          <NewAutomationChooser
            open={chooserOpen}
            onClose={() => setChooserOpen(false)}
            onChoose={handleChoose}
          />

          <CredentialsModal
            open={credsOpen}
            onClose={() => setCredsOpen(false)}
          />

          <CommandEditorModal
            open={commandEditorOpen}
            onClose={() => setCommandEditorOpen(false)}
            command={commandEditing}
            defaultActionType={
              (tab === "prompts" ? "prompt" : "automation") as CommandActionType
            }
          />

          <TaskFormModal
            open={formOpen}
            onClose={() => setFormOpen(false)}
            task={editing}
            onSaved={(t) => {
              if (!editing) navigate(`/tasks/${t.id}`);
            }}
          />
        </div>
      </div>
    </>
  );
}

function CommandsTabBody({
  tab,
  loading,
  commands,
  duplicates,
  onEdit,
}: {
  tab: Tab;
  loading: boolean;
  commands: Command[];
  duplicates: Set<string>;
  onEdit: (command: Command | null) => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-card" />
        ))}
      </div>
    );
  }
  const isPrompts = tab === "prompts";
  return (
    <CommandList
      commands={commands}
      duplicates={duplicates}
      emptyTitle={isPrompts ? "No saved prompts yet" : "No commands yet"}
      emptyDescription={
        isPrompts
          ? "Save the prompts you retype. Insert one with / in any chat."
          : "Teach Promptly to do something when you ask — run an automation, or call a connected tool. Pick one with / in chat."
      }
      emptyAction={
        <Button
          variant="primary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => onEdit(null)}
        >
          {isPrompts ? "New prompt" : "New command"}
        </Button>
      }
      onEdit={onEdit}
    />
  );
}

function TasksEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      icon={<CalendarClock className="h-5 w-5" />}
      title="No automations yet"
      description="Create a scheduled automation and Promptly will run it automatically — like a daily news digest or a weekly summary — saving each run as its own report."
      action={
        <Button
          variant="primary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={onCreate}
        >
          New automation
        </Button>
      }
    />
  );
}
