import { useRef, useState } from "react";
import {
  Briefcase,
  FileText,
  FileUp,
  Handshake,
  Loader2,
  Rocket,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { workspacesApi } from "@/api/workspaces";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { WorkspaceModelField } from "@/components/workspaces/WorkspaceModelField";
import { useCreateWorkspace } from "@/hooks/useWorkspaces";
import { cn } from "@/utils/cn";

/** Starter templates (4.6) — mirrors backend/app/workspaces/templates.py.
 *  Kept as a static list client-side: templates are content, and the
 *  backend silently ignores unknown keys, so drift degrades to Blank. */
const TEMPLATES = [
  {
    key: null,
    name: "Blank",
    description: "Start from scratch.",
    icon: FileText,
  },
  {
    key: "legal_matter",
    name: "Legal matter",
    description: "Matter overview, client intake, deadlines board.",
    icon: Briefcase,
  },
  {
    key: "engineering_sprint",
    name: "Engineering sprint",
    description: "Sprint goals, runbook, labelled sprint board.",
    icon: Rocket,
  },
  {
    key: "client_onboarding",
    name: "Client onboarding",
    description: "Checklist, welcome pack, pipeline board.",
    icon: Handshake,
  },
] as const;

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
  const [template, setTemplate] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const create = useCreateWorkspace();

  // Markdown-zip import (Obsidian vault / Notion export) — an alternate
  // door out of this modal: pick a zip, land in the new workspace.
  const handleImportFile = async (zip: File | null | undefined) => {
    if (!zip || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await workspacesApi.importZip(
        zip,
        title.trim() || undefined
      );
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      reset();
      onCreated?.(result.id);
      onClose();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })
        .response?.data?.detail;
      setImportError(detail || "Import failed — is it a zip of .md files?");
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setTitle("");
    setDescription("");
    setSystemPrompt("");
    setModelId(null);
    setProviderId(null);
    setTemplate(null);
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
      template,
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
            Start from
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {TEMPLATES.map((t) => {
              const Icon = t.icon;
              const selected = template === t.key;
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setTemplate(t.key)}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition",
                    selected
                      ? "border-[var(--accent)] bg-[var(--accent)]/5"
                      : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]"
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      selected
                        ? "text-[var(--accent)]"
                        : "text-[var(--text-muted)]"
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-[var(--text)]">
                      {t.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">
                      {t.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

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
          <div className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]">
            Couldn't create the workspace. Please try again.
          </div>
        )}

        <div className="border-t border-[var(--border)] pt-3">
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="flex w-full items-center gap-2 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-left text-xs text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-60"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <FileUp className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              <span className="font-medium">
                {importing
                  ? "Importing notes…"
                  : "Or import from a Markdown export (.zip)"}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug">
                Obsidian vaults and Notion / Confluence Markdown exports —
                folders become folders, .md files become notes.
              </span>
            </span>
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              void handleImportFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {importError && (
            <p className="mt-1.5 text-xs text-[var(--danger)]">{importError}</p>
          )}
        </div>
      </form>
    </Modal>
  );
}
