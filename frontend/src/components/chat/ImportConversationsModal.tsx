import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, FolderKanban, Loader2, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { chatApi, type ImportConversationsResponse } from "@/api/chat";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useChatProjects } from "@/hooks/useChatProjects";
import { cn } from "@/utils/cn";

interface ImportConversationsModalProps {
  open: boolean;
  onClose: () => void;
  /** Prefill the project target (e.g. when launched from a project's
   * detail page). Users can still clear it from the dropdown. */
  defaultProjectId?: string | null;
}

/** Bulk import modal. Accepts a single file (JSON, ZIP, or Markdown)
 * and unpacks 1..N conversations from it. Shows a summary card on
 * success with "N imported, M skipped, K messages" plus per-chat
 * one-line entries so the user can open anything that looks
 * interesting straight away.
 */
export function ImportConversationsModal({
  open,
  onClose,
  defaultProjectId = null,
}: ImportConversationsModalProps) {
  const qc = useQueryClient();
  const { data: projects } = useChatProjects({ archived: false });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportConversationsResponse | null>(
    null
  );
  const [dragActive, setDragActive] = useState(false);

  const reset = () => {
    setFile(null);
    setBusy(false);
    setError(null);
    setResult(null);
    setDragActive(false);
    setProjectId(defaultProjectId);
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await chatApi.importConversations(file, projectId);
      setResult(res);
      // Imported chats need to show up in the sidebar + (if
      // projectised) the project detail page. Invalidate both query
      // trees — the individual queries handle their own refetch.
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["chat-projects"] });
    } catch (e) {
      const msg =
        (e as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ??
        (e as { message?: string })?.message ??
        "Import failed.";
      setError(String(msg));
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import conversations"
      description="Bring chats in from Promptly, ChatGPT, Claude, or a plain Markdown transcript."
      widthClass="max-w-lg"
      footer={
        result ? (
          <Button variant="primary" onClick={handleClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!file || busy}
              leftIcon={
                busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )
              }
            >
              {busy ? "Importing..." : "Import"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ImportSummary result={result} />
      ) : (
        <div className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition",
              dragActive
                ? "border-[var(--accent)] bg-[var(--accent)]/5"
                : "border-[var(--border)] hover:border-[var(--accent)]/60"
            )}
          >
            <FileUp className="h-6 w-6 text-[var(--text-muted)]" />
            {file ? (
              <>
                <div className="text-sm font-medium text-[var(--text)]">
                  {file.name}
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {(file.size / 1024).toFixed(1)} KB · click to change
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-medium text-[var(--text)]">
                  Drop a file here, or click to browse
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  JSON, ZIP, or Markdown · up to 100 MB
                </div>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".json,.zip,.md,.markdown,application/json,application/zip,text/markdown,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
              }}
            />
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              <FolderKanban className="h-3.5 w-3.5" />
              Put imported chats into a project{" "}
              <span className="text-[var(--text-muted)]/70">(optional)</span>
            </label>
            <select
              value={projectId ?? ""}
              onChange={(e) => setProjectId(e.target.value || null)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option value="">None (top-level chats)</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ImportSummary({ result }: { result: ImportConversationsResponse }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">
            {result.imported} conversation
            {result.imported === 1 ? "" : "s"} imported
          </div>
          <div className="text-[11px] opacity-80">
            {result.total_messages} message
            {result.total_messages === 1 ? "" : "s"}
            {result.skipped > 0 ? ` · ${result.skipped} skipped (empty)` : ""}
          </div>
        </div>
      </div>

      {result.conversations.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--border)]">
          <ul className="divide-y divide-[var(--border)]">
            {result.conversations.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between px-3 py-2 text-xs"
              >
                <a
                  href={`/chat/${c.id}`}
                  className="truncate font-medium text-[var(--accent)] hover:underline"
                >
                  {c.title}
                </a>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  {c.source} · {c.message_count} msg
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
