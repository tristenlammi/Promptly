import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Check, Copy, CornerDownLeft, Loader2, Sparkles, X } from "lucide-react";

import { editorAiApi, type AskTurn } from "@/api/editorAi";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { useEditorAiHooks } from "@/lib/editorAiBridge";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Ask about the open file (WP-5.5): a side panel in the Docs / Sheets /
 * Whiteboard editors. Answers come from the file's own text plus what's
 * selected; "Insert" (Docs) puts an answer at the cursor. The conversation
 * lives only while the panel is open — it isn't a chat.
 */
const SUGGESTIONS: Record<string, string[]> = {
  document: ["Summarise this document", "List the action items", "What's unclear or missing?"],
  sheet: ["What does this sheet show?", "Anything unusual in the numbers?", "Explain the formulas here"],
  whiteboard: ["Summarise this board", "Turn this into a plan"],
};

interface Turn extends AskTurn {
  truncated?: boolean;
}

export function AskPanel({
  fileId,
  kind,
  open,
  onClose,
  pendingQuestion,
  onPendingTaken,
}: {
  fileId: string;
  kind: "document" | "sheet" | "whiteboard";
  open: boolean;
  onClose: () => void;
  /** A question to ask as soon as the panel opens (Sheets' "Explain formula"). */
  pendingQuestion?: string | null;
  onPendingTaken?: () => void;
}) {
  const { providerId, modelId } = useEditorModel();
  const hooks = useEditorAiHooks();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [useSelection, setUseSelection] = useState(true);
  const [selection, setSelection] = useState<{ label: string; text: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // What's selected, refreshed while the panel is open (cheap: a read).
  useEffect(() => {
    if (!open) return;
    const read = () => setSelection(hooks?.current.getSelection?.() ?? null);
    read();
    const t = window.setInterval(read, 800);
    inputRef.current?.focus();
    return () => window.clearInterval(t);
  }, [open, hooks]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const ask = async (question: string, sel = useSelection ? selection : null) => {
    const q = question.trim();
    if (!q || busy) return;
    if (!providerId || !modelId) {
      toast.error(NO_MODEL_MESSAGE);
      return;
    }
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: q }]);
    setDraft("");
    setBusy(true);
    try {
      const res = await editorAiApi.ask(fileId, {
        provider_id: providerId,
        model_id: modelId,
        question: q,
        selection: sel ? `${sel.label}\n${sel.text}`.slice(0, 8000) : null,
        history: history.slice(-6),
      });
      setTurns((t) => [...t, { role: "assistant", content: res.answer, truncated: res.truncated }]);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't get an answer."));
      setTurns((t) => t.slice(0, -1));
      setDraft(q);
    } finally {
      setBusy(false);
    }
  };

  // A question handed over by a tool (e.g. "Explain formula").
  useEffect(() => {
    if (!open || !pendingQuestion) return;
    onPendingTaken?.();
    void ask(pendingQuestion, hooks?.current.getSelection?.() ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingQuestion]);

  if (!open) return null;
  const canInsert = !!hooks?.current.insert;

  return (
    <aside
      aria-label="Ask AI"
      className="relative z-10 flex w-full shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface)] sm:w-[22rem]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Sparkles className="h-4 w-4 text-[var(--accent-text)]" />
        <span className="text-sm font-medium text-[var(--text)]">Ask about this {kind === "document" ? "document" : kind}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Ask AI"
          className="ml-auto rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {turns.length === 0 && !busy && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">
              Answers come from this file{kind === "document" ? " and what you've selected" : ""}. Nothing is changed
              unless you insert it.
            </p>
            {(SUGGESTIONS[kind] ?? []).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void ask(s)}
                className="block w-full rounded-md border border-[var(--border)] px-2.5 py-1.5 text-left text-xs text-[var(--text)] hover:bg-[var(--hover)]"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="ml-6 rounded-lg bg-[var(--accent)]/10 px-3 py-2 text-sm text-[var(--text)]">
              {t.content}
            </div>
          ) : (
            <div key={i} className="group" data-testid="ask-answer">
              <div className="promptly-prose text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
              </div>
              {t.truncated && (
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  The file is long — only its first part was read.
                </p>
              )}
              <div className="mt-1 flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(t.content);
                    setCopied(i);
                    window.setTimeout(() => setCopied(null), 1500);
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  {copied === i ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied === i ? "Copied" : "Copy"}
                </button>
                {canInsert && (
                  <button
                    type="button"
                    onClick={() => {
                      hooks?.current.insert?.(t.content);
                      toast.success("Inserted at the cursor.");
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <CornerDownLeft className="h-3 w-3" />
                    Insert
                  </button>
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the file…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
        className="border-t border-[var(--border)] p-2"
      >
        {selection && (
          <label className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={useSelection}
              onChange={(e) => setUseSelection(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="truncate">Include the selection · {selection.label}</span>
          </label>
        )}
        <div className="flex items-end gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 focus-within:border-[var(--accent)]">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(draft);
              }
            }}
            rows={2}
            placeholder="Ask about this file…"
            aria-label="Ask about this file"
            className="min-h-0 flex-1 resize-none bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Ask"
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition",
              draft.trim() && !busy ? "bg-[var(--accent)] text-white" : "bg-[var(--hover)] text-[var(--text-muted)]"
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </form>
    </aside>
  );
}
