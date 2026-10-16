import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plug } from "lucide-react";

import { chatApi, type ChatConnector } from "@/api/chat";
import { cn } from "@/utils/cn";

/**
 * The outside services this chat can use with Tools on, each switchable
 * for this chat (R-161). Every reachable connector used to ride along on
 * every turn, and this is also the only place a user can see what's
 * connected at all. Hidden when there's nothing to show.
 */
export function ChatConnectorsSection({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const key = ["chat-connectors", conversationId] as const;
  const { data: connectors = [] } = useQuery({
    queryKey: key,
    queryFn: () => chatApi.listChatConnectors(conversationId),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (next: ChatConnector[]) =>
      chatApi.setChatConnectors(
        conversationId,
        next.filter((c) => !c.on).map((c) => c.id)
      ),
    onMutate: (next) => {
      qc.setQueryData(key, next);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  if (connectors.length === 0) return null;

  const toggle = (id: string) =>
    save.mutate(connectors.map((c) => (c.id === id ? { ...c, on: !c.on } : c)));

  return (
    <>
      <div className="my-1 border-t border-[var(--border)]" />
      <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Connectors in this chat
      </div>
      {connectors.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={c.on}
          onClick={() => toggle(c.id)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-[var(--accent)]/[0.08]"
          )}
        >
          <span
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center",
              c.on ? "text-[var(--accent-text)]" : "text-transparent"
            )}
            aria-hidden
          >
            <Check className="h-4 w-4" />
          </span>
          <Plug className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{c.name}</span>
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
            {c.tool_count} tool{c.tool_count === 1 ? "" : "s"}
          </span>
        </button>
      ))}
    </>
  );
}
