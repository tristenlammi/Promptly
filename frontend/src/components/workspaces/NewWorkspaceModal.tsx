import { useMemo, useRef, useState } from "react";
import {
  Briefcase,
  FileText,
  FileUp,
  GraduationCap,
  Hammer,
  Handshake,
  Home,
  LayoutTemplate,
  Loader2,
  Plane,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { workspacesApi } from "@/api/workspaces";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { WorkspaceModelField } from "@/components/workspaces/WorkspaceModelField";
import { useCreateWorkspace } from "@/hooks/useWorkspaces";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";

/** Starter templates come from the server (``GET /workspaces/templates``):
 *  the built-in ones plus any workspace saved as a template. The list used
 *  to be duplicated here (R-204). Icons are presentation, so they stay. */
const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  legal_matter: Briefcase,
  engineering_sprint: Rocket,
  client_onboarding: Handshake,
  household: Home,
  trip: Plane,
  renovation: Hammer,
  school: GraduationCap,
};
const GROUP_ORDER = ["Home & family", "Work", "Your templates"];
const BLANK = {
  key: null as string | null,
  name: "Blank",
  description: "Start from scratch.",
  group: "",
};

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
  const { data: catalog } = useQuery({
    queryKey: ["workspaces", "templates"],
    queryFn: () => workspacesApi.templates(),
    enabled: open,
    staleTime: 60_000,
  });
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof BLANK[]>();
    for (const t of catalog ?? []) {
      const g = t.group || "Work";
      byGroup.set(g, [...(byGroup.get(g) ?? []), { ...t, key: t.key as string | null }]);
    }
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i === -1 ? GROUP_ORDER.length : i;
    };
    return [...byGroup.entries()].sort(([a], [b]) => rank(a) - rank(b));
  }, [catalog]);

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
      // The modal closes on success, so the import summary — including
      // what was left out and why — goes in a toast (R-315).
      const imported = `${result.notes} note${result.notes === 1 ? "" : "s"}${
        result.notebooks
          ? ` in ${result.notebooks} notebook${result.notebooks === 1 ? "" : "s"}`
          : ""
      }`;
      const skippedLines = Object.entries(result.skipped ?? {}).map(
        ([reason, count]) => `${count} × ${reason}`
      );
      if (skippedLines.length) {
        toast.warning(`Skipped ${result.skipped_total}: ${skippedLines.join(" · ")}`, {
          title: `Imported ${imported}`,
          duration: 15_000,
        });
      } else {
        toast.success(`Imported ${imported}.`);
      }
      reset();
      onCreated?.(result.id);
      onClose();
    } catch (e) {
      setImportError(
        apiErrorMessage(e, "Import failed — is it a zip of .md files?")
      );
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
          <div className="max-h-72 space-y-2 overflow-y-auto pr-0.5">
          {[["", [BLANK]] as const, ...groups].map(([group, list]) => (
          <div key={group || "blank"}>
          {group && (
            <div className="mb-1 mt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {group}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            {list.map((t) => {
              const Icon =
                t.key === null
                  ? FileText
                  : TEMPLATE_ICONS[t.key] ??
                    (t.key.startsWith("ws:") ? LayoutTemplate : FileText);
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
                        ? "text-[var(--accent-text)]"
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
          ))}
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
                .md files become notes, top-level folders become notebooks
                (deeper folders stay in the note title). Images and other
                files are skipped.
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
