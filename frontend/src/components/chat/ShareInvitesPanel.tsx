import { FolderKanban, Loader2, MessageSquare } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import {
  useAcceptInvite,
  useDeclineInvite,
  useShareInvites,
} from "@/hooks/useConversations";
import {
  useAcceptProjectInvite,
  useDeclineProjectInvite,
  useProjectInvites,
} from "@/hooks/useChatProjects";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Unified invites inbox — conversation-level and project-level.
 *
 *  Previously only surfaced single-chat invites. Since project
 *  sharing (0031) lets someone invite you to an entire project at
 *  once, this panel now splits into two sections so the user can
 *  scan "which chat?" vs "which workspace?" at a glance. The
 *  sidebar pill count still represents the combined total; this
 *  modal handles both accept/decline flows.
 */
export function ShareInvitesPanel({ open, onClose }: Props) {
  const convInvitesQ = useShareInvites();
  const projInvitesQ = useProjectInvites();
  const acceptConv = useAcceptInvite();
  const declineConv = useDeclineInvite();
  const acceptProj = useAcceptProjectInvite();
  const declineProj = useDeclineProjectInvite();

  const convInvites = convInvitesQ.data ?? [];
  const projInvites = projInvitesQ.data ?? [];
  const isLoading = convInvitesQ.isLoading || projInvitesQ.isLoading;
  const empty =
    !isLoading && convInvites.length === 0 && projInvites.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invites"
      description="Teammates have invited you to collaborate. Accepting a project opens up every chat inside it; accepting a single chat adds just that one to your sidebar."
      widthClass="max-w-xl"
    >
      {isLoading ? (
        <div className="text-xs text-[var(--text-muted)]">Loading…</div>
      ) : empty ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
          No pending invites right now.
        </div>
      ) : (
        <div className="space-y-5">
          {projInvites.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <FolderKanban className="h-3 w-3" />
                Project invites ({projInvites.length})
              </h3>
              <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                {projInvites.map((row) => (
                  <li key={row.id} className="px-3 py-3 text-sm">
                    <div className="mb-1 truncate font-medium text-[var(--text)]">
                      {row.project_title || "Untitled project"}
                    </div>
                    <div className="mb-2 truncate text-xs text-[var(--text-muted)]">
                      Invited by{" "}
                      <span className="font-medium text-[var(--text)]">
                        {row.inviter.username}
                      </span>
                      . You'll get full access to every chat in this project.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => acceptProj.mutate(row.id)}
                        disabled={acceptProj.isPending}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                          "bg-[var(--accent)] text-white transition hover:opacity-90 disabled:opacity-60"
                        )}
                      >
                        {acceptProj.isPending && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => declineProj.mutate(row.id)}
                        disabled={declineProj.isPending}
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-xs font-medium",
                          "border-[var(--border)] text-[var(--text-muted)]",
                          "hover:border-red-500/40 hover:text-red-500"
                        )}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {convInvites.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <MessageSquare className="h-3 w-3" />
                Conversation invites ({convInvites.length})
              </h3>
              <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                {convInvites.map((row) => (
                  <li key={row.id} className="px-3 py-3 text-sm">
                    <div className="mb-1 truncate font-medium text-[var(--text)]">
                      {row.conversation_title?.trim() || "Untitled chat"}
                    </div>
                    <div className="mb-2 truncate text-xs text-[var(--text-muted)]">
                      Invited by{" "}
                      <span className="font-medium text-[var(--text)]">
                        {row.inviter.username}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => acceptConv.mutate(row.id)}
                        disabled={acceptConv.isPending}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                          "bg-[var(--accent)] text-white transition hover:opacity-90 disabled:opacity-60"
                        )}
                      >
                        {acceptConv.isPending && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => declineConv.mutate(row.id)}
                        disabled={declineConv.isPending}
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-xs font-medium",
                          "border-[var(--border)] text-[var(--text-muted)]",
                          "hover:border-red-500/40 hover:text-red-500"
                        )}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
