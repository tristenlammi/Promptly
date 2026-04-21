import { useState } from "react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useCreateChatProject } from "@/hooks/useChatProjects";

interface NewChatProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (projectId: string) => void;
}

/** New-project wizard. Deliberately thin: title + optional
 * description are the only up-front requirements. The system prompt,
 * pinned files, and default model all live on the detail page's
 * Settings tab — keeping the create flow minimal lets users get a
 * project shell in place before they've worked out what goes in it. */
export function NewChatProjectModal({
  open,
  onClose,
  onCreated,
}: NewChatProjectModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const create = useCreateChatProject();

  const reset = () => {
    setTitle("");
    setDescription("");
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
    const proj = await create.mutateAsync({
      title: trimmed,
      description: description.trim() || null,
    });
    reset();
    onCreated?.(proj.id);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New project"
      description="Projects bundle a shared system prompt, pinned files, and a group of conversations."
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
            {create.isPending ? "Creating..." : "Create project"}
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
            rows={3}
            placeholder="What kind of work happens in this project?"
            className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            maxLength={2000}
          />
        </div>

        {create.isError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            Couldn't create the project. Please try again.
          </div>
        )}
      </form>
    </Modal>
  );
}
