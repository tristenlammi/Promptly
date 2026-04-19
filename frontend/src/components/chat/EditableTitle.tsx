import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { useUpdateConversation } from "@/hooks/useConversations";
import { cn } from "@/utils/cn";

interface EditableTitleProps {
  conversationId: string;
  /** Current title as known by the page. May be null/empty for fresh chats
   *  that haven't finished their first stream; we render a placeholder. */
  title: string | null | undefined;
  placeholder?: string;
  /** Extra classes applied to BOTH the display button and the <input>, so
   *  they stay visually pinned to the same typographic slot. */
  className?: string;
}

const MAX_TITLE_LENGTH = 255;

/**
 * Single-click-to-rename chat title.
 *
 * Design:
 *  - Idle state is a button styled to look like plain text; hover adds a
 *    subtle highlight + text cursor to hint at interactivity.
 *  - Click swaps in a bare <input> that matches the same size/weight so
 *    there's no visual jump.
 *  - Enter or blur commits; Escape reverts.
 *  - Save is optimistic — we update the store immediately and roll back if
 *    the PATCH errors.
 */
export function EditableTitle({
  conversationId,
  title,
  placeholder = "New chat",
  className,
}: EditableTitleProps) {
  const update = useUpdateConversation();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync with incoming title changes (e.g. server-side
  // auto-title arriving via SSE while the user is just looking at the page).
  useEffect(() => {
    if (!editing) setDraft(title ?? "");
  }, [title, editing]);

  // Autofocus + select all when entering edit mode.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const begin = () => {
    setDraft(title?.trim() || "");
    setEditing(true);
  };

  const cancel = () => {
    setDraft(title ?? "");
    setEditing(false);
  };

  const commit = () => {
    const next = draft.trim().slice(0, MAX_TITLE_LENGTH);
    const prev = (title ?? "").trim();
    setEditing(false);

    // Empty input = revert to current title rather than wipe it out.
    if (!next) {
      setDraft(prev);
      return;
    }
    if (next === prev) return;

    update.mutate(
      { id: conversationId, payload: { title: next } },
      {
        onError: () => {
          // Roll the local draft back to the server's version.
          setDraft(prev);
        },
      }
    );
  };

  const displayTitle = (title?.trim() || placeholder);
  const isSaving = update.isPending;

  if (editing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
          maxLength={MAX_TITLE_LENGTH}
          aria-label="Chat title"
          className={cn(
            "min-w-0 flex-1 rounded-md border bg-[var(--surface)] px-2 py-0.5",
            "text-sm font-semibold tracking-tight text-[var(--text)]",
            "border-[var(--accent)]/60 outline-none",
            "focus:border-[var(--accent)]",
            className
          )}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={begin}
      disabled={isSaving}
      title="Click to rename"
      className={cn(
        "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 -ml-2",
        "text-sm font-semibold tracking-tight text-[var(--text)]",
        "transition hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
        "disabled:cursor-wait disabled:opacity-70",
        className
      )}
    >
      <span className="truncate">{displayTitle}</span>
      {isSaving && (
        <Loader2
          className="h-3 w-3 shrink-0 animate-spin text-[var(--text-muted)]"
          aria-hidden
        />
      )}
    </button>
  );
}
