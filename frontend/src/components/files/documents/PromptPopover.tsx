import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

/**
 * A small anchored input — the in-app replacement for ``window.prompt``
 * (WP-4.5, R-226): a YouTube link, an image caption, a LaTeX formula.
 * Same look as the link editor. Enter applies, Esc closes just this.
 */
export function PromptPopover({
  anchor,
  label,
  placeholder,
  initial = "",
  multiline = false,
  hint,
  onSubmit,
  onClose,
}: {
  anchor: DOMRect;
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  hint?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const WIDTH = multiline ? 380 : 320;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8));
  const top = Math.min(anchor.bottom + 6, window.innerHeight - (multiline ? 160 : 70));
  const submit = () => {
    onSubmit(value);
    onClose();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const field =
    "min-w-0 flex-1 rounded-md bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]";

  return createPortal(
    <>
      <div className="fixed inset-0 z-[75]" onMouseDown={onClose} />
      <div
        data-esc-layer
        role="dialog"
        aria-label={label}
        style={{ position: "fixed", top, left, width: WIDTH, zIndex: 76 }}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-1.5">
          {multiline ? (
            <textarea
              ref={ref}
              aria-label={label}
              value={value}
              rows={3}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className={`${field} resize-none font-mono`}
            />
          ) : (
            <input
              ref={ref}
              aria-label={label}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className={field}
            />
          )}
          <button
            type="button"
            title="Apply"
            aria-label="Apply"
            onClick={submit}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-white transition hover:opacity-90"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
        {hint && <p className="mt-1 px-1 text-[11px] text-[var(--text-muted)]">{hint}</p>}
      </div>
    </>,
    document.body
  );
}
