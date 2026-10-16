import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  PencilLine,
  Sparkles,
  SquareKanban,
  X,
} from "lucide-react";

import { proposalsApi, type FileChangeStep, type WorkspaceProposal } from "@/api/chat";
import { photosApi } from "@/api/photos";
import { invalidateFileQueries } from "@/hooks/useFiles";
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
  /** ``null`` outside a workspace — only file-change proposals there. */
  workspaceId: string | null;
}) {
  const qc = useQueryClient();
  const key = ["chat", "proposals", conversationId];
  const { data: proposals } = useQuery({
    queryKey: key,
    queryFn: () => proposalsApi.list(conversationId),
    // A tool that files a proposal refreshes this from the stream; the
    // poll is the backstop (workspace chats, or while one is pending).
    refetchInterval: (q) =>
      workspaceId || (q.state.data as WorkspaceProposal[] | undefined)?.some((p) => p.status === "pending")
        ? 7000
        : false,
  });

  const apply = useMutation({
    mutationFn: (id: string) => proposalsApi.apply(id),
    onSuccess: (updated) => {
      qc.setQueryData<WorkspaceProposal[]>(key, (old) =>
        (old ?? []).map((p) => (p.id === updated.id ? updated : p))
      );
      if (updated.kind === "file_changes") {
        invalidateFileQueries(qc);
        toast.success("Files organised");
        return;
      }
      if (updated.kind.startsWith("photo_")) {
        void qc.invalidateQueries({ queryKey: ["albums"] });
        void qc.invalidateQueries({ queryKey: ["people"] });
        toast.success(PHOTO_DONE[updated.kind] ?? "Done");
        return;
      }
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
  const isFiles = p.kind === "file_changes";
  const isPhoto = p.kind.startsWith("photo_");
  const cards = p.payload.cards ?? [];
  const applied = p.status === "applied";
  const changeSummary = isUpdate ? describeChanges(p.payload.changes) : null;

  // An applied banner is a receipt — it shouldn't linger full-size and pile
  // up. A few seconds after it applies, fade it down to a compact ✓ chip
  // (still clickable to open, still dismissable) so the trail stays legible
  // without a stack of full-width cards. Hovering pauses the countdown so a
  // user reaching for Open/Preview never has it vanish mid-reach. Pending
  // cards never auto-collapse.
  const [phase, setPhase] = useState<"full" | "fading" | "chip">("full");
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!applied || phase !== "full" || hovered) return;
    const t = window.setTimeout(() => setPhase("fading"), 5000);
    return () => window.clearTimeout(t);
  }, [applied, phase, hovered]);
  // Reset if a proposal somehow flips back to pending (e.g. refetch race).
  useEffect(() => {
    if (!applied) setPhase("full");
  }, [applied]);

  const appliedLabel = isPhoto
    ? PHOTO_DONE[p.kind] ?? "Done"
    : isFiles
    ? "Files organised"
    : isNote
    ? "Note created"
    : isUpdate
      ? `Updated ${cards.length} card${cards.length === 1 ? "" : "s"}`
      : `Added ${cards.length} card${cards.length === 1 ? "" : "s"}`;
  const appliedContext = isFiles || isPhoto
    ? p.payload.summary
    : isNote
    ? p.payload.title
    : p.payload.board_title;

  // "Open" jumps to what Apply produced. Prefer the item-preview modal
  // (same as an @-mention pill) when we're inside the workspace page;
  // fall back to a route change otherwise.
  const openApplied = () => {
    if (isPhoto) {
      navigate(
        p.kind === "photo_relationship"
          ? `/files/photos/people/${p.applied_item_id ?? ""}`
          : p.applied_item_id ? `/files/photos/albums/${p.applied_item_id}` : "/files/photos/albums",
      );
      return;
    }
    if (isFiles) {
      // Where the files went (the first destination), else Files.
      navigate(p.applied_item_id ? `/files/folder/${p.applied_item_id}` : "/files");
      return;
    }
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

  // Collapsed receipt — a small ✓ chip that persists after the banner fades,
  // so there's a lasting, clickable trace that the AI changed something.
  if (applied && phase === "chip") {
    return (
      <div className="flex">
        <button
          type="button"
          onClick={openApplied}
          title={
            appliedContext
              ? `${appliedLabel} · ${appliedContext} — open`
              : `${appliedLabel} — open`
          }
          className={cn(
            "group inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
            "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]",
            "transition hover:border-[var(--success)]/50 hover:bg-[var(--success)]/15"
          )}
        >
          <Check className="h-3 w-3 shrink-0" />
          <span className="truncate font-medium">{appliedLabel}</span>
          {appliedContext && (
            <span className="truncate text-[var(--success)]/70">
              · {appliedContext}
            </span>
          )}
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="ml-0.5 shrink-0 rounded-full p-0.5 text-[var(--success)]/60 opacity-0 transition hover:bg-[var(--success)]/20 hover:text-[var(--success)] group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onTransitionEnd={(e) => {
        // Only our own opacity fade ends the banner — ignore bubbled
        // child hover transitions, which would swap to the chip early.
        if (
          phase === "fading" &&
          e.target === e.currentTarget &&
          e.propertyName === "opacity"
        ) {
          setPhase("chip");
        }
      }}
      className={cn(
        "overflow-hidden rounded-card border bg-[var(--surface)] transition-opacity duration-500",
        applied
          ? "border-[var(--success)]/40"
          : "border-[var(--accent)]/50",
        phase === "fading" ? "opacity-0" : "opacity-100"
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles
          className={cn(
            "h-4 w-4 shrink-0",
            applied ? "text-[var(--success)]" : "text-[var(--accent-text)]"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
          {applied ? "Applied: " : "AI proposes: "}
          {isPhoto ? (
            <span className="text-[var(--text)]">{p.payload.summary}</span>
          ) : isFiles ? (
            <>
              organise your files{" "}
              <span className="text-[var(--text-muted)]">· {p.payload.summary}</span>
            </>
          ) : isNote ? (
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
          <>
            <button
              type="button"
              onClick={openApplied}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-[var(--success)] transition hover:bg-[var(--success-bg)]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </button>
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              title="Clear this from the chat — the change stays applied"
              aria-label="Clear applied proposal"
              className="inline-flex shrink-0 items-center gap-1 rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
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
          {isPhoto ? (
            <PhotoProposalPreview proposal={p} />
          ) : isFiles ? (
            <FileChangeList steps={p.payload.operations ?? []} />
          ) : isNote ? (
            <div className="promptly-prose max-h-72 overflow-y-auto text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {p.payload.markdown ?? ""}
              </ReactMarkdown>
            </div>
          ) : isUpdate ? (
            <>
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)]/10 px-2 py-1 text-xs font-medium text-[var(--accent-text)]">
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
            {isFiles ? (
              <Folder className="h-3 w-3" />
            ) : isNote ? (
              <FileText className="h-3 w-3" />
            ) : (
              <SquareKanban className="h-3 w-3" />
            )}
            {isFiles
              ? "Nothing moves until you hit Apply — and then all of it or none of it."
              : isUpdate
              ? "Nothing changes on the board until you hit Apply."
              : "Nothing is written to the workspace until you hit Apply."}
          </p>
        </div>
      )}
    </div>
  );
}

/** The steps of a ``file_changes`` proposal, in order, in paths. */
function FileChangeList({ steps }: { steps: FileChangeStep[] }) {
  const where = (path?: string) => (path ? path : "My files");
  return (
    <ol className="max-h-72 space-y-1.5 overflow-y-auto text-sm" aria-label="Proposed file changes">
      {steps.map((s, i) => {
        const Icon = s.item_type === "folder" ? Folder : FileIcon;
        if (s.op === "create_folder") {
          return (
            <li key={i} className="flex items-center gap-2 text-[var(--text)]">
              <FolderPlus className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
              <span className="min-w-0 truncate">
                New folder <span className="font-medium">{s.path}</span>
                {s.exists && <span className="text-[var(--text-muted)]"> (already there)</span>}
              </span>
            </li>
          );
        }
        if (s.op === "rename") {
          return (
            <li key={i} className="flex min-w-0 items-center gap-2 text-[var(--text)]">
              <PencilLine className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 truncate">{s.name}</span>
              <ArrowRight className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 truncate font-medium">{s.new_name}</span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">in {where(s.from)}</span>
            </li>
          );
        }
        return (
          <li key={i} className="flex min-w-0 items-center gap-2 text-[var(--text)]">
            <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 truncate font-medium">{s.name}</span>
            <span className="shrink-0 text-xs text-[var(--text-muted)]">{where(s.from)}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 truncate">
              {where(s.to)}
              {s.to_new && <span className="text-xs text-[var(--accent-text)]"> (new)</span>}
            </span>
          </li>
        );
      })}
    </ol>
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

const PHOTO_DONE: Record<string, string> = {
  photo_album: "Album ready",
  photo_share: "Album shared",
  photo_relationship: "Remembered",
};

/** What a photo proposal would do: the photos (first dozen), who it's
 *  shared with, or who someone is to you. */
function PhotoProposalPreview({ proposal: p }: { proposal: WorkspaceProposal }) {
  const ids = (p.payload.file_ids ?? []).slice(0, 12);
  const { data: photos } = useQuery({
    queryKey: ["proposal-photos", p.id],
    queryFn: () => photosApi.items(ids),
    enabled: p.kind === "photo_album" && ids.length > 0,
    staleTime: 5 * 60_000,
  });
  if (p.kind === "photo_share") {
    return (
      <p className="text-sm text-[var(--text)]">
        {(p.payload.people ?? []).map((x) => x.username).join(", ")} {p.payload.role === "contributor" ? "can see it and add their photos" : "can see it"}.
      </p>
    );
  }
  if (p.kind === "photo_relationship") {
    return (
      <p className="text-sm text-[var(--text)]">
        Searches like “me and {p.payload.label}” will find {p.payload.person_name}. Only you see this.
      </p>
    );
  }
  return (
    <div>
      <p className="mb-2 text-xs text-[var(--text-muted)]">
        {p.payload.count ?? ids.length} photo{(p.payload.count ?? ids.length) === 1 ? "" : "s"}
        {p.payload.smart_rules ? " now — new ones that match join by themselves" : ""}
      </p>
      <div className="flex flex-wrap gap-1" aria-label="Photos in the proposal">
        {(photos ?? []).map((ph) =>
          ph.thumb ? <img key={ph.id} src={ph.thumb} alt="" className="h-14 w-14 rounded object-cover" /> : <span key={ph.id} className="h-14 w-14 rounded bg-[var(--hover)]" />,
        )}
      </div>
    </div>
  );
}
