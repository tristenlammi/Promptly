import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Sparkles,
  SquareKanban,
  X,
} from "lucide-react";

import { proposalsApi, type WorkspaceProposal } from "@/api/chat";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { useItemPreview } from "@/components/workspaces/itemPreviewContext";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Preview cards for the AI's workspace write-back proposals (Batch 4.1).
 *
 * Rendered between the message list and the composer in workspace
 * chats. The AI can only *file* proposals; nothing touches the
 * workspace until Apply is clicked here — the card shows exactly what
 * would be created (full note preview, every card with its fields), so
 * approval is informed, not a rubber stamp.
 */
const PRIORITY_DOT: Record<string, string> = {
  high: "text-red-500",
  medium: "text-amber-500",
  low: "text-slate-400",
};

export function WorkspaceProposalsPanel({
  conversationId,
  workspaceId,
}: {
  conversationId: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const key = ["chat", "proposals", conversationId];
  const { data: proposals } = useQuery({
    queryKey: key,
    queryFn: () => proposalsApi.list(conversationId),
    // The AI files proposals mid-stream; a short poll picks them up
    // right after the reply lands without wiring into the SSE stream.
    refetchInterval: 7000,
  });

  const apply = useMutation({
    mutationFn: (id: string) => proposalsApi.apply(id),
    onSuccess: (updated) => {
      qc.setQueryData<WorkspaceProposal[]>(key, (old) =>
        (old ?? []).map((p) => (p.id === updated.id ? updated : p))
      );
      // The workspace tree/overview just gained content.
      qc.invalidateQueries({ queryKey: ["workspaces", "tree", workspaceId] });
      qc.invalidateQueries({ queryKey: ["workspaces", "tasks", workspaceId] });
      toast.success(
        updated.kind === "create_note"
          ? "Note created"
          : updated.kind === "update_cards"
            ? "Cards updated"
            : "Cards added"
      );
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e, "Couldn't apply the proposal. Try again."));
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => proposalsApi.dismiss(id),
    onSuccess: (updated) =>
      qc.setQueryData<WorkspaceProposal[]>(key, (old) =>
        (old ?? []).map((p) => (p.id === updated.id ? updated : p))
      ),
  });

  const visible = (proposals ?? []).filter(
    (p) => p.status === "pending" || p.status === "applied"
  );
  if (visible.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div className="space-y-2">
        {visible.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            busy={apply.isPending || dismiss.isPending}
            onApply={() => apply.mutate(p.id)}
            onDismiss={() => dismiss.mutate(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProposalCard({
  proposal: p,
  busy,
  onApply,
  onDismiss,
}: {
  proposal: WorkspaceProposal;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const preview = useItemPreview();
  const [expanded, setExpanded] = useState(false);
  const isNote = p.kind === "create_note";
  const isUpdate = p.kind === "update_cards";
  const cards = p.payload.cards ?? [];
  const applied = p.status === "applied";
  const changeSummary = isUpdate ? describeChanges(p.payload.changes) : null;

  // "Open" jumps to what Apply produced. Prefer the item-preview modal
  // (same as an @-mention pill) when we're inside the workspace page;
  // fall back to a route change otherwise.
  const openApplied = () => {
    const kind: WorkspaceItemNode["kind"] = isNote ? "note" : "board";
    if (p.applied_item_id && preview) {
      preview({
        id: p.applied_item_id,
        kind,
        ref_id: null,
        title: p.payload.title ?? p.payload.board_title ?? "",
        icon: null,
        position: 0,
        indexing_status: null,
        children: [],
      });
      return;
    }
    navigate(
      p.applied_item_id
        ? `/workspaces/${p.workspace_id}?item=${p.applied_item_id}`
        : `/workspaces/${p.workspace_id}`
    );
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border bg-[var(--surface)]",
        applied
          ? "border-[var(--success)]/40"
          : "border-[var(--accent)]/50"
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles
          className={cn(
            "h-4 w-4 shrink-0",
            applied ? "text-[var(--success)]" : "text-[var(--accent)]"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
          {applied ? "Applied: " : "AI proposes: "}
          {isNote ? (
            <>
              create note{" "}
              <span className="font-medium">
                “{p.payload.title ?? "Untitled"}”
              </span>
            </>
          ) : isUpdate ? (
            <>
              update {cards.length} card{cards.length === 1 ? "" : "s"} on{" "}
              <span className="font-medium">
                “{p.payload.board_title ?? "the board"}”
              </span>
              {changeSummary && (
                <span className="text-[var(--text-muted)]"> · {changeSummary}</span>
              )}
            </>
          ) : (
            <>
              add {cards.length} card{cards.length === 1 ? "" : "s"} to{" "}
              <span className="font-medium">
                “{p.payload.board_title ?? "the board"}”
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Preview
        </button>
        {applied ? (
          <button
            type="button"
            onClick={openApplied}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-[var(--success)] transition hover:bg-[var(--success-bg)]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Dismiss
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Apply
            </button>
          </>
        )}
      </div>

      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-2.5">
          {isNote ? (
            <div className="promptly-prose max-h-72 overflow-y-auto text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {p.payload.markdown ?? ""}
              </ReactMarkdown>
            </div>
          ) : isUpdate ? (
            <>
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)]/10 px-2 py-1 text-xs font-medium text-[var(--accent)]">
                <SquareKanban className="h-3.5 w-3.5" />
                {changeSummary ?? "update cards"}
              </div>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {cards.map((c, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-sm text-[var(--text)]"
                  >
                    <CircleDot className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                    <span className="min-w-0 truncate">{c.title}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ul className="space-y-1.5">
              {cards.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <CircleDot
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      PRIORITY_DOT[c.priority ?? "medium"]
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-[var(--text)]">{c.title}</span>
                    {c.description && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--text-muted)]">
                        {c.description}
                      </span>
                    )}
                  </span>
                  {c.due_date && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)]">
                      <Clock className="h-3 w-3" />
                      {c.due_date}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            {isNote ? (
              <FileText className="h-3 w-3" />
            ) : (
              <SquareKanban className="h-3 w-3" />
            )}
            {isUpdate
              ? "Nothing changes on the board until you hit Apply."
              : "Nothing is written to the workspace until you hit Apply."}
          </p>
        </div>
      )}
    </div>
  );
}

/** One-line human summary of an ``update_cards`` change set for the card
 *  header + preview chip (e.g. "mark done · high priority"). */
function describeChanges(
  changes: WorkspaceProposal["payload"]["changes"]
): string | null {
  if (!changes) return null;
  const bits: string[] = [];
  if (changes.status) {
    bits.push(
      changes.status === "done" ? "mark done" : `move to ${changes.status}`
    );
  }
  if (changes.priority) bits.push(`${changes.priority} priority`);
  if (changes.due_date === null) bits.push("clear due date");
  else if (changes.due_date) bits.push(`due ${changes.due_date}`);
  return bits.length ? bits.join(" · ") : null;
}
