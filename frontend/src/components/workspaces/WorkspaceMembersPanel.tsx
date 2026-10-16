import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, LogOut, Trash2, UserPlus } from "lucide-react";

import { UserPicker, type UserPickerValue } from "@/components/shared/UserPicker";
import {
  useCreateWorkspaceShare,
  useDeleteWorkspaceShare,
  useUpdateWorkspaceShare,
  useWorkspaceShares,
} from "@/hooks/useWorkspaces";
import { useAuthStore } from "@/store/authStore";
import { confirm } from "@/components/shared/ConfirmDialog";
import type {
  WorkspaceParticipant,
  WorkspaceShareRole,
} from "@/api/workspaces";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";
import { UserAvatar } from "@/components/shared/UserAvatar";

/**
 * Members + sharing UI, shared by the owner's quick "Share" dialog and the
 * Settings → Members tab.
 *
 *  - Owner + admins get the full manager: invite by username/email with a
 *    role, plus the live share list (pending/accepted) with revoke. Data
 *    comes from the owner/admin-only ``/shares`` endpoint.
 *  - Everyone else gets a read-only roster built from the workspace detail's
 *    ``owner`` + ``collaborators`` (which every member already receives), so
 *    no extra grant is needed.
 */
export function WorkspaceMembersPanel({
  workspaceId,
  canManage,
  owner,
  collaborators,
  myShareId = null,
}: {
  workspaceId: string;
  canManage: boolean;
  owner: WorkspaceParticipant | null;
  collaborators: WorkspaceParticipant[];
  /** The caller's own share (null for the owner) — enables "Leave". */
  myShareId?: string | null;
}) {
  if (canManage) return <OwnerShareManager workspaceId={workspaceId} />;
  return (
    <ReadOnlyRoster
      workspaceId={workspaceId}
      owner={owner}
      collaborators={collaborators}
      myShareId={myShareId}
    />
  );
}

const ROLE_LABEL: Record<WorkspaceShareRole, string> = {
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

/** Leave a workspace you were invited to — confirm, revoke your own share,
 *  then back to the workspace list (R-180). */
function useLeaveWorkspace(workspaceId: string) {
  const remove = useDeleteWorkspaceShare(workspaceId);
  const navigate = useNavigate();
  return {
    pending: remove.isPending,
    leave: async (shareId: string) => {
      const ok = await confirm({
        title: "Leave this workspace?",
        message:
          "You'll lose access to everything in it. Files you pinned here are " +
          "unpinned (they stay in your Drive). To come back, someone has to " +
          "invite you again.",
        confirmLabel: "Leave",
        danger: true,
      });
      if (!ok) return;
      await remove.mutateAsync(shareId);
      navigate("/workspaces");
    },
  };
}

// ---------------------------------------------------------------------
// Owner: invite + manage
// ---------------------------------------------------------------------
function OwnerShareManager({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, isError } = useWorkspaceShares(workspaceId);
  const create = useCreateWorkspaceShare(workspaceId);
  const remove = useDeleteWorkspaceShare(workspaceId);
  const updateRole = useUpdateWorkspaceShare(workspaceId);
  const me = useAuthStore((s) => s.user?.id ?? null);
  const { leave, pending: leaving } = useLeaveWorkspace(workspaceId);

  const [picked, setPicked] = useState<UserPickerValue>(null);
  const [role, setRole] = useState<WorkspaceShareRole>("editor");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const excludeUserIds = useMemo(
    () => (data ?? []).map((row) => row.invitee.user_id),
    [data]
  );

  const send = async () => {
    setErrorMsg(null);
    if (!picked) return;
    const base =
      picked.kind === "user"
        ? { username: picked.user.username }
        : picked.email.includes("@")
          ? { email: picked.email }
          : { username: picked.email };
    try {
      await create.mutateAsync({ ...base, role });
      setPicked(null);
    } catch (err: unknown) {
      setErrorMsg(apiErrorMessage(err, "Couldn't send the invite. Try again."));
    }
  };

  return (
    <div>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Invite a teammate to the workspace — its notes, boards, sheets, files
        and instructions, plus any chats people share with it. Chats and
        drafts stay private to whoever made them until they share them.{" "}
        <span className="font-medium text-[var(--text)]">Admins</span>{" "}
        also manage settings and members;{" "}
        <span className="font-medium text-[var(--text)]">Editors</span> create
        and edit content;{" "}
        <span className="font-medium text-[var(--text)]">Viewers</span> can read
        only.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-start gap-2"
      >
        <div className="min-w-0 flex-1">
          <UserPicker
            value={picked}
            onChange={setPicked}
            excludeUserIds={excludeUserIds}
            placeholder="Search by username or email…"
            onSubmit={() => void send()}
            disabled={create.isPending}
          />
        </div>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as WorkspaceShareRole)}
          disabled={create.isPending}
          title="Permission level"
          className="rounded-input border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        >
          <option value="admin">Admin</option>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button
          type="submit"
          disabled={!picked || create.isPending}
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
        <div className="mt-2 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]">
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
          <div className="text-xs text-[var(--danger)]">
            Couldn't load existing shares. Try again in a moment.
          </div>
        ) : (data ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--text-muted)]">
            Just you so far. Invite a teammate above to start collaborating.
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
                {/* Change a role in place — remove + re-invite used to cost
                    them their pinned files and reset them to pending (R-180). */}
                <select
                  value={row.role}
                  aria-label={`Role for ${row.invitee.username}`}
                  disabled={updateRole.isPending}
                  onChange={(e) => {
                    setErrorMsg(null);
                    updateRole
                      .mutateAsync({
                        shareId: row.id,
                        role: e.target.value as WorkspaceShareRole,
                      })
                      .catch((err: unknown) =>
                        setErrorMsg(apiErrorMessage(err, "Couldn't change the role."))
                      );
                  }}
                  className="shrink-0 rounded-input border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                >
                  {(["admin", "editor", "viewer"] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <StatusPill status={row.status} />
                {row.invitee.user_id === me ? (
                  <button
                    type="button"
                    onClick={() => void leave(row.id)}
                    className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
                    title="Leave workspace"
                    aria-label="Leave workspace"
                    disabled={leaving}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      if (row.status === "accepted") {
                        const ok = await confirm({
                          title: `Remove ${row.invitee.username}?`,
                          message:
                            "They lose access straight away. Files they pinned " +
                            "here are unpinned and drop out of the workspace's " +
                            "AI context (the files stay in their Drive). Their " +
                            "notes, cards and shared chats stay.",
                          confirmLabel: "Remove",
                          danger: true,
                        });
                        if (!ok) return;
                      }
                      remove.mutate(row.id);
                    }}
                    className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
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
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Collaborator: read-only roster
// ---------------------------------------------------------------------
function ReadOnlyRoster({
  workspaceId,
  owner,
  collaborators,
  myShareId,
}: {
  workspaceId: string;
  owner: WorkspaceParticipant | null;
  collaborators: WorkspaceParticipant[];
  myShareId: string | null;
}) {
  const { leave, pending: leaving } = useLeaveWorkspace(workspaceId);
  const rows: Array<{ person: WorkspaceParticipant; role: string }> = [];
  if (owner) rows.push({ person: owner, role: "Owner" });
  for (const c of collaborators) {
    if (owner && c.user_id === owner.user_id) continue;
    rows.push({ person: c, role: c.role ? ROLE_LABEL[c.role] : "Member" });
  }

  return (
    <div>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Everyone with access to this workspace. The owner and admins invite and
        remove people.
      </p>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--text-muted)]">
          No members to show.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {rows.map(({ person, role }) => (
            <li
              key={person.user_id}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <UserAvatar
                name={person.username}
                userId={person.user_id}
                avatarUrl={person.avatar_url}
                color={person.avatar_color}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[var(--text)]">
                  {person.username}
                </div>
                <div className="truncate text-xs text-[var(--text-muted)]">
                  {person.email}
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                  role === "Owner"
                    ? "bg-[var(--accent)]/15 text-[var(--accent-text)]"
                    : "bg-[var(--border)]/40 text-[var(--text-muted)]"
                )}
              >
                {role}
              </span>
            </li>
          ))}
        </ul>
      )}
      {myShareId && (
        <button
          type="button"
          onClick={() => void leave(myShareId)}
          disabled={leaving}
          className="mt-4 inline-flex items-center gap-1.5 rounded-input border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--danger)] transition hover:bg-[var(--danger-bg)] disabled:opacity-50"
        >
          <LogOut className="h-3.5 w-3.5" />
          Leave workspace
        </button>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: "pending" | "accepted" | "declined" }) {
  const map: Record<typeof status, { label: string; cls: string }> = {
    pending: {
      label: "Pending",
      cls: "bg-[var(--warning-bg)] text-[var(--warning)]",
    },
    accepted: {
      label: "Active",
      cls: "bg-[var(--success-bg)] text-[var(--success)]",
    },
    declined: {
      label: "Declined",
      cls: "bg-[var(--surface-2)] text-[var(--text-muted)]",
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
