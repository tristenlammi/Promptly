import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookmarkPlus, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { chatApi } from "@/api/chat";
import { cn } from "@/utils/cn";

interface SummariseToProjectButtonProps {
  conversationId: string;
  /** Rendered icon-only when true (mobile treatment matches the
   *  other TopNav action buttons). Desktop shows a label. */
  compact?: boolean;
}

/** Header button that generates a Markdown memo of the whole chat
 *  and pins it to the conversation's parent project as a file.
 *
 *  Only shown when the conversation already lives inside a project
 *  (the parent hides it otherwise). The summary is produced with
 *  the same pipeline the ``/compact`` endpoint uses but run over
 *  the full transcript, not just the middle — nothing inside the
 *  chat itself is mutated. The resulting file is auto-pinned so
 *  every other chat in the project picks it up on their next turn
 *  via the existing project-file injection path.
 *
 *  Success / failure messaging is intentionally ``window.confirm`` /
 *  ``window.alert`` rather than a toast, matching the ``handleCompact``
 *  pattern in ChatPage — keeps the UX consistent across the two
 *  sibling "maintenance" actions.
 */
export function SummariseToProjectButton({
  conversationId,
  compact = false,
}: SummariseToProjectButtonProps) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const onClick = async () => {
    if (busy) return;
    const ok = window.confirm(
      "Save a Markdown summary of this chat to the project?\n\n" +
        "We'll ask the current model for a one-page memo covering the " +
        "key decisions, facts, and open questions in this conversation, " +
        "then pin it as a file to the project so every other chat in it " +
        "picks it up on the next turn.\n\n" +
        "The file lands in your Generated folder and you can unpin or " +
        "delete it from the project's settings anytime."
    );
    if (!ok) return;

    setBusy(true);
    try {
      const res = await chatApi.summariseToProject(conversationId);
      // Refresh project file list + file tree so the new pinned
      // summary shows up without a hard reload.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["chat-project", res.project_id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["chat-project-files", res.project_id],
        }),
        queryClient.invalidateQueries({ queryKey: ["files"] }),
      ]);
      const viewIt = window.confirm(
        `Summary saved to project "${res.project_title}" as ` +
          `"${res.filename}".\n\n` +
          "Open the project now to review it?"
      );
      if (viewIt) {
        navigate(`/projects/${res.project_id}`);
      }
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't save the summary. Try again in a moment.";
      window.alert(detail);
    } finally {
      setBusy(false);
    }
  };

  const label = "Save summary to project";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)] disabled:opacity-60",
        compact ? "h-9 w-9 justify-center" : "px-2.5 py-1.5 text-xs"
      )}
    >
      {busy ? (
        <Loader2
          className={cn("animate-spin", compact ? "h-4 w-4" : "h-3.5 w-3.5")}
        />
      ) : (
        <BookmarkPlus className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
      )}
      {!compact && "Save to project"}
    </button>
  );
}
