import { useState } from "react";
import { BubbleMenu, type Editor } from "@tiptap/react";
import { Loader2, Sparkles } from "lucide-react";

import { chatApi } from "@/api/chat";
import { useModelStore } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * A single-purpose selection affordance: an "Enhance" button that floats
 * *below* a text selection and rewrites it with AI (grammar / clarity /
 * flow, meaning preserved). Deliberately NOT a formatting bubble menu — the
 * toolbar already covers formatting; this is the one thing it can't. The
 * button wears a slow, softly-rainbow animated ring (see .ai-enhance-ring
 * in index.css). Reuses the /chat/enhance-prompt endpoint in ``prose`` mode
 * with the user's currently selected model.
 */
export function EditorAiEnhance({ editor }: { editor: Editor }) {
  const providerId = useModelStore((s) => s.selectedProviderId);
  const modelId = useModelStore((s) => s.selectedModelId);
  const [busy, setBusy] = useState(false);

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
        // Replace the selection with the improved text (plain — marks on the
        // old run are dropped, matching a rewrite).
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

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="aiEnhance"
      tippyOptions={{ duration: 150, placement: "bottom", maxWidth: "none" }}
      shouldShow={({ from, to }) => from !== to}
    >
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
    </BubbleMenu>
  );
}
