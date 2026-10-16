import { Modal } from "@/components/shared/Modal";
import { WorkspaceMembersPanel } from "@/components/workspaces/WorkspaceMembersPanel";

interface Props {
  open: boolean;
  workspaceId: string;
  workspaceTitle: string;
  onClose: () => void;
}

/** Owner-only quick modal for inviting teammates into a workspace.
 *
 *  Sharing a workspace is a *much bigger grant* than sharing a single
 *  conversation — the invitee gets access to every chat under the
 *  workspace (including the owner's) plus its pinned files, notes,
 *  canvases, and system prompt. The modal description calls this out so
 *  nobody clicks through without understanding what they're opening up.
 *
 *  The invite/manage UI itself lives in :func:`WorkspaceMembersPanel`,
 *  shared with the Settings → Members tab so the two stay in lockstep. */
export function ShareWorkspaceDialog({
  open,
  workspaceId,
  workspaceTitle,
  onClose,
}: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Share "${workspaceTitle}"`}
      description="Inviting a teammate shares the workspace's notes, boards, sheets, canvases, files and instructions. Chats stay private to whoever started them until they share them with the workspace. Whoever sends a message pays for that turn."
      widthClass="max-w-xl"
    >
      <WorkspaceMembersPanel
        workspaceId={workspaceId}
        canManage
        owner={null}
        collaborators={[]}
      />
    </Modal>
  );
}
