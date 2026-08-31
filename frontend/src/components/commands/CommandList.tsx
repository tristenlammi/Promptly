import { AlertTriangle, Pencil, Play, Trash2, Zap } from "lucide-react";

import { isSideEffecting, type Command } from "@/api/commands";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";
import { confirm } from "@/components/shared/ConfirmDialog";
import {
  useDeleteCommand,
  useRunCommandWithConfirm,
} from "@/hooks/useCommands";
import { useToastStore } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * The library list, shared by the Prompts and Commands tabs.
 *
 * The one thing this has to surface loudly is a **duplicated phrase**.
 * The matcher refuses to act on an ambiguous phrase — it returns no
 * match rather than picking a command — so a duplicate is a silently
 * dead command, and from the outside that looks exactly like a broken
 * feature rather than a fixable mistake.
 */
export function CommandList({
  commands,
  duplicates,
  emptyTitle,
  emptyDescription,
  emptyAction,
  onEdit,
}: {
  commands: Command[];
  duplicates: Set<string>;
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: React.ReactNode;
  onEdit: (command: Command) => void;
}) {
  const remove = useDeleteCommand();
  const { runCommand, isPending: running } = useRunCommandWithConfirm();
  const pushToast = useToastStore((s) => s.push);

  if (!commands.length) {
    return (
      <EmptyState
        icon={<Zap className="h-6 w-6" />}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  const onDelete = async (command: Command) => {
    const ok = await confirm({
      title: `Delete "${command.name}"?`,
      message: "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(command.id);
    } catch (e) {
      pushToast({ message: apiErrorMessage(e, "Couldn't delete that."), type: "error" });
    }
  };

  return (
    <ul className="flex flex-col gap-2">
      {commands.map((command) => {
        const clashing = (command.phrases ?? []).filter((p) =>
          duplicates.has(p.trim().toLowerCase())
        );
        return (
          <li
            key={command.id}
            className={cn(
              "rounded-card border bg-[var(--surface)] p-3 transition",
              command.enabled
                ? "border-[var(--border)]"
                : "border-dashed border-[var(--border)] opacity-60"
            )}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">
                    {command.name}
                  </span>
                  {isSideEffecting(command.action_type) && (
                    <span
                      title="Does something — runs when picked"
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]"
                    >
                      <Zap className="h-2.5 w-2.5" />
                      {command.action_type === "automation" ? "Automation" : "Tool"}
                    </span>
                  )}
                  {!command.enabled && (
                    <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                      Off
                    </span>
                  )}
                </div>

                {command.action_type === "prompt" && command.body && (
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                    {command.body}
                  </p>
                )}

                {(command.phrases?.length ?? 0) > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {command.phrases.map((p) => (
                      <span
                        key={p}
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px]",
                          duplicates.has(p.trim().toLowerCase())
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            : "bg-[var(--surface-2)] text-[var(--text-muted)]"
                        )}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
                    Menu only — no spoken phrases
                  </p>
                )}

                {clashing.length > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      Another command uses{" "}
                      {clashing.map((p) => `"${p}"`).join(", ")}. Saying it
                      does nothing until one of them changes — Promptly won't
                      guess which you meant.
                    </span>
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {isSideEffecting(command.action_type) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void runCommand(command)}
                    disabled={!command.enabled || running}
                    leftIcon={<Play className="h-3.5 w-3.5" />}
                  >
                    Run
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => onEdit(command)}
                  aria-label={`Edit ${command.name}`}
                  className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(command)}
                  aria-label={`Delete ${command.name}`}
                  className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
