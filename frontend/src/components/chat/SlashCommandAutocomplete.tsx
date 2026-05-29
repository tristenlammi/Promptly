import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { useNavigate } from "react-router-dom";
import { Command, Settings2 } from "lucide-react";

import { useSavedPrompts } from "@/hooks/useSavedPrompts";
import type { SavedPrompt } from "@/api/savedPrompts";
import { cn } from "@/utils/cn";

export interface SlashPickState {
  /** Text after the leading ``/`` up to the caret. */
  query: string;
  /** Always 0 — the ``/`` only triggers at the very start of input. */
  startIndex: number;
  /** Caret position (end of the ``/query`` run). */
  endIndex: number;
}

/** Detect a ``/`` slash-command trigger: the ``/`` must be the very
 *  first character of the composer and the caret must still be on that
 *  first line. Returns ``null`` otherwise. Keeping it strictly
 *  start-of-input avoids hijacking literal slashes mid-sentence. */
export function detectSlashTrigger(
  text: string,
  caret: number
): SlashPickState | null {
  if (caret < 1) return null;
  const before = text.slice(0, caret);
  if (before[0] !== "/") return null;
  if (before.includes("\n")) return null;
  return { query: before.slice(1), startIndex: 0, endIndex: caret };
}

interface SlashCommandAutocompleteProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  caret: number;
  /** Replace the ``/query`` run with the chosen prompt body. */
  onApply: (body: string, pick: SlashPickState) => void;
  onKeyRegister: (handler: (e: { key: string }) => boolean) => void;
}

/** Inline popover that lists the user's saved prompts when they type
 *  ``/`` at the start of the composer (Phase 3.1). Selecting one
 *  replaces the ``/query`` with the prompt's body. */
export function SlashCommandAutocomplete({
  textareaRef,
  value,
  caret,
  onApply,
  onKeyRegister,
}: SlashCommandAutocompleteProps) {
  const navigate = useNavigate();
  const pick = useMemo(() => detectSlashTrigger(value, caret), [value, caret]);
  const { data: prompts } = useSavedPrompts();
  const [highlighted, setHighlighted] = useState(0);

  // Client-side filter by title (prompts are few + user-owned, so no
  // server round-trip per keystroke).
  const filtered = useMemo<SavedPrompt[]>(() => {
    if (!pick) return [];
    const q = pick.query.trim().toLowerCase();
    const all = prompts ?? [];
    if (!q) return all.slice(0, 8);
    return all
      .filter((p) => p.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [pick, prompts]);

  useEffect(() => {
    setHighlighted(0);
  }, [pick?.query]);

  const apply = useCallback(
    (p: SavedPrompt) => {
      if (!pick) return;
      onApply(p.body, pick);
    },
    [pick, onApply]
  );

  useEffect(() => {
    onKeyRegister((e: { key: string }) => {
      if (!pick) return false;
      if (filtered.length === 0 && e.key !== "Escape") return false;
      switch (e.key) {
        case "ArrowDown":
          setHighlighted((h) => (h + 1) % Math.max(filtered.length, 1));
          return true;
        case "ArrowUp":
          setHighlighted(
            (h) =>
              (h - 1 + Math.max(filtered.length, 1)) %
              Math.max(filtered.length, 1)
          );
          return true;
        case "Enter":
        case "Tab": {
          const p = filtered[highlighted];
          if (p) {
            apply(p);
            return true;
          }
          return false;
        }
        case "Escape":
          return true;
        default:
          return false;
      }
    });
  }, [pick, filtered, highlighted, onKeyRegister, apply]);

  if (!pick) return null;

  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    textareaRef.current?.focus();
  };

  return (
    <div className="absolute bottom-full left-0 right-0 mx-auto mb-2 max-w-3xl px-4">
      <div
        role="listbox"
        aria-label="Insert a saved prompt"
        className={cn(
          "max-h-72 overflow-y-auto rounded-card border shadow-lg",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
          <Command className="h-3 w-3" />
          <span>
            Insert a saved prompt —{" "}
            <span className="font-mono text-[var(--text)]">
              {pick.query ? `/${pick.query}` : "type to filter"}
            </span>
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--text-muted)]">
            {(prompts?.length ?? 0) === 0 ? (
              <>
                No saved prompts yet. Create some in{" "}
                <button
                  type="button"
                  onMouseDown={keepFocus}
                  onClick={() => navigate("/account/security")}
                  className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  account settings
                </button>
                .
              </>
            ) : (
              `No prompts matching "${pick.query}".`
            )}
          </div>
        ) : (
          <div className="py-1">
            {filtered.map((p, i) => {
              const active = i === highlighted;
              return (
                <button
                  key={p.id}
                  role="option"
                  aria-selected={active}
                  onMouseDown={keepFocus}
                  onClick={() => apply(p)}
                  onMouseEnter={() => setHighlighted(i)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition",
                    active
                      ? "bg-[var(--accent)]/10 text-[var(--text)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--accent)]/5 hover:text-[var(--text)]"
                  )}
                >
                  <Settings2
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      active ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[var(--text)]">
                      {p.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                      {p.body}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
          ↑↓ navigate · Enter or Tab to insert · Esc to close
        </div>
      </div>
    </div>
  );
}
