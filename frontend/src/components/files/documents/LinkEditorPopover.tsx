import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Check, Trash2 } from "lucide-react";

import { cn } from "@/utils/cn";

/**
 * In-app link editor — replaces the browser ``window.prompt`` for adding /
 * editing a link. A small floating input anchored to the triggering button.
 *
 * Handles the two cases ``setLink`` alone can't:
 *   · **text selected** → apply the link mark to the selection.
 *   · **no selection** → insert the URL itself as linked text (so a link
 *     actually appears rather than a mark with nothing to attach to — the
 *     "it didn't add anything" bug).
 *
 * The ProseMirror selection survives the input taking DOM focus, but we
 * snapshot the range on open and re-select it on apply to be safe.
 */
function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^(https?:|mailto:|tel:)/i.test(t)) return t;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
  return `https://${t}`;
}

export function LinkEditorPopover({
  editor,
  anchor,
  onClose,
}: {
  editor: Editor;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const rangeRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string>(
    (editor.getAttributes("link").href as string | undefined) ?? ""
  );

  useEffect(() => {
    const { from, to } = editor.state.selection;
    rangeRef.current = { from, to };
    // Focus after mount so typing lands in the field, not the editor.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [editor]);

  const hasExistingLink = editor.isActive("link");

  const apply = () => {
    const href = normalizeUrl(url);
    const { from, to } = rangeRef.current;
    if (!href) {
      remove();
      return;
    }
    if (from === to) {
      // No selection — drop the URL in as linked text.
      editor
        .chain()
        .focus()
        .insertContentAt(from, [
          { type: "text", text: url.trim(), marks: [{ type: "link", attrs: { href } }] },
          { type: "text", text: " " },
        ])
        .unsetMark("link")
        .run();
    } else {
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .extendMarkRange("link")
        .setLink({ href })
        .run();
    }
    onClose();
  };

  const remove = () => {
    const { from, to } = rangeRef.current;
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .extendMarkRange("link")
      .unsetLink()
      .run();
    onClose();
  };

  const WIDTH = 320;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 60);

  return createPortal(
    <>
      {/* Click-away catcher. */}
      <div className="fixed inset-0 z-[75]" onMouseDown={onClose} />
      <div
        style={{ position: "fixed", top, left, width: WIDTH, zIndex: 76 }}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Paste or type a link…"
          className="min-w-0 flex-1 rounded-md bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <button
          type="button"
          title="Apply link"
          aria-label="Apply link"
          onClick={apply}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)] text-white transition hover:opacity-90"
        >
          <Check className="h-4 w-4" />
        </button>
        {hasExistingLink && (
          <button
            type="button"
            title="Remove link"
            aria-label="Remove link"
            onClick={remove}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md",
              "text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--danger)]"
            )}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </>,
    document.body
  );
}
