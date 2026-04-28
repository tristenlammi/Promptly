import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookmarkPlus,
  CheckCircle2,
  ExternalLink,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { chatApi, type SummariseToProjectResult } from "@/api/chat";
import { Modal } from "@/components/shared/Modal";
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
 *  Uses the shared :class:`Modal` shell rather than the browser's
 *  ``window.confirm`` / ``window.alert`` dialogs — those broke flow
 *  on touch devices (no Esc, no focus styling) and didn't match the
 *  Promptly chrome around them. The modal handles all three states
 *  inline (confirm / busy / done-or-error) so the user never sees
 *  a system pop-up.
 */
export function SummariseToProjectButton({
  conversationId,
  compact = false,
}: SummariseToProjectButtonProps) {
  const [open, setOpen] = useState(false);

  const label = "Save summary to project";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)] disabled:opacity-60",
          compact ? "h-9 w-9 justify-center" : "px-2.5 py-1.5 text-xs"
        )}
      >
        <BookmarkPlus className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!compact && "Save to project"}
      </button>
      <SummariseToProjectModal
        open={open}
        conversationId={conversationId}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "success"; result: SummariseToProjectResult }
  | { kind: "error"; message: string };

function SummariseToProjectModal({
  open,
  conversationId,
  onClose,
}: {
  open: boolean;
  conversationId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Reset to idle every time the modal re-opens so stale state from
  // a previous run doesn't bleed through, and focus the safe button.
  useEffect(() => {
    if (open) {
      setStatus({ kind: "idle" });
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [open]);

  const handleClose = () => {
    if (status.kind === "saving") return;
    onClose();
  };

  const handleConfirm = async () => {
    if (status.kind === "saving") return;
    setStatus({ kind: "saving" });
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
      setStatus({ kind: "success", result: res });
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't save the summary. Try again in a moment.";
      setStatus({ kind: "error", message: detail });
    }
  };

  const handleOpenProject = () => {
    if (status.kind !== "success") return;
    navigate(`/projects/${status.result.project_id}`);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={
        status.kind === "success"
          ? "Summary saved"
          : "Save summary to project"
      }
      description={
        status.kind === "success"
          ? "Pinned to the project — every chat in it will pick it up on the next turn."
          : status.kind === "error"
            ? undefined
            : "We'll generate a one-page Markdown memo of this chat and pin it to the project as a file."
      }
      widthClass="max-w-md"
      footer={<Footer
        status={status}
        cancelRef={cancelRef}
        onClose={handleClose}
        onConfirm={handleConfirm}
        onOpenProject={handleOpenProject}
      />}
    >
      {status.kind === "success" ? (
        <SuccessBody result={status.result} />
      ) : status.kind === "error" ? (
        <ErrorBody message={status.message} />
      ) : (
        <ConfirmBody />
      )}
    </Modal>
  );
}

function ConfirmBody() {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          "bg-[var(--accent)]/10 text-[var(--accent)]"
        )}
        aria-hidden
      >
        <BookmarkPlus className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2 text-sm text-[var(--text)]">
        <p>
          We'll ask the current model for a one-page memo covering the key
          decisions, facts, and open questions in this conversation.
        </p>
        <p className="text-[var(--text-muted)]">
          The file lands in your <strong>Generated</strong> folder and gets
          auto-pinned to the project. You can unpin or delete it from the
          project's settings any time. Nothing inside this chat is changed.
        </p>
      </div>
    </div>
  );
}

function SuccessBody({ result }: { result: SummariseToProjectResult }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        )}
        aria-hidden
      >
        <CheckCircle2 className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 text-sm text-[var(--text)]">
        <p>
          Saved <span className="font-semibold">&ldquo;{result.filename}&rdquo;</span>{" "}
          to project{" "}
          <span className="font-semibold">&ldquo;{result.project_title}&rdquo;</span>.
        </p>
        <p className="mt-1 text-[var(--text-muted)]">
          From the next turn, every chat in this project will see the summary
          alongside any other pinned files.
        </p>
      </div>
    </div>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          "bg-red-500/10 text-red-600 dark:text-red-400"
        )}
        aria-hidden
      >
        <TriangleAlert className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 text-sm text-[var(--text)]">
        <p className="font-medium">Couldn't save the summary</p>
        <p className="mt-1 text-[var(--text-muted)]">{message}</p>
      </div>
    </div>
  );
}

function Footer({
  status,
  cancelRef,
  onClose,
  onConfirm,
  onOpenProject,
}: {
  status: Status;
  cancelRef: React.RefObject<HTMLButtonElement>;
  onClose: () => void;
  onConfirm: () => void;
  onOpenProject: () => void;
}) {
  const ghostBtn = cn(
    "inline-flex items-center justify-center rounded-input border px-3.5 py-1.5 text-sm",
    "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
    "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
    "disabled:cursor-not-allowed disabled:opacity-50"
  );
  const primaryBtn = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-input px-3.5 py-1.5 text-sm font-medium",
    "bg-[var(--accent)] text-white transition hover:bg-[var(--accent-hover)]",
    "disabled:cursor-not-allowed disabled:opacity-60"
  );

  if (status.kind === "success") {
    return (
      <>
        <button
          ref={cancelRef}
          type="button"
          onClick={onClose}
          className={ghostBtn}
        >
          Close
        </button>
        <button type="button" onClick={onOpenProject} className={primaryBtn}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open project
        </button>
      </>
    );
  }

  if (status.kind === "error") {
    return (
      <>
        <button
          ref={cancelRef}
          type="button"
          onClick={onClose}
          className={ghostBtn}
        >
          Close
        </button>
        <button type="button" onClick={onConfirm} className={primaryBtn}>
          <BookmarkPlus className="h-3.5 w-3.5" />
          Try again
        </button>
      </>
    );
  }

  const busy = status.kind === "saving";
  return (
    <>
      <button
        ref={cancelRef}
        type="button"
        onClick={onClose}
        disabled={busy}
        className={ghostBtn}
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={primaryBtn}
      >
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Saving…
          </>
        ) : (
          <>
            <BookmarkPlus className="h-3.5 w-3.5" />
            Save to project
          </>
        )}
      </button>
    </>
  );
}
