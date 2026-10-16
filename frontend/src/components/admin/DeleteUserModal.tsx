import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Loader2, Trash2, TriangleAlert } from "lucide-react";

import { adminApi, type DeleteUserPayload } from "@/api/admin";
import { extractError, humanSize } from "@/components/files/helpers";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

interface DeleteUserModalProps {
  open: boolean;
  userId: string | null;
  username: string;
  /** Active admins — always eligible to take over a workspace. */
  adminOptions: { id: string; username: string }[];
  /** Offered as the safer alternative when the account is still active. */
  onDisableInstead?: () => Promise<void>;
  onConfirm: (payload: DeleteUserPayload) => Promise<void> | void;
  onClose: () => void;
}

/** ``""`` = this workspace goes with the user (only allowed when solo). */
type Choice = Record<string, string>;

const selectCls = cn(
  "w-full rounded-input border px-2 py-1 text-sm",
  "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
);

/**
 * Offboarding, not just "delete". A user's workspaces hold their
 * collaborators' work too, so every workspace other people use must get a
 * new owner before the account can go (the server refuses otherwise). The
 * admin types the username to confirm, and is offered "Disable instead".
 */
export function DeleteUserModal({
  open,
  userId,
  username,
  adminOptions,
  onDisableInstead,
  onConfirm,
  onClose,
}: DeleteUserModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [owners, setOwners] = useState<Choice>({});
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const preview = useQuery({
    queryKey: ["admin", "user-deletion-preview", userId],
    queryFn: () => adminApi.deletionPreview(userId as string),
    enabled: open && userId !== null,
    staleTime: 0,
  });

  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(false);
      setTyped("");
      setOwners({});
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [open]);

  const workspaces = preview.data?.workspaces ?? [];
  const shared = workspaces.filter((w) => w.members.length > 0);
  const missing = shared.filter((w) => !owners[w.id]);
  const confirmed = typed.trim() === username;
  const canDelete =
    !busy && preview.isSuccess && !preview.data.is_admin && missing.length === 0 && confirmed;

  // A workspace can go to one of its members or to any active admin.
  const candidates = (w: (typeof workspaces)[number]) => {
    const seen = new Set<string>();
    return [...w.members, ...adminOptions].filter((u) => {
      if (u.id === userId || seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
  };

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const run = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(extractError(err));
      setBusy(false);
    }
  };

  const handleConfirm = () =>
    run(() =>
      onConfirm({
        confirm_username: typed.trim(),
        transfers: Object.fromEntries(
          Object.entries(owners).filter(([, v]) => v)
        ),
      })
    );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Delete user"
      description="Hand over anything the team still needs, then delete."
      widthClass="max-w-lg"
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={handleClose}
            disabled={busy}
            className={cn(
              "inline-flex items-center justify-center rounded-input border px-3.5 py-1.5 text-sm",
              "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
              "hover:bg-[var(--hover)]",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            Cancel
          </button>
          {onDisableInstead && (
            <button
              type="button"
              onClick={() => run(onDisableInstead)}
              disabled={busy}
              className={cn(
                "inline-flex items-center justify-center gap-1.5 rounded-input border px-3.5 py-1.5 text-sm",
                "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                "hover:bg-[var(--hover)]",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              <Ban className="h-3.5 w-3.5" />
              Disable instead
            </button>
          )}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canDelete}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-input px-3.5 py-1.5 text-sm font-medium",
              "bg-red-600 text-white transition hover:bg-red-600/90",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Working…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                Delete user
              </>
            )}
          </button>
        </>
      }
    >
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
        <div className="min-w-0 flex-1 space-y-3 text-sm text-[var(--text)]">
          {preview.isLoading && (
            <p className="flex items-center gap-2 text-[var(--text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking what{" "}
              {username} owns…
            </p>
          )}
          {preview.isError && (
            <p className="text-red-600 dark:text-red-400">
              {extractError(preview.error)}
            </p>
          )}
          {preview.data?.is_admin && (
            <p>
              <span className="font-semibold">{username}</span> is an admin.
              Change their role to User before deleting the account.
            </p>
          )}
          {preview.data && !preview.data.is_admin && (
            <>
              <p>
                Deleting <span className="font-semibold">“{username}”</span>{" "}
                removes their chats ({preview.data.conversation_count}) and
                files ({preview.data.file_count},{" "}
                {humanSize(preview.data.file_bytes)}). Chats they shared with a
                workspace stay with it. Deleted files can be recovered from
                backups for 14 days. If they might come back, disable the
                account instead.
              </p>

              {workspaces.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium">Their workspaces</p>
                  {workspaces.map((w) => {
                    const solo = w.members.length === 0;
                    return (
                      <label key={w.id} className="block space-y-1">
                        <span className="block text-[var(--text-muted)]">
                          {w.title}
                          {solo
                            ? " · only they use it"
                            : ` · ${w.members.length} member${w.members.length === 1 ? "" : "s"}`}
                        </span>
                        <select
                          className={selectCls}
                          value={owners[w.id] ?? ""}
                          onChange={(e) =>
                            setOwners((o) => ({ ...o, [w.id]: e.target.value }))
                          }
                        >
                          <option value="">
                            {solo ? "Delete it with the account" : "Choose a new owner…"}
                          </option>
                          {candidates(w).map((u) => (
                            <option key={u.id} value={u.id}>
                              Transfer to {u.username}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                  {missing.length > 0 && (
                    <p className="text-[var(--text-muted)]">
                      Other people work in{" "}
                      {missing.map((w) => w.title).join(", ")} — pick who
                      takes it over. Their notes and files move with it.
                    </p>
                  )}
                </div>
              )}

              <label className="block space-y-1">
                <span className="block text-[var(--text-muted)]">
                  Type <span className="font-mono">{username}</span> to confirm
                </span>
                <input
                  className={selectCls}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            "mt-4 rounded-card border px-3 py-2 text-sm",
            "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          )}
        >
          {error}
        </div>
      )}
    </Modal>
  );
}
