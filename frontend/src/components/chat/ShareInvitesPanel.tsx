import { Loader2 } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import {
  useAcceptInvite,
  useDeclineInvite,
  useShareInvites,
} from "@/hooks/useConversations";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Shows pending share invites and lets the invitee accept or
 *  decline. Triggered from the sidebar pill that appears whenever
 *  the polled invites list is non-empty. */
export function ShareInvitesPanel({ open, onClose }: Props) {
  const { data, isLoading } = useShareInvites();
  const accept = useAcceptInvite();
  const decline = useDeclineInvite();

  const invites = data ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Conversation invites"
      description="Friends invited you to collaborate on these chats. Accepting puts the chat in your sidebar; you can post and reply just like your own."
      widthClass="max-w-xl"
    >
      {isLoading ? (
        <div className="text-xs text-[var(--text-muted)]">Loading…</div>
      ) : invites.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
          No pending invites right now.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {invites.map((row) => (
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
                  onClick={() => accept.mutate(row.id)}
                  disabled={accept.isPending}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                    "bg-[var(--accent)] text-white transition hover:opacity-90 disabled:opacity-60"
                  )}
                >
                  {accept.isPending && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => decline.mutate(row.id)}
                  disabled={decline.isPending}
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
      )}
    </Modal>
  );
}
