import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, SpellCheck } from "lucide-react";

import { cn } from "@/utils/cn";
import { useSpellcheckStore } from "@/store/spellcheckStore";
import { SPELL_LANGUAGES, spellLangShort } from "./spellDictionaries";

/**
 * Toolbar control for the note spell-checker: a toggle plus a language
 * picker, in a portal popover (same pattern as the colour / table controls).
 * The button badges the active language code; the accent ring shows when
 * checking is on.
 */
export function SpellCheckControl() {
  const enabled = useSpellcheckStore((s) => s.enabled);
  const lang = useSpellcheckStore((s) => s.lang);
  const setEnabled = useSpellcheckStore((s) => s.setEnabled);
  const setLang = useSpellcheckStore((s) => s.setLang);

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  return (
    <>
      <button
        type="button"
        title={
          enabled
            ? `Spell-check: on (${spellLangShort(lang)})`
            : "Spell-check: off"
        }
        aria-label="Spell-check settings"
        // Keep the editor selection alive (see ToolButton) so toggling
        // doesn't blur the doc.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          setAnchor(e.currentTarget.getBoundingClientRect());
          setOpen((o) => !o);
        }}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-[var(--muted)] transition",
          "hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10",
          (open || enabled) && "bg-black/10 text-[var(--text)] dark:bg-white/15"
        )}
      >
        <SpellCheck
          className={cn("h-4 w-4", enabled && "text-[var(--accent)]")}
        />
        <span className="text-[10px] font-semibold tabular-nums">
          {enabled ? spellLangShort(lang) : "off"}
        </span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[75]"
              onMouseDown={() => setOpen(false)}
            />
            <div
              style={{
                position: "fixed",
                top: Math.min(anchor.bottom + 6, window.innerHeight - 320),
                left: Math.max(
                  8,
                  Math.min(anchor.left, window.innerWidth - 232)
                ),
                zIndex: 76,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-56 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl"
            >
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEnabled(!enabled)}
                className="flex w-full items-center justify-between px-3 py-2 text-sm text-[var(--text)] transition hover:bg-black/5 dark:hover:bg-white/10"
              >
                <span className="font-medium">Check spelling</span>
                <span
                  className={cn(
                    "relative h-5 w-9 rounded-full transition-colors",
                    enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                      enabled ? "left-[1.125rem]" : "left-0.5"
                    )}
                  />
                </span>
              </button>

              <div className="my-1 h-px bg-[var(--border)]" />

              <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Language
              </div>
              {SPELL_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setLang(l.code);
                    if (!enabled) setEnabled(true);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-1.5 text-sm transition hover:bg-black/5 dark:hover:bg-white/10",
                    l.code === lang
                      ? "text-[var(--text)]"
                      : "text-[var(--muted)]"
                  )}
                >
                  <span>{l.label}</span>
                  {l.code === lang && (
                    <Check className="h-4 w-4 text-[var(--accent)]" />
                  )}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  );
}
