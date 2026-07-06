import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";

import { chatApi } from "@/api/chat";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";

const MAX_LEN = 8000;

interface Props {
  conversationId: string;
  /** Current per-conversation instructions (system prompt). */
  value: string | null | undefined;
  /** Collapse the trigger to icon-only for tight (mobile) headers. */
  compact?: boolean;
  /** Called with the saved value so the parent can update its cache
   *  without a hard refetch. */
  onSaved: (next: string | null) => void;
}

/**
 * Per-conversation custom instructions (Phase 1). A small header
 * affordance that opens a modal with a free-text steer ("answer
 * concisely", "you're a Rust expert") persisted on the conversation.
 * The backend merges it into the outbound system prompt. A filled dot
 * on the trigger signals when instructions are active so the user
 * isn't surprised by steered replies.
 */
export function ConversationInstructionsButton({
  conversationId,
  value,
  compact = false,
  onSaved,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft whenever we (re)open or the persisted value
  // changes underneath us (e.g. switching conversations).
  useEffect(() => {
    if (open) setDraft(value ?? "");
  }, [open, value]);

  const hasInstructions = !!(value && value.trim().length > 0);

  const save = async () => {
    setSaving(true);
    setError(null);
    const next = draft.trim();
    try {
      await chatApi.update(conversationId, { system_prompt: next });
      onSaved(next || null);
      setOpen(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't save instructions. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Conversation instructions"
        title={
          hasInstructions
            ? "Edit this chat's instructions"
            : "Add instructions for this chat"
        }
        className={cn(
          "relative inline-flex items-center gap-1.5 rounded-input border text-xs",
          "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
          "hover:bg-[var(--hover)]",
          compact ? "h-9 w-9 justify-center" : "px-3 py-1.5"
        )}
      >
        <ScrollText className="h-4 w-4 shrink-0" />
        {!compact && <span>Instructions</span>}
        {hasInstructions && (
          <span
            aria-hidden
            className={cn(
              "rounded-full bg-[var(--accent)]",
              compact
                ? "absolute right-1 top-1 h-1.5 w-1.5"
                : "h-1.5 w-1.5"
            )}
          />
        )}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Chat instructions"
        description="A steer applied to every reply in this chat — e.g. “answer concisely” or “you're a senior Rust engineer.” Leave blank to remove."
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={saving}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                "text-[var(--text-muted)] hover:text-[var(--text)]",
                "disabled:opacity-60"
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || draft === (value ?? "")}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                "bg-[var(--accent)] text-white hover:opacity-90",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_LEN))}
          rows={8}
          autoFocus
          placeholder="e.g. Always answer concisely and include a short code example when relevant."
          className={cn(
            "w-full resize-y rounded-md border bg-[var(--bg)] px-3 py-2 text-sm",
            "border-[var(--border)] text-[var(--text)]",
            "outline-none focus:border-[var(--accent)]"
          )}
        />
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>Applies to this chat only — not your other conversations.</span>
          <span>
            {draft.length} / {MAX_LEN}
          </span>
        </div>
        {error && (
          <p className="mt-2 text-xs text-red-500">{error}</p>
        )}
      </Modal>
    </>
  );
}
