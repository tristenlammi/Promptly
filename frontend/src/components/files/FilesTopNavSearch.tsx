import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { Folder, FolderSearch, Search, X } from "lucide-react";

import { DriveItemIcon } from "@/components/files/DriveItemIcon";
import { useSearchFiles } from "@/hooks/useFiles";
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
/** Debounced query for the instant results (R-213: search used to run
 *  only on submit). */
function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The top few matches as you type; Enter (or "See all") opens the
 *  full results page. */
function InstantResults({
  q,
  onPick,
  onSeeAll,
  className,
  folderId,
  inFolder,
  onToggleFolder,
}: {
  q: string;
  onPick: (to: string) => void;
  onSeeAll: () => void;
  className?: string;
  /** The folder being browsed, when there is one. */
  folderId?: string | null;
  inFolder?: boolean;
  onToggleFolder?: () => void;
}) {
  const debounced = useDebounced(q.trim());
  const within = folderId && inFolder ? folderId : null;
  const { data, isFetching } = useSearchFiles(debounced, "mine", {
    limit: 6,
    enabled: debounced.length >= 2,
    folderId: within,
  });
  if (debounced.length < 2) return null;
  const folders = (data?.folders ?? []).slice(0, 3);
  const hits = data?.hits ?? [];
  return (
    <div className={className}>
      {folderId && onToggleFolder && (
        <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-1 text-xs">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggleFolder}
            aria-pressed={!!inFolder}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition",
              inFolder
                ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent-text)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            <FolderSearch className="h-3 w-3" />
            {inFolder ? (data?.within_trail?.split(" / ").pop() ?? "This folder") : "Only this folder"}
          </button>
          {inFolder && <span className="text-[var(--text-muted)]">· searching inside it</span>}
        </div>
      )}
      {!data && isFetching && (
        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Searching…</div>
      )}
      {data && folders.length === 0 && hits.length === 0 && (
        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No matches yet.</div>
      )}
      {folders.map((f) => (
        <button
          key={f.id}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            onPick(f.scope === "mine" ? `/files/folder/${f.id}` : `/files/folder/${f.id}?scope=shared`)
          }
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)]"
        >
          <Folder className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{f.name}</span>
            {data?.folder_breadcrumbs?.[f.id] && (
              <span className="block truncate text-[11px] text-[var(--text-muted)]">
                {data.folder_breadcrumbs[f.id]}
              </span>
            )}
          </span>
        </button>
      ))}
      {hits.map((h) => (
        <button
          key={h.file.id}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            onPick(
              `/files/search?q=${encodeURIComponent(debounced)}&open=${h.file.id}${within ? `&in=${within}` : ""}`
            )
          }
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)]"
        >
          <DriveItemIcon file={h.file} className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{h.file.filename}</span>
            {h.breadcrumb && (
              <span className="block truncate text-[11px] text-[var(--text-muted)]">
                {h.breadcrumb}
              </span>
            )}
          </span>
        </button>
      ))}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSeeAll}
        className="flex w-full items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-left text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]"
      >
        <Search className="h-3.5 w-3.5" />
        See all results for “{debounced}”{within ? " in this folder" : ""}
      </button>
    </div>
  );
}

export function FilesTopNavSearch() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const [value, setValue] = useState(urlQ);
  const [focused, setFocused] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useIsMobile();
  // Browsing a folder: the box can search inside it (WP-5.4) — on by
  // default there, one click to widen to everything.
  const folderMatch = useMatch("/files/folder/:folderId");
  const folderId = folderMatch?.params.folderId ?? params.get("in") ?? null;
  const [inFolder, setInFolder] = useState(true);
  useEffect(() => setInFolder(true), [folderId]);
  const within = folderId && inFolder ? folderId : null;

  useEffect(() => {
    setValue(urlQ);
  }, [urlQ]);

  const submit = (next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    navigate(`/files/search?q=${encodeURIComponent(trimmed)}${within ? `&in=${within}` : ""}`);
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
          onPick={(to) => {
            setSheetOpen(false);
            navigate(to);
          }}
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
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
        className="w-44 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none md:w-64"
      />
      {focused && (
        <InstantResults
          q={value}
          folderId={folderId}
          inFolder={inFolder}
          onToggleFolder={() => setInFolder((v) => !v)}
          onPick={(to) => {
            setFocused(false);
            (document.activeElement as HTMLElement | null)?.blur();
            navigate(to);
          }}
          onSeeAll={() => submit(value)}
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-96 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
        />
      )}
    </form>
  );
}

function SearchSheet({
  open,
  initial,
  onClose,
  onSubmit,
  onPick,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSubmit: (v: string) => void;
  onPick: (to: string) => void;
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

      <InstantResults
        q={value}
        onPick={onPick}
        onSeeAll={() => onSubmit(value)}
        className="border-b border-[var(--border)]"
      />
      <div className="flex-1 overflow-y-auto px-4 py-6 text-sm text-[var(--text-muted)]">
        <p>Search by name or content — files shared with you included.</p>
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
