import { useState } from "react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { WorkspaceModelField } from "@/components/workspaces/WorkspaceModelField";
import { useCreateWorkspace } from "@/hooks/useWorkspaces";

interface NewWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (workspaceId: string) => void;
}

/** New-workspace wizard. Title is the only requirement; description,
 * instructions, and a default model are optional up front so a workspace
 * can be useful the moment it's created — but everything is also
 * editable later on the detail page's Settings tab. Pinned files still
 * live on the detail page (they need an upload/picker flow). */
export function NewWorkspaceModal({
  open,
  onClose,
  onCreated,
}: NewWorkspaceModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const create = useCreateWorkspace();

  const reset = () => {
    setTitle("");
    setDescription("");
    setSystemPrompt("");
    setModelId(null);
    setProviderId(null);
  };

  const handleClose = () => {
    if (create.isPending) return;
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    const ws = await create.mutateAsync({
      title: trimmed,
      description: description.trim() || null,
      system_prompt: systemPrompt.trim() || null,
      default_model_id: modelId,
      default_provider_id: providerId,
    });
    reset();
    onCreated?.(ws.id);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New workspace"
      description="Workspaces bundle a shared system prompt, pinned files, and a group of conversations."
      widthClass="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit as unknown as () => void}
            disabled={!title.trim() || create.isPending}
          >
            {create.isPending ? "Creating..." : "Create workspace"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="e.g. Home renovation, Book draft, Client XYZ"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            maxLength={255}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Description{" "}
            <span className="text-[var(--text-muted)]/70">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What kind of work happens in this workspace?"
            className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            maxLength={2000}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Instructions{" "}
            <span className="text-[var(--text-muted)]/70">(optional)</span>
          </label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            placeholder="Durable facts + preferences shared across every chat in this workspace. You can refine this later."
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            maxLength={20000}
          />
        </div>

        <WorkspaceModelField
          modelId={modelId}
          providerId={providerId}
          onChange={(m, p) => {
            setModelId(m);
            setProviderId(p);
          }}
        />

        {create.isError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            Couldn't create the workspace. Please try again.
          </div>
        )}
      </form>
    </Modal>
  );
}
