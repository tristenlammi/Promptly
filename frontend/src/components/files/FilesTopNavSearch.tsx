import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, X } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

/**
 * Drive-wide search entrypoint that drops into the ``TopNav``
 * ``actions`` slot.
 *
 * Two rendering modes:
 *   - Desktop (md+): inline input inside the header so power users
 *     can search without another tap.
 *   - Mobile: icon-only button that opens a full-screen sheet with
 *     an autofocused input. Submitting either mode navigates to
 *     ``/files/search?q=…`` where the results page runs the FTS.
 */
export function FilesTopNavSearch() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const [value, setValue] = useState(urlQ);
  const [focused, setFocused] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    setValue(urlQ);
  }, [urlQ]);

  const submit = (next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    navigate(`/files/search?q=${encodeURIComponent(trimmed)}`);
    setSheetOpen(false);
  };

  // On mobile we render only the icon-trigger in the TopNav; the
  // sheet is portaled so it can span the full viewport without
  // inheriting the header's height.
  if (isMobile) {
    return (
      <>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          title="Search Drive"
          aria-label="Search Drive"
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-md",
            "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition",
            "hover:text-[var(--text)]"
          )}
        >
          <Search className="h-4 w-4" />
        </button>
        <SearchSheet
          open={sheetOpen}
          initial={value}
          onClose={() => setSheetOpen(false)}
          onSubmit={submit}
        />
      </>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
      className={cn(
        "relative inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5",
        "bg-[var(--surface)] transition",
        focused
          ? "border-[var(--accent)]"
          : "border-[var(--border)] hover:border-[var(--text-muted)]/50"
      )}
    >
      <Search className="h-3.5 w-3.5 text-[var(--text-muted)]" />
      <input
        type="search"
        placeholder="Search Drive…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-44 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none md:w-64"
      />
    </form>
  );
}

function SearchSheet({
  open,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSubmit: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setValue(initial);
      // Autofocus after the overlay mounts — iOS Safari refuses to
      // open the keyboard without a tap-originated focus chain, so
      // we schedule this to the next microtask which keeps it within
      // the user-gesture window.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search Drive"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)] pt-safe"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-3">
        <Search className="h-4 w-4 text-[var(--text-muted)]" />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit(value);
            }
          }}
          placeholder="Search Drive by name or content…"
          className="min-w-0 flex-1 bg-transparent text-base text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 text-sm text-[var(--text-muted)]">
        <p>Enter a term and tap Search — results show files matching by filename or content.</p>
        <button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={!value.trim()}
          className={cn(
            "mt-6 inline-flex w-full items-center justify-center gap-2 rounded-input px-4 py-3 text-base font-medium transition",
            value.trim()
              ? "bg-[var(--accent)] text-white hover:opacity-90"
              : "cursor-not-allowed bg-[var(--surface)] text-[var(--text-muted)]"
          )}
        >
          <Search className="h-4 w-4" />
          Search
        </button>
      </div>
    </div>,
    document.body
  );
}
