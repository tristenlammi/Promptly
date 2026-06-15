import { FolderKanban, Loader2 } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import {
  useAcceptWorkspaceInvite,
  useDeclineWorkspaceInvite,
  useWorkspaceInvites,
} from "@/hooks/useWorkspaces";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Workspace invites inbox.
 *
 *  Per-chat sharing was removed, so this panel now only surfaces
 *  workspace-level invites (0031): accepting one opens up every chat
 *  inside that workspace. The sidebar pill count reflects the number
 *  of pending workspace invites.
 */
export function ShareInvitesPanel({ open, onClose }: Props) {
  const wsInvitesQ = useWorkspaceInvites();
  const acceptWs = useAcceptWorkspaceInvite();
  const declineWs = useDeclineWorkspaceInvite();

  const wsInvites = wsInvitesQ.data ?? [];
  const isLoading = wsInvitesQ.isLoading;
  const empty = !isLoading && wsInvites.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invites"
      description="Teammates have invited you to collaborate. Accepting a workspace opens up every chat inside it."
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
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <FolderKanban className="h-3 w-3" />
              Workspace invites ({wsInvites.length})
            </h3>
            <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
              {wsInvites.map((row) => (
                <li key={row.id} className="px-3 py-3 text-sm">
                  <div className="mb-1 truncate font-medium text-[var(--text)]">
                    {row.workspace_title || "Untitled workspace"}
                  </div>
                  <div className="mb-2 truncate text-xs text-[var(--text-muted)]">
                    Invited by{" "}
                    <span className="font-medium text-[var(--text)]">
                      {row.inviter.username}
                    </span>
                    . You'll get full access to every chat in this workspace.
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => acceptWs.mutate(row.id)}
                      disabled={acceptWs.isPending}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                        "bg-[var(--accent)] text-white transition hover:opacity-90 disabled:opacity-60"
                      )}
                    >
                      {acceptWs.isPending && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => declineWs.mutate(row.id)}
                      disabled={declineWs.isPending}
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
        </div>
      )}
    </Modal>
  );
}
