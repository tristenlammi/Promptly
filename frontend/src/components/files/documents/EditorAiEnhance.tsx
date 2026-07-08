import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Loader2, Sparkles } from "lucide-react";

import { chatApi } from "@/api/chat";
import { useModelStore } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * "Enhance" the current selection with AI — rewrites it for clarity / flow
 * (meaning preserved) via the /chat/enhance-prompt endpoint in ``prose``
 * mode, using the user's selected model. Anchored bottom-right of the editor,
 * just above the word-count pill; appears only while text is selected. Wears
 * a slow, subtle animated ring (see .ai-enhance-ring in index.css).
 */
export function EditorAiEnhance({ editor }: { editor: Editor }) {
  const providerId = useModelStore((s) => s.selectedProviderId);
  const modelId = useModelStore((s) => s.selectedModelId);
  const [busy, setBusy] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

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

  const enhance = async () => {
    if (busy) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n").trim();
    if (!text) return;
    if (!providerId || !modelId) {
      toast.error("Pick a model first (in a chat) to use AI enhance.");
      return;
    }
    setBusy(true);
    try {
      const improved = (
        await chatApi.enhancePrompt(text, providerId, modelId, "prose")
      ).trim();
      if (improved && improved !== text) {
        editor.chain().focus().insertContentAt({ from, to }, improved).run();
      } else {
        toast.info("Nothing to improve — it already reads well.");
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't enhance the selection."));
    } finally {
      setBusy(false);
    }
  };

  // IMPORTANT: the wrapper is ALWAYS mounted — we only toggle the button
  // *inside* it. Mounting/unmounting this element as a sibling of the Tiptap
  // DragHandle (whose DOM Tiptap repositions out from under React) makes
  // React's insertBefore reference a node that's no longer a child of the
  // container → "insertBefore … not a child of this node" on every
  // selection. A stable wrapper never triggers that reconciliation.
  const show = hasSelection || busy;
  return (
    <div className="absolute bottom-9 right-6 z-20 print:hidden">
      {show && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={enhance}
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
  );
}
