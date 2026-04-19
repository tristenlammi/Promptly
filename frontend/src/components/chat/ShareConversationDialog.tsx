import { useState } from "react";
import { Loader2, Trash2, UserPlus } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import {
  useConversationShares,
  useCreateShare,
  useDeleteShare,
} from "@/hooks/useConversations";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  conversationId: string;
  onClose: () => void;
}

/** Owner-only modal for inviting friends to a conversation and
 *  managing existing shares. The triggering surface (chat header
 *  share button) only renders for owners, but the backend also
 *  enforces it so a curious user can't sneak in via devtools. */
export function ShareConversationDialog({
  open,
  conversationId,
  onClose,
}: Props) {
  const { data, isLoading, isError } = useConversationShares(
    open ? conversationId : null
  );
  const create = useCreateShare(conversationId);
  const remove = useDeleteShare(conversationId);

  const [identifier, setIdentifier] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const trimmed = identifier.trim();
    if (!trimmed) return;
    // Heuristic: if it looks like an email, send as email; otherwise
    // treat as a username. The backend accepts either, so this is
    // purely about giving people the right autocomplete on mobile.
    const payload = trimmed.includes("@")
      ? { email: trimmed }
      : { username: trimmed };
    try {
      await create.mutateAsync(payload);
      setIdentifier("");
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't send the invite. Try again.";
      setErrorMsg(String(detail));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share this conversation"
      description="Invite a friend by username or email. They'll see it in their invites and the chat will show up in their sidebar once they accept. Whoever sends each message pays for it."
      widthClass="max-w-xl"
    >
      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="Username or email"
          className={cn(
            "min-w-0 flex-1 rounded-input border px-3 py-2 text-sm",
            "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
            "focus:border-[var(--accent)]/60 focus:outline-none"
          )}
          autoFocus
        />
        <button
          type="submit"
          disabled={!identifier.trim() || create.isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-input px-3 py-2 text-sm font-medium",
            "bg-[var(--accent)] text-white transition hover:opacity-90",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          {create.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <UserPlus className="h-3.5 w-3.5" />
          )}
          Invite
        </button>
      </form>

      {errorMsg && (
        <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {errorMsg}
        </div>
      )}

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          People with access
        </h3>
        {isLoading ? (
          <div className="text-xs text-[var(--text-muted)]">Loading…</div>
        ) : isError ? (
          <div className="text-xs text-red-500">
            Couldn't load existing shares. Try again in a moment.
          </div>
        ) : (data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--text-muted)]">
            No one else yet. Invite a friend above to start collaborating.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {(data ?? []).map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[var(--text)]">
                    {row.invitee.username}
                  </div>
                  <div className="truncate text-xs text-[var(--text-muted)]">
                    {row.invitee.email}
                  </div>
                </div>
                <StatusPill status={row.status} />
                <button
                  type="button"
                  onClick={() => remove.mutate(row.id)}
                  className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500"
                  title={
                    row.status === "accepted"
                      ? "Remove access"
                      : row.status === "declined"
                        ? "Remove invite"
                        : "Cancel invite"
                  }
                  aria-label="Remove share"
                  disabled={remove.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function StatusPill({ status }: { status: "pending" | "accepted" | "declined" }) {
  const map: Record<typeof status, { label: string; cls: string }> = {
    pending: {
      label: "Pending",
      cls: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    },
    accepted: {
      label: "Active",
      cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    },
    declined: {
      label: "Declined",
      cls: "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400",
    },
  };
  const meta = map[status];
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.cls
      )}
    >
      {meta.label}
    </span>
  );
}
