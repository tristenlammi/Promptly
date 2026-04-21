import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderKanban, FolderMinus, FolderPlus, Loader2 } from "lucide-react";

import { chatApi } from "@/api/chat";
import { useChatProjects } from "@/hooks/useChatProjects";
import { cn } from "@/utils/cn";

interface MoveToProjectMenuProps {
  conversationId: string;
  currentProjectId: string | null | undefined;
  compact?: boolean;
  onMoved?: (newProjectId: string | null) => void;
}

/** Small dropdown on the chat TopNav that lets the user drop this
 * conversation into one of their active projects — or detach it from
 * the project it's currently in. Intentionally a thin menu (no
 * search, no create-project inline) to keep the header compact; the
 * projects page is where heavier organisation happens.
 */
export function MoveToProjectMenu({
  conversationId,
  currentProjectId,
  compact = false,
  onMoved,
}: MoveToProjectMenuProps) {
  const { data: projects, isLoading } = useChatProjects({ archived: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  const currentTitle = useMemo(() => {
    if (!currentProjectId || !projects) return null;
    return projects.find((p) => p.id === currentProjectId)?.title ?? null;
  }, [currentProjectId, projects]);

  const moveTo = async (targetId: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await chatApi.update(conversationId, { project_id: targetId });
      onMoved?.(targetId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          currentProjectId
            ? `In project${currentTitle ? ": " + currentTitle : ""}`
            : "Move to project"
        }
        aria-label="Move to project"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)]",
          compact ? "h-9 w-9 justify-center" : "px-2.5 py-1.5 text-xs"
        )}
      >
        {busy ? (
          <Loader2 className={cn("animate-spin", compact ? "h-4 w-4" : "h-3.5 w-3.5")} />
        ) : (
          <FolderKanban className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
        )}
        {!compact && (currentProjectId ? "Project" : "Add to project")}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg"
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {isLoading && (
              <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
                Loading projects...
              </div>
            )}
            {!isLoading && (!projects || projects.length === 0) && (
              <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
                No projects yet. Create one on the Projects page.
              </div>
            )}
            {projects?.map((p) => {
              const active = p.id === currentProjectId;
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => moveTo(active ? null : p.id)}
                  disabled={busy}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                    "hover:bg-[var(--accent)]/5",
                    active && "text-[var(--accent)]"
                  )}
                >
                  <FolderKanban className="h-3.5 w-3.5" />
                  <span className="flex-1 truncate">{p.title}</span>
                  {active && <Check className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
          {currentProjectId && (
            <div className="border-t border-[var(--border)] py-1">
              <button
                role="menuitem"
                onClick={() => moveTo(null)}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text-muted)] transition hover:bg-[var(--accent)]/5 hover:text-[var(--text)]"
              >
                <FolderMinus className="h-3.5 w-3.5" />
                Remove from project
              </button>
            </div>
          )}
          <div className="border-t border-[var(--border)] py-1">
            <a
              href="/projects"
              className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)] transition hover:bg-[var(--accent)]/5 hover:text-[var(--text)]"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Manage projects...
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
