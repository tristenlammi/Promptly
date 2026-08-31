import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commandsApi,
  type Command,
  type CommandActionType,
  type CommandInput,
} from "@/api/commands";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { useChatStore } from "@/store/chatStore";
import type { ChatMessage } from "@/api/types";

const KEY = ["commands"] as const;

/** The whole library in one query.
 *
 * Deliberately not one query per tab: the list is small and user-owned,
 * the `/` menu needs every type at once anyway, and three cached lists
 * would mean three things to invalidate after every edit. */
export function useCommands() {
  return useQuery<Command[]>({
    queryKey: KEY,
    queryFn: () => commandsApi.list(),
    staleTime: 60_000,
  });
}

/** Client-side filter for a tab. The library is small enough that a
 *  server round-trip per tab switch would be slower than free. */
export function filterByType(
  commands: Command[] | undefined,
  type: CommandActionType | "action"
): Command[] {
  const all = commands ?? [];
  if (type === "action") return all.filter((c) => c.action_type !== "prompt");
  return all.filter((c) => c.action_type === type);
}

/** Connectors + their cached tool catalogs, for the command editor.
 *
 * Manual-refresh by design: ``staleTime: Infinity`` means it's fetched
 * once and then only when the editor asks. A catalog changes when an
 * admin adds a connector, not while you're filling in a form, so
 * background refetching would be churn — and the Refresh button makes
 * the staleness the user's call rather than a guess. */
export function useCommandTools() {
  return useQuery({
    queryKey: ["commands", "tools"],
    queryFn: () => commandsApi.tools(),
    staleTime: Infinity,
  });
}

export function useCreateCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommandInput) => commandsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<CommandInput> }) =>
      commandsApi.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => commandsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRunCommand() {
  return useMutation({
    mutationFn: ({
      id,
      slots,
      confirmed,
      conversationId,
    }: {
      id: string;
      slots?: Record<string, string>;
      confirmed?: boolean;
      conversationId?: string | null;
    }) => commandsApi.run(id, { slots, confirmed, conversationId }),
  });
}

/** Confirm, run, and report — the ONE path a command runs through.
 *
 * There are two entry points (the `/` menu and the library's Run
 * button) and there will be a third when voice lands. Each writing its
 * own confirm-and-report sequence is how a side-effecting command ends
 * up confirming in one place and not the other — the promise is only
 * worth anything if it can't drift, so it lives here once.
 *
 * Returns whether it actually ran, so callers can leave the composer
 * alone when the user backed out.
 */
export function useRunCommandWithConfirm() {
  const run = useRunCommand();

  const runCommand = useCallback(
    async (
      command: Command,
      /** When run from inside a chat, the run is recorded there as a
       *  Tool Activity Card so the transcript shows what happened. */
      opts: { conversationId?: string | null } = {}
    ): Promise<boolean> => {
      if (command.confirm_before_run) {
        const ok = await confirm({
          title: `Run "${command.name}"?`,
          // Say which way it reaches outside Promptly. "Are you sure?"
          // tells the user nothing they didn't already know.
          message:
            command.action_type === "automation"
              ? "This starts the automation now."
              : "This calls the connected tool now.",
          confirmLabel: "Run",
        });
        if (!ok) return false;
      }
      try {
        const result = await run.mutateAsync({
          id: command.id,
          confirmed: true,
          conversationId: opts.conversationId ?? null,
        });
        if (result.message) {
          // Land it in the open thread immediately. Refetching would
          // work but makes the card appear a beat late, which reads as
          // the command having not run.
          useChatStore.getState().appendMessage(
            result.message as unknown as ChatMessage
          );
        }
        toast.success(
          // The command's own spoken line if it has one — the same words
          // it will say out loud once voice exists, so the two surfaces
          // can't describe the same action differently.
          result.spoken ||
            (result.kind === "automation"
              ? `Started "${command.name}".`
              : result.output?.slice(0, 160) || `Ran "${command.name}".`)
        );
        return true;
      } catch (e) {
        toast.error(apiErrorMessage(e, `Couldn't run "${command.name}".`));
        return false;
      }
    },
    [run]
  );

  return { runCommand, isPending: run.isPending };
}

/** Phrases claimed by more than one command.
 *
 * The matcher refuses to act on an ambiguous phrase — it returns no
 * match rather than picking one — so a duplicate is a silently dead
 * command. The library has to surface that, because from the outside a
 * command that never fires looks identical to a broken feature. */
export function duplicatePhrases(commands: Command[] | undefined): Set<string> {
  const seen = new Map<string, number>();
  for (const command of commands ?? []) {
    for (const phrase of command.phrases ?? []) {
      const key = phrase.trim().toLowerCase();
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return new Set(
    [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key)
  );
}
