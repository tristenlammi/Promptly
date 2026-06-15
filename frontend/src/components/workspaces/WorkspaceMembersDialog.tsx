import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";
import type { WorkspaceParticipant } from "@/api/workspaces";

/**
 * Read-only "who's in this workspace" view for collaborators.
 *
 * The owner manages access through the full ``ShareWorkspaceDialog`` (which
 * hits the owner-only shares endpoint). Collaborators can't load that, but
 * the workspace *detail* response already carries ``owner`` + ``collaborators``
 * for everyone — so this dialog renders that list without any extra grant.
 * No invite/remove controls; it's purely informational.
 */
export function WorkspaceMembersDialog({
  open,
  onClose,
  workspaceTitle,
  owner,
  collaborators,
}: {
  open: boolean;
  onClose: () => void;
  workspaceTitle: string;
  owner: WorkspaceParticipant | null;
  collaborators: WorkspaceParticipant[];
}) {
  const rows: Array<{ person: WorkspaceParticipant; role: "Owner" | "Member" }> =
    [];
  if (owner) rows.push({ person: owner, role: "Owner" });
  for (const c of collaborators) {
    // The owner can also appear in collaborators on some payloads — don't
    // list them twice.
    if (owner && c.user_id === owner.user_id) continue;
    rows.push({ person: c, role: "Member" });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Members of "${workspaceTitle}"`}
      description="Everyone with access to this workspace. Only the owner can invite or remove people."
      widthClass="max-w-md"
    >
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
                    ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                    : "bg-[var(--border)]/40 text-[var(--text-muted)]"
                )}
              >
                {role}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
