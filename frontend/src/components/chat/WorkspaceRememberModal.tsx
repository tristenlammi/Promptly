/**
 * WorkspaceRememberModal — "Save to workspace memory" picker.
 *
 * Opened by the message Remember action inside a workspace chat. Unlike the
 * account RememberModal (which stores a verbatim fact), this lets the user
 * trim the message down to the part worth keeping, then hands that snippet to
 * the workspace's memory agent, which decides how and where to fold it into
 * the workspace memory document.
 */
import { useEffect, useRef, useState } from "react";
import { Brain, Check, Loader2, X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

interface WorkspaceRememberModalProps {
  /** Pre-filled text (the message content) — the user trims it down. */
  initialText: string;
  /** Persist the chosen snippet to the workspace memory. Throws on failure. */
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}

const MAX_LEN = 4000;

export function WorkspaceRememberModal({
  initialText,
  onSave,
  onClose,
}: WorkspaceRememberModalProps) {
  const [text, setText] = useState(() => initialText.slice(0, MAX_LEN).trim());
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, saving]);

  const handleSave = async () => {
    const snippet = text.trim();
    if (!snippet || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(snippet);
      setDone(true);
      window.setTimeout(onClose, 1000);
    } catch {
      setError("Couldn't save to workspace memory — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40" />

      <div
        className={cn(
          "relative z-10 w-full max-w-md rounded-card border shadow-xl",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Save to workspace memory"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Brain className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="flex-1 text-sm font-semibold">
            Save to workspace memory
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <p className="text-xs text-[var(--text-muted)]">
            Trim this down to just the part worth remembering. The workspace's
            memory keeper decides how and where to store it.
          </p>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            maxLength={MAX_LEN}
            placeholder="What should this workspace remember?"
            disabled={saving || done}
            className={cn(
              "w-full resize-y rounded-input border border-[var(--border)]",
              "bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]",
              "placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none",
              "disabled:opacity-60"
            )}
          />

          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!text.trim() || saving || done}
            onClick={() => void handleSave()}
          >
            {done ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Saved!
              </>
            ) : saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Brain className="h-3.5 w-3.5" />
                Save to memory
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
