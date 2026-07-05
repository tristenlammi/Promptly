import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FolderKanban,
  Search,
  Sparkles,
  Users,
  User as UserIcon,
  Loader2,
  X,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { workspacesApi } from "@/api/workspaces";
import type { ConversationSearchHit } from "@/api/types";
import { cn } from "@/utils/cn";
import { SearchDateFilter, type DateRange } from "./SearchDateFilter";

/**
 * Global command palette for full-text conversation search.
 *
 * Opened via ``Ctrl+K`` / ``Cmd+K`` (or the sidebar search entry). The
 * modal covers the top-centre of the viewport, debounces queries by
 * 200ms, and groups hits into "Your chats" + "Shared with you"
 * sections based on the ``access`` flag the backend returns.
 *
 * Click-through navigates to ``/chat/<conv>#m-<id>`` — ChatPage
 * picks up the hash and scrolls-to-highlight the anchored message
 * (same convention the inline sidebar search uses).
 *
 * Keyboard:
 *   * ``Esc``         close
 *   * ``Arrow Up/Down`` move the highlighted row
 *   * ``Enter``       open the highlighted row
 *
 * We deliberately show the raw ``ts_headline`` snippet verbatim — the
 * backend emits ``[[HL]]…[[/HL]]`` markers (safe plaintext, not HTML)
 * which we rewrite to ``<mark>`` at render time so there's no XSS
 * surface from injecting user content into ``dangerouslySetInnerHTML``.
 */

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
}

const DEBOUNCE_MS = 200;

export function SearchPalette({ open, onClose }: SearchPaletteProps) {
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [hits, setHits] = useState<ConversationSearchHit[]>([]);
  // Cross-workspace content hits (9.2) — grouped per workspace,
  // rendered under the chat sections. Mouse-driven (not in the ↑↓ flat
  // list) so the chat cursor maths stays simple.
  const [wsGroups, setWsGroups] = useState<
    Awaited<ReturnType<typeof workspacesApi.searchAll>>["groups"]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // True while the date-filter popover is open — the palette yields its
  // keyboard handling (Escape / arrows) to the popover during that time.
  const dateOpenRef = useRef(false);
  // Increments on every keystroke; stale fetches compare against it so
  // a slow request from an older query doesn't clobber the UI once
  // the user has kept typing.
  const fetchSeq = useRef(0);

  // Reset state on close so the next open starts fresh (no stale
  // results flashing before the new query fires).
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDateRange(null);
      setHits([]);
      setWsGroups([]);
      setError(null);
      setCursor(0);
      setLoading(false);
      return;
    }
    // Next frame so the modal is mounted before focus lands.
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Debounced search — trailing only. Fires when there's a text query, a
  // date filter, or both. With no query but a date range it switches into
  // "browse by date" mode (the backend returns the chats active in the
  // window). With neither, results clear without a round-trip.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed && !dateRange) {
      setHits([]);
      setWsGroups([]);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeq.current;
    setLoading(true);
    const t = window.setTimeout(async () => {
      // Workspace content search rides alongside the chat search (its
      // own request so a slow pass can't delay chat results). Dates
      // don't apply to it — a date-only browse clears the section.
      if (trimmed.length >= 2) {
        void workspacesApi
          .searchAll(trimmed)
          .then((res) => {
            if (seq === fetchSeq.current) setWsGroups(res.groups);
          })
          .catch(() => {
            if (seq === fetchSeq.current) setWsGroups([]);
          });
      } else {
        setWsGroups([]);
      }
      try {
        const results = await chatApi.search(trimmed, 30, {
          start: dateRange?.start ?? undefined,
          end: dateRange?.end ?? undefined,
        });
        if (seq !== fetchSeq.current) return; // superseded
        setHits(results);
        setError(null);
        setCursor(0);
      } catch (e) {
        if (seq !== fetchSeq.current) return;
        setError(extractError(e));
      } finally {
        if (seq === fetchSeq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, open, dateRange]);

  // Split hits into the two sections we render. We keep the original
  // rank order within each section so the "most relevant" within a
  // section surfaces first — cross-section ranking would bury shared
  // chats the user might actually want to see.
  const [owned, shared] = useMemo(() => {
    const o: ConversationSearchHit[] = [];
    const s: ConversationSearchHit[] = [];
    for (const h of hits) (h.access === "owner" ? o : s).push(h);
    return [o, s];
  }, [hits]);

  // Flat list for keyboard navigation — keeps the cursor maths simple
  // without having to worry about section boundaries.
  const flat = useMemo(() => [...owned, ...shared], [owned, shared]);

  // Handle global keyboard inside the modal. Keep arrow keys from
  // reaching the underlying page (e.g. scrolling the chat log).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // While the date popover is open it owns the keyboard — don't let
      // Escape close the whole palette or arrows move the result cursor.
      if (dateOpenRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(flat.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter") {
        const hit = flat[cursor];
        if (hit) {
          e.preventDefault();
          openHit(hit);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, flat, cursor, onClose]);

  // Keep the cursored row visible as the user arrows down past the
  // visible viewport of the scrollable list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${cursor}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const openHit = (hit: ConversationSearchHit) => {
    onClose();
    navigate(`/chat/${hit.conversation_id}#m-${hit.message_id}`);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 p-4 pt-[10vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl",
          "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <Search className="h-4 w-4 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your conversations…"
            className={cn(
              "flex-1 bg-transparent text-sm focus:outline-none",
              "placeholder:text-[var(--text-muted)]"
            )}
          />
          {loading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
          )}
          <SearchDateFilter
            value={dateRange}
            onChange={setDateRange}
            onOpenChange={(o) => {
              dateOpenRef.current = o;
            }}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className={cn(
              "rounded p-1 text-[var(--text-muted)] transition",
              "hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {error && (
            <div className="px-3 py-4 text-xs text-[var(--danger)]">
              {error}
            </div>
          )}
          {!error &&
            !loading &&
            flat.length === 0 &&
            wsGroups.length === 0 &&
            (query.trim() || dateRange) && (
              <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                {query.trim() ? (
                  <>
                    No matches for "{query.trim()}"
                    {dateRange ? ` in ${dateRange.label}` : ""}.
                  </>
                ) : (
                  <>No chats found for {dateRange!.label}.</>
                )}
              </div>
            )}
          {!error && !query.trim() && !dateRange && (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              Type to search across your messages, or filter by date to
              browse your chats.
            </div>
          )}

          {/* Browse-by-date caption — results here are one row per chat
              rather than per-message hits, so name what's being shown. */}
          {!error && dateRange && !query.trim() && flat.length > 0 && (
            <div className="px-3 pt-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              {flat.length} chat{flat.length === 1 ? "" : "s"} in{" "}
              {dateRange.label}
            </div>
          )}

          {owned.length > 0 && (
            <Section
              label="Your chats"
              icon={<UserIcon className="h-3 w-3" />}
              hits={owned}
              baseIndex={0}
              cursor={cursor}
              onSelect={openHit}
              onHover={setCursor}
            />
          )}
          {shared.length > 0 && (
            <Section
              label="Shared with you"
              icon={<Users className="h-3 w-3" />}
              hits={shared}
              baseIndex={owned.length}
              cursor={cursor}
              onSelect={openHit}
              onHover={setCursor}
            />
          )}

          {/* Cross-workspace content (9.2) — notes / boards / sheets /
              files across every workspace, grouped per workspace. */}
          {!dateRange && wsGroups.length > 0 && (
            <div className="border-t border-[var(--border)]">
              <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                <FolderKanban className="h-3 w-3" />
                In your workspaces
              </div>
              {wsGroups.map((g) => (
                <div key={g.workspace_id} className="pb-1">
                  <div className="px-3 pt-1 text-[10px] font-semibold text-[var(--text-muted)]">
                    {g.workspace_title}
                  </div>
                  {g.hits.slice(0, 4).map((h, i) => (
                    <button
                      key={`${g.workspace_id}-${h.item_id ?? h.ref_id ?? i}`}
                      type="button"
                      onClick={() => {
                        onClose();
                        navigate(
                          h.item_id
                            ? `/workspaces/${g.workspace_id}?item=${h.item_id}`
                            : `/workspaces/${g.workspace_id}`
                        );
                      }}
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition hover:bg-[var(--surface-2)]"
                    >
                      <span className="mt-0.5 shrink-0 rounded bg-[var(--surface-2)] px-1 py-0.5 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
                        {h.kind}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-[var(--text)]">
                          {h.title || "Untitled"}
                        </span>
                        {h.snippet && (
                          <span
                            className="search-snippet mt-0.5 line-clamp-1 block text-xs text-[var(--text-muted)]"
                            // ts_headline output: text + <mark> only.
                            dangerouslySetInnerHTML={{ __html: h.snippet }}
                          />
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className={cn(
            "flex items-center justify-between gap-3 border-t px-3 py-1.5 text-[10px]",
            "border-[var(--border)] text-[var(--text-muted)]"
          )}
        >
          <div className="flex items-center gap-2">
            <KeyHint label="↑↓" /> navigate
            <KeyHint label="⏎" /> open
            <KeyHint label="Esc" /> close
          </div>
          <span>Keyword + meaning · ranked</span>
        </div>
      </div>
    </div>
  );
}

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  hits: ConversationSearchHit[];
  baseIndex: number;
  cursor: number;
  onSelect: (hit: ConversationSearchHit) => void;
  onHover: (idx: number) => void;
}

function Section({
  label,
  icon,
  hits,
  baseIndex,
  cursor,
  onSelect,
  onHover,
}: SectionProps) {
  return (
    <div className="py-1">
      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium uppercase tracking-wider",
          "text-[var(--text-muted)]"
        )}
      >
        {icon}
        {label}
        <span className="text-[var(--text-muted)]/60">· {hits.length}</span>
      </div>
      {hits.map((hit, i) => {
        const idx = baseIndex + i;
        const active = idx === cursor;
        return (
          <button
            key={hit.message_id}
            type="button"
            data-idx={idx}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onSelect(hit)}
            className={cn(
              "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition",
              active
                ? "bg-[var(--accent)]/10 text-[var(--text)]"
                : "hover:bg-[var(--surface-2)]"
            )}
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="truncate">
                {hit.conversation_title || "Untitled chat"}
              </span>
              {hit.match === "semantic" && (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--accent)]/15 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-[var(--accent)]"
                  title="Found by meaning, not exact words"
                >
                  <Sparkles className="h-2.5 w-2.5" />
                  meaning
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">
                {formatRelative(hit.created_at)}
              </span>
            </div>
            <div
              className="text-[11px] leading-snug text-[var(--text-muted)]"
              // Content is the backend's ts_headline output with
              // ``[[HL]]…[[/HL]]`` markers. We rewrite those into
              // ``<mark>`` tags at render time *after* escaping the
              // rest of the snippet — so nothing the user typed can
              // land as raw HTML.
              dangerouslySetInnerHTML={{ __html: renderSnippet(hit.snippet) }}
            />
          </button>
        );
      })}
    </div>
  );
}

function KeyHint({ label }: { label: string }) {
  return (
    <kbd
      className={cn(
        "rounded border px-1 py-px font-mono text-[10px]",
        "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]"
      )}
    >
      {label}
    </kbd>
  );
}

/** Turn a ``ts_headline`` snippet into safe HTML:
 *    1. escape every character that could start an HTML tag
 *    2. rewrite the placeholder markers into ``<mark>`` tags
 *
 *  This is the only place in the app that uses
 *  ``dangerouslySetInnerHTML`` with user-derived content, so the
 *  escaping happens *before* the marker substitution — user text
 *  can never produce a literal ``<mark>`` tag through any value. */
function renderSnippet(raw: string): string {
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped
    .replace(/\[\[HL\]\]/g, '<mark class="rounded-sm bg-[var(--accent)]/25 px-0.5 text-[var(--text)]">')
    .replace(/\[\[\/HL\]\]/g, "</mark>");
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function extractError(e: unknown): string {
  if (typeof e === "object" && e && "response" in e) {
    const resp = (e as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  if (e instanceof Error) return e.message;
  return "Search failed.";
}
