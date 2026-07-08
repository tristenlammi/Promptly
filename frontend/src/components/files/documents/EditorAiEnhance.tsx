import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import DOMPurify from "dompurify";
import { Check, Loader2, Sparkles, X } from "lucide-react";

import { chatApi } from "@/api/chat";
import { useModelStore } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * "Enhance" the current selection with AI. Rather than silently overwriting,
 * it PROPOSES a rewrite in a small panel at the bottom of the editor which the
 * user accepts or discards (mirrors the composer's enhance flow). The selection
 * is sent as an HTML fragment so the model preserves structure — a heading +
 * paragraph selection comes back as a heading + paragraph, not one big heading.
 *
 * Anchored bottom-right (button) / bottom-centre (panel). The outer wrapper is
 * ALWAYS mounted (only its contents toggle) so it never triggers the
 * "insertBefore … not a child" React error next to the Tiptap DragHandle.
 */
interface Proposal {
  from: number;
  to: number;
  html: string;
}

/** Serialize the current selection to an HTML string (structure preserved). */
function selectionHtml(editor: Editor): string {
  const { from, to } = editor.state.selection;
  const slice = editor.state.doc.slice(from, to);
  const frag = DOMSerializer.fromSchema(editor.schema).serializeFragment(
    slice.content
  );
  const div = document.createElement("div");
  div.appendChild(frag);
  return div.innerHTML;
}

export function EditorAiEnhance({ editor }: { editor: Editor }) {
  const providerId = useModelStore((s) => s.selectedProviderId);
  const modelId = useModelStore((s) => s.selectedModelId);
  const [busy, setBusy] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  useEffect(() => {
    const update = () => setHasSelection(!editor.state.selection.empty);
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    update();
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  const run = async () => {
    if (busy) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const plain = editor.state.doc.textBetween(from, to, "\n").trim();
    if (!plain) return;
    if (!providerId || !modelId) {
      toast.error("Pick a model first (in a chat) to use AI enhance.");
      return;
    }
    const html = selectionHtml(editor);
    setBusy(true);
    try {
      const improved = (
        await chatApi.enhancePrompt(html, providerId, modelId, "prose")
      ).trim();
      if (!improved) {
        toast.info("Nothing to improve — it already reads well.");
        return;
      }
      setProposal({ from, to, html: improved });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't enhance the selection."));
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (!proposal) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: proposal.from, to: proposal.to }, proposal.html)
      .run();
    setProposal(null);
  };

  const showButton = (hasSelection || busy) && !proposal;

  return (
    // Always-mounted, zero-box wrapper — see the note above.
    <div>
      <div className="absolute bottom-9 right-6 z-20 print:hidden">
        {showButton && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={run}
            disabled={busy}
            title="Rewrite the selection with AI (clearer, tighter)"
            className={cn(
              "ai-enhance-ring inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)] px-3 py-1.5",
              "text-xs font-medium text-[var(--text)] shadow-lg transition disabled:opacity-80"
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
            )}
            {busy ? "Enhancing…" : "Enhance"}
          </button>
        )}
      </div>

      {proposal && (
        <div className="absolute bottom-3 left-1/2 z-30 w-[min(40rem,92%)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--accent)]/40 bg-[var(--surface)] shadow-2xl print:hidden">
          <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--accent)]">
            <Sparkles className="h-3.5 w-3.5" />
            Proposed rewrite
            <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">
              Replaces your selection
            </span>
          </div>
          <div
            className="promptly-doc max-h-60 overflow-y-auto px-4 py-3 text-sm"
            // Sanitized model output — rendered read-only for preview.
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(proposal.html),
            }}
          />
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
            <button
              type="button"
              onClick={() => setProposal(null)}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <X className="h-3.5 w-3.5" />
              Discard
            </button>
            <button
              type="button"
              onClick={accept}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90"
            >
              <Check className="h-3.5 w-3.5" />
              Replace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
