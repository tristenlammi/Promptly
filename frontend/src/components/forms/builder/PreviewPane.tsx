import { Eye, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { FormDefinition, FormSettings } from "@/api/forms";

import { FormDone, FormRenderer } from "../FormRenderer";

/**
 * The preview: the real answer page's ``FormRenderer``, updating as you
 * type. On a computer it's a phone-sized pane beside the questions; on a
 * phone it fills the screen. You can follow branches and see the
 * confirmation; nothing is saved.
 */
export function PreviewPane({
  definition,
  assetUrls,
  settings,
  variant,
  onClose,
}: {
  definition: FormDefinition;
  assetUrls: Record<string, string>;
  settings: FormSettings;
  variant: "side" | "full";
  onClose: () => void;
}) {
  const [run, setRun] = useState(0);
  const [done, setDone] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const restart = () => {
    setDone(false);
    setRun((n) => n + 1);
  };
  useEffect(() => {
    if (variant !== "full") return;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [variant, onClose]);

  const bar = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-sm">
      <Eye className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--text)]">Preview — answers aren&apos;t saved</span>
      <button
        type="button"
        onClick={restart}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[var(--text)] hover:bg-[var(--hover)]"
        title="Start again"
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Start again</span>
      </button>
      <button
        ref={closeBtn}
        type="button"
        onClick={onClose}
        aria-label="Close the preview"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text)] hover:bg-[var(--hover)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
  const body = (
    <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
      {done ? (
        <FormDone definition={definition} assetUrls={assetUrls} message={settings.confirmation}>
          <div className="flex flex-wrap gap-2">
            {settings.allow_another && (
              <button type="button" className="pf-btn pf-btn-ghost" onClick={restart}>
                Send another answer
              </button>
            )}
            <button type="button" className="pf-btn pf-btn-primary" onClick={restart}>
              Back to the start of the preview
            </button>
          </div>
        </FormDone>
      ) : (
        <FormRenderer
          key={run}
          definition={definition}
          assetUrls={assetUrls}
          mode="preview"
          showRemaining={settings.show_remaining}
          notice={
            settings.audience === "link"
              ? "Don't put passwords or bank details in a form."
              : "People on this server answer as themselves."
          }
          onSubmit={() => setDone(true)}
          footer="Made with Promptly"
        />
      )}
    </div>
  );

  if (variant === "full")
    return createPortal(
      <div role="dialog" aria-modal="true" aria-label="Preview" className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)] pt-safe">
        {bar}
        {body}
      </div>,
      document.body
    );
  return (
    <aside aria-label="Preview" className="flex w-[400px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
      {bar}
      {body}
    </aside>
  );
}
