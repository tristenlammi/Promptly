import { useEffect, useRef, useState } from "react";
import { FileText, FolderCog, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { chatApi } from "@/api/chat";
import { cn } from "@/utils/cn";

interface ProjectFilesToggleProps {
  conversationId: string;
  /** Icon-only on mobile, matching the other header action buttons. */
  compact?: boolean;
}

/** Header control (only meaningful inside a project) that lets the
 *  chat's owner pick which of the project's pinned files *this*
 *  conversation sees. Excluding a file drops it from both the full-dump
 *  attachment set and the retrieval candidates for this chat only —
 *  siblings are unaffected. Renders nothing when the project has no
 *  pinned files. */
export function ProjectFilesToggle({
  conversationId,
  compact = false,
}: ProjectFilesToggleProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const key = ["conversation-project-files", conversationId];
  const { data: files } = useQuery({
    queryKey: key,
    queryFn: () => chatApi.listConversationProjectFiles(conversationId),
  });

  const toggle = useMutation({
    mutationFn: ({ fileId, excluded }: { fileId: string; excluded: boolean }) =>
      chatApi.toggleConversationProjectFile(conversationId, fileId, excluded),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing pinned → no control. (Empty array means "in a project but no
  // files"; undefined while loading.)
  if (!files || files.length === 0) return null;

  const activeCount = files.filter((f) => !f.excluded).length;
  const label = "Project files in this chat";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)]",
          compact ? "h-9 w-9 justify-center" : "px-2.5 py-1.5 text-xs"
        )}
      >
        <FolderCog className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!compact && (
          <>
            Files
            <span className="rounded-full bg-[var(--border)]/40 px-1.5 text-[10px]">
              {activeCount}/{files.length}
            </span>
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg"
        >
          <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
            Choose which of the project's pinned files this chat can see.
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {files.map((f) => (
              <li key={f.file_id}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs transition hover:bg-[var(--accent)]/5">
                  <input
                    type="checkbox"
                    checked={!f.excluded}
                    onChange={(e) =>
                      toggle.mutate({
                        fileId: f.file_id,
                        excluded: !e.target.checked,
                      })
                    }
                    disabled={toggle.isPending}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                    {f.filename}
                  </span>
                  {toggle.isPending && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--text-muted)]" />
                  )}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
