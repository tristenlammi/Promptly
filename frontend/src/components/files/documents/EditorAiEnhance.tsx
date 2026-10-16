import { useEffect, useRef, useState } from "react";
import { filesApi } from "@/api/files";
import type { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import DOMPurify from "dompurify";
import { Check, Loader2, Sparkles, X } from "lucide-react";

import { chatApi } from "@/api/chat";
import { useEditorModel } from "@/lib/editorModel";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";
import {
  afterRangeBlock,
  mapPendingRange,
  rangeUnchanged,
  type PendingRange,
} from "@/lib/pendingRange";

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
  html: string;
  /** The text under the range changed while the proposal waited — only
   *  "Insert below" is safe now (R-222). */
  stale?: boolean;
}

/** What the enhance endpoint accepts (EnhancePromptRequest.text). */
const MAX_ENHANCE_CHARS = 8000;

/** The range to enhance. For an in-block selection it's the selection as-is
 *  (inline). For a selection spanning blocks it snaps to whole-block
 *  boundaries so we send + re-insert complete blocks — otherwise inserting
 *  block content at an inline position splits the block and leaves an empty
 *  one above ("space above" bug). */
function targetRange(editor: Editor): { from: number; to: number } {
  const sel = editor.state.selection;
  const { $from, $to } = sel;
  if ($from.sameParent($to)) return { from: sel.from, to: sel.to };
  const range = $from.blockRange($to);
  return range ? { from: range.start, to: range.end } : { from: sel.from, to: sel.to };
}

/** Serialize a range to an HTML string (structure preserved). */
function rangeHtml(editor: Editor, from: number, to: number): string {
  const slice = editor.state.doc.slice(from, to);
  const frag = DOMSerializer.fromSchema(editor.schema).serializeFragment(
    slice.content
  );
  const div = document.createElement("div");
  div.appendChild(frag);
  return div.innerHTML;
}

export function EditorAiEnhance({
  editor,
  fileId,
}: {
  editor: Editor;
  /** The document's file — a pre-AI version is kept before applying. */
  fileId?: string;
}) {
  const { providerId, modelId } = useEditorModel();
  const [busy, setBusy] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The selection being rewritten, kept in step with every edit made while
  // the model thinks and while the proposal waits — yours or a
  // collaborator's. Replacing at the positions captured before the call
  // used to delete the wrong text (R-222).
  const pendingRef = useRef<PendingRange | null>(null);
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: Parameters<typeof mapPendingRange>[1] } }) => {
      const pending = pendingRef.current;
      if (!pending || !transaction.docChanged) return;
      pendingRef.current = mapPendingRange(pending, transaction.mapping);
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

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
    if (editor.state.selection.empty) return;
    const { from, to } = targetRange(editor);
    const plain = editor.state.doc.textBetween(from, to, "\n").trim();
    if (!plain) return;
    if (!providerId || !modelId) {
      toast.error("No AI model is available to you yet — ask an admin to add one.");
      return;
    }
    // HTML keeps the structure; when that's over the limit, plain text
    // still fits more often. Past that, say so instead of a bare 422.
    let payload = rangeHtml(editor, from, to);
    if (payload.length > MAX_ENHANCE_CHARS) payload = plain;
    if (payload.length > MAX_ENHANCE_CHARS) {
      toast.info(
        `That selection is too long to enhance in one go — select up to about ${MAX_ENHANCE_CHARS.toLocaleString()} characters.`
      );
      return;
    }
    pendingRef.current = { from, to, text: plain };
    setBusy(true);
    try {
      const improved = (
        await chatApi.enhancePrompt(payload, providerId, modelId, "prose")
      ).trim();
      if (!improved) {
        pendingRef.current = null;
        toast.info("Nothing to improve — it already reads well.");
        return;
      }
      setProposal({ html: improved });
    } catch (e) {
      pendingRef.current = null;
      toast.error(apiErrorMessage(e, "Couldn't enhance the selection."));
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    pendingRef.current = null;
    setProposal(null);
  };

  const accept = async (mode: "replace" | "below" = "replace") => {
    if (!proposal) return;
    const pending = pendingRef.current;
    // The text was edited (or removed) while the proposal waited: replacing
    // now would overwrite someone's change. Offer "Insert below" instead.
    if (mode === "replace" && (!pending || !rangeUnchanged(editor.state.doc, pending))) {
      setProposal({ ...proposal, stale: true });
      return;
    }
    // Keep what was there before the AI change, so it can be got back
    // (WP-3.3). Bounded and best-effort — never blocks the edit.
    if (fileId) await filesApi.snapshotVersion(fileId, "pre_ai");
    // Mapped again after the await, in case anything changed during it.
    const now = pendingRef.current;
    const chain = editor.chain().focus();
    if (mode === "replace" && now && rangeUnchanged(editor.state.doc, now)) {
      chain.insertContentAt({ from: now.from, to: now.to }, proposal.html).run();
    } else {
      const at = now ? afterRangeBlock(editor.state.doc, now) : editor.state.doc.content.size;
      chain.insertContentAt(at, proposal.html).run();
    }
    discard();
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
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-text)]" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent-text)]" />
            )}
            {busy ? "Enhancing…" : "Enhance"}
          </button>
        )}
      </div>

      {proposal && (
        <div className="absolute bottom-3 left-1/2 z-30 w-[min(40rem,92%)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--accent)]/40 bg-[var(--surface)] shadow-2xl print:hidden">
          <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--accent-text)]">
            <Sparkles className="h-3.5 w-3.5" />
            Proposed rewrite
            <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">
              {proposal.stale ? "The original text changed" : "Replaces your selection"}
            </span>
          </div>
          <div
            className="promptly-doc max-h-60 overflow-y-auto px-4 py-3 text-sm"
            // Sanitized model output — rendered read-only for preview.
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(proposal.html),
            }}
          />
          {proposal.stale && (
            <div className="border-t border-[var(--border)] bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              The selected text was edited while this was waiting, so replacing it could overwrite that change.
              You can insert the rewrite below it instead.
            </div>
          )}
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
            <button
              type="button"
              onClick={discard}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <X className="h-3.5 w-3.5" />
              Discard
            </button>
            <button
              type="button"
              onClick={() => void accept("below")}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition",
                proposal.stale
                  ? "bg-[var(--accent)] font-medium text-white hover:opacity-90"
                  : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              )}
            >
              Insert below
            </button>
            {!proposal.stale && (
              <button
                type="button"
                onClick={() => void accept()}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90"
              >
                <Check className="h-3.5 w-3.5" />
                Replace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
