import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import { Button } from "@/components/shared/Button";
import { WorkspaceModelField } from "@/components/workspaces/WorkspaceModelField";
import { useCreateFolder, useUpdateFolder } from "@/hooks/useChatFolders";
import type { ChatFolder } from "@/api/folders";
import { cn } from "@/utils/cn";

interface FolderEditModalProps {
  open: boolean;
  onClose: () => void;
  /** Existing folder to edit, or ``null`` to create a new one. */
  folder?: ChatFolder | null;
  /** Called with the saved folder (create returns the new row). */
  onSaved?: (folder: ChatFolder) => void;
}

/**
 * Create / edit a chat folder (0148). One dialog for both:
 *   * name (required)
 *   * default model — pre-selected for new chats created in the folder
 *   * instructions — a live system prompt applied to every chat inside
 *
 * The model + prompt are the folder's inheritable "context": the prompt
 * applies to existing chats too (live), the model is a default for new ones.
 */
export function FolderEditModal({
  open,
  onClose,
  folder = null,
  onSaved,
}: FolderEditModalProps) {
  const isEdit = !!folder;
  const create = useCreateFolder();
  const update = useUpdateFolder();
  const busy = create.isPending || update.isPending;

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form whenever the target folder (or open state) changes.
  useEffect(() => {
    if (!open) return;
    setName(folder?.name ?? "");
    setPrompt(folder?.system_prompt ?? "");
    setModelId(folder?.default_model_id ?? null);
    setProviderId(folder?.default_provider_id ?? null);
    setError(null);
  }, [open, folder]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the folder a name.");
      return;
    }
    setError(null);
    const payload = {
      name: trimmed,
      system_prompt: prompt.trim() || null,
      default_model_id: modelId,
      default_provider_id: providerId,
    };
    try {
      const saved = isEdit
        ? await update.mutateAsync({ id: folder!.id, patch: payload })
        : await create.mutateAsync(payload);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={isEdit ? "Edit folder" : "New folder"}
      description="Chats in a folder share its instructions and start with its model."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={busy || !name.trim()}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEdit ? "Save" : "Create folder"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            maxLength={120}
            placeholder="e.g. Rust helper"
            className={cn(
              "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm",
              "text-[var(--text)] placeholder:text-[var(--text-muted)]",
              "focus:border-[var(--accent)] focus:outline-none"
            )}
          />
        </div>

        <WorkspaceModelField
          modelId={modelId}
          providerId={providerId}
          onChange={(m, p) => {
            setModelId(m);
            setProviderId(p);
          }}
          label="Default model"
          labelHint="(new chats in this folder start here)"
          clearLabel="No default — use my current model"
        />

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Instructions{" "}
            <span className="text-[var(--text-muted)]/70">
              (applied to every chat in this folder)
            </span>
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            maxLength={8000}
            placeholder="e.g. You are a senior Rust engineer. Prefer concise, idiomatic answers."
            className={cn(
              "w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm",
              "text-[var(--text)] placeholder:text-[var(--text-muted)]",
              "focus:border-[var(--accent)] focus:outline-none"
            )}
          />
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Editing this updates every chat in the folder on its next message.
            A chat's own instructions still take precedence.
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
