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
  /** Offered as the safer alternative when the account is still active. */
  onDisableInstead?: () => Promise<void>;
  onConfirm: (payload: DeleteUserPayload) => Promise<void> | void;
  onClose: () => void;
}

/** Shared workspace id -> the member picked to take it over. */
type Choice = Record<string, string>;

const selectCls = cn(
  "w-full rounded-input border px-2 py-1 text-sm",
  "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
);

/**
 * Offboarding, not just "delete". A user's shared workspaces hold their
 * collaborators' work too, so each goes to one of its members who can edit
 * it (the server suggests who; the admin can pick another member). Private
 * workspaces are only counted: they're deleted with the account, and the
 * admin never sees their names or takes them over. The admin types the
 * username to confirm, and is offered "Disable instead".
 */
export function DeleteUserModal({
  open,
  userId,
  username,
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

  const shared = preview.data?.workspaces ?? [];
  const privateCount = preview.data?.private_workspace_count ?? 0;
  const confirmed = typed.trim() === username;
  const canDelete =
    !busy && preview.isSuccess && !preview.data.is_admin && confirmed;

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
        // Only where the admin picked someone other than the suggested
        // member; the server hands the rest to the suggested one.
        transfers: Object.fromEntries(
          Object.entries(owners).filter(
            ([id, v]) => v && v !== shared.find((w) => w.id === id)?.heirs[0]?.id
          )
        ),
      })
    );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Delete user"
      description="Their shared workspaces stay with the people in them."
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

              {shared.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium">
                    Shared workspaces ({shared.length})
                  </p>
                  <p className="text-[var(--text-muted)]">
                    Each one moves to a member who can edit it, with
                    everyone&apos;s notes and files.
                  </p>
                  {shared.map((w, i) => {
                    const label = w.title ?? `Shared workspace ${i + 1}`;
                    const people = `${w.member_count} other member${w.member_count === 1 ? "" : "s"}`;
                    if (w.heirs.length === 0) {
                      return (
                        <p key={w.id} className="text-[var(--text-muted)]">
                          <span className="text-[var(--text)]">{label}</span> ·{" "}
                          {people}. Nobody else in it can edit, so it will be
                          deleted.
                        </p>
                      );
                    }
                    if (w.heirs.length === 1) {
                      return (
                        <p key={w.id} className="text-[var(--text-muted)]">
                          <span className="text-[var(--text)]">{label}</span> ·{" "}
                          {people}. Goes to{" "}
                          <span className="font-medium text-[var(--text)]">
                            {w.heirs[0].username}
                          </span>
                          .
                        </p>
                      );
                    }
                    return (
                      <label key={w.id} className="block space-y-1">
                        <span className="block text-[var(--text-muted)]">
                          <span className="text-[var(--text)]">{label}</span> ·{" "}
                          {people}. Goes to:
                        </span>
                        <select
                          className={selectCls}
                          value={owners[w.id] ?? w.heirs[0].id}
                          onChange={(e) =>
                            setOwners((o) => ({ ...o, [w.id]: e.target.value }))
                          }
                        >
                          {w.heirs.map((u, n) => (
                            <option key={u.id} value={u.id}>
                              {u.username}
                              {n === 0 ? " (suggested)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}

              {privateCount > 0 && (
                <p>
                  {privateCount === 1
                    ? "1 private workspace"
                    : `${privateCount} private workspaces`}{" "}
                  will be deleted with the account. If they want to keep{" "}
                  {privateCount === 1 ? "it" : "them"}, ask them to use Export
                  my library (Files, then Import &amp; export) first.
                </p>
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
