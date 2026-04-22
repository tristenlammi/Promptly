import { useMemo, useState } from "react";
import { ChevronRight, FileText, Folder, Search, X } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import { Button } from "@/components/shared/Button";
import { useBrowseFiles } from "@/hooks/useFiles";
import type { FileItem } from "@/api/files";

/**
 * Lightweight picker for selecting files from "My Files" to attach
 * to a Custom Model's knowledge library.
 *
 * Keeps the UX small — breadcrumb navigation, folder click-through,
 * per-file checkboxes. ``excludeIds`` hides files already attached so
 * the admin doesn't have to mentally diff two lists.
 */
export interface MyFilesPickerProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (fileIds: string[]) => void;
  /** File ids to hide (already attached to the current custom model). */
  excludeIds?: Set<string>;
}

export function MyFilesPicker({
  open,
  onClose,
  onConfirm,
  excludeIds,
}: MyFilesPickerProps) {
  // Folder navigation state. ``null`` => root of "mine" scope.
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, FileItem>>(new Map());
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useBrowseFiles("mine", folderId);

  const visibleFiles = useMemo(() => {
    if (!data?.files) return [];
    const q = filter.trim().toLowerCase();
    return data.files.filter((f) => {
      if (excludeIds?.has(f.id)) return false;
      if (!q) return true;
      return f.filename.toLowerCase().includes(q);
    });
  }, [data?.files, filter, excludeIds]);

  const toggle = (f: FileItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(f.id)) next.delete(f.id);
      else next.set(f.id, f);
      return next;
    });
  };

  const handleClose = () => {
    setSelected(new Map());
    setFilter("");
    setFolderId(null);
    onClose();
  };

  const handleConfirm = () => {
    onConfirm([...selected.keys()]);
    handleClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add files to knowledge library"
      description="Pick files from your personal library. Folders can be opened to drill in; each file you check will be chunked and embedded."
      widthClass="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size === 0}
            onClick={handleConfirm}
          >
            Add {selected.size > 0 ? `${selected.size} file${selected.size > 1 ? "s" : ""}` : "files"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <button
            type="button"
            onClick={() => setFolderId(null)}
            className="hover:text-[var(--text)]"
          >
            My Files
          </button>
          {data?.breadcrumbs.map((b) => (
            <span key={b.id ?? "root"} className="flex items-center gap-2">
              <ChevronRight className="h-3 w-3" />
              <button
                type="button"
                onClick={() => setFolderId(b.id)}
                className="hover:text-[var(--text)]"
              >
                {b.name}
              </button>
            </span>
          ))}
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[var(--text-muted)]"
            aria-hidden
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files in this folder..."
            className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] py-1.5 pl-8 pr-3 text-sm outline-none focus:border-[var(--accent)]/60"
          />
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[...selected.values()].map((f) => (
              <span
                key={f.id}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs text-[var(--accent)]"
              >
                {f.filename}
                <button
                  type="button"
                  aria-label={`Remove ${f.filename}`}
                  onClick={() => toggle(f)}
                  className="rounded-full hover:bg-[var(--accent)]/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="max-h-[40vh] overflow-y-auto rounded-card border border-[var(--border)]">
          {isLoading && (
            <div className="px-3 py-4 text-xs text-[var(--text-muted)]">
              Loading...
            </div>
          )}

          {!isLoading && data?.folders.length === 0 && visibleFiles.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              Nothing here yet.
            </div>
          )}

          {data?.folders.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setFolderId(d.id)}
              className="flex w-full items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-left text-sm hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Folder className="h-4 w-4 text-[var(--text-muted)]" />
              <span className="flex-1 truncate">{d.name}</span>
              <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            </button>
          ))}

          {visibleFiles.map((f) => {
            const checked = selected.has(f.id);
            return (
              <label
                key={f.id}
                className="flex w-full cursor-pointer items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-left text-sm hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(f)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                <FileText className="h-4 w-4 text-[var(--text-muted)]" />
                <span className="flex-1 truncate">{f.filename}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {formatBytes(f.size_bytes)}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
