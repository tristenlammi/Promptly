import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search, X } from "lucide-react";

import { useConversationSearchQuery } from "@/hooks/useConversations";
import { cn } from "@/utils/cn";
import type { ConversationSearchHit } from "@/api/types";

/** Sidebar full-text search across the user's conversation history.
 *
 *  Behaviour:
 *  - 200ms debounce on keystroke -> avoids one fetch per character.
 *  - Empty / single whitespace input collapses the result panel back
 *    to the normal conversation list (parent handles via ``onActive``).
 *  - Clicking a hit navigates to ``/chat/<conv>#m-<msg>`` so ChatPage
 *    can scroll the bubble into view + briefly highlight it.
 *  - Esc clears the box and returns focus to it for fast iteration.
 */
interface Props {
  /** Tells the parent sidebar whether to render the conversation list
   *  or step aside for the search results panel. */
  onActive: (active: boolean) => void;
}

export function ConversationSearchBox({ onActive }: Props) {
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce — re-runs when ``raw`` changes; cancels in-flight timer
  // on every keystroke so only the last value 200ms after typing
  // stops actually triggers a fetch.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(raw), 200);
    return () => window.clearTimeout(t);
  }, [raw]);

  const trimmed = debounced.trim();
  const { data, isFetching, isError } = useConversationSearchQuery(trimmed);
  const active = trimmed.length > 0;

  // Bubble the active state to the sidebar so it can hide the normal
  // conversation list while the search panel is showing. Uses an
  // effect so the parent doesn't render mid-update.
  useEffect(() => {
    onActive(active);
  }, [active, onActive]);

  return (
    <div className="px-3 pb-2">
      <div
        className={cn(
          "flex items-center gap-2 rounded-input border px-2 py-1.5",
          "border-[var(--border)] bg-[var(--surface-2,transparent)]",
          "focus-within:border-[var(--accent)]/60"
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <input
          ref={inputRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setRaw("");
              setDebounced("");
              inputRef.current?.focus();
            }
          }}
          placeholder="Search messages…"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
          aria-label="Search across all conversations"
        />
        {isFetching && active ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--text-muted)]" />
        ) : raw ? (
          <button
            type="button"
            onClick={() => {
              setRaw("");
              setDebounced("");
              inputRef.current?.focus();
            }}
            className="rounded p-0.5 text-[var(--text-muted)] hover:bg-black/[0.06] hover:text-[var(--text)] dark:hover:bg-white/[0.08]"
            aria-label="Clear search"
            title="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      {active && (
        <SearchResults
          hits={data ?? []}
          loading={isFetching && !data}
          isError={isError}
          query={trimmed}
        />
      )}
    </div>
  );
}

/** Render a ts_headline snippet safely. The backend wraps matched
 *  terms in literal ``[[HL]]…[[/HL]]`` markers (chosen because they
 *  can't appear in HTML by accident). We split on those markers and
 *  emit React text + ``<mark>`` nodes so the user-typed content
 *  stays text-content and never goes through dangerouslySetInnerHTML. */
function renderSnippet(snippet: string): React.ReactNode {
  if (!snippet) return null;
  const parts = snippet.split(/\[\[\/?HL\]\]/g);
  // After splitting on both opening and closing markers, even-index
  // parts are unhighlighted text and odd-index parts are highlighted
  // matches. ts_headline always pairs StartSel/StopSel so this stays
  // in sync; a malformed run just degrades to grey text.
  return parts.map((piece, idx) =>
    idx % 2 === 1 ? <mark key={idx}>{piece}</mark> : <span key={idx}>{piece}</span>
  );
}

function SearchResults({
  hits,
  loading,
  isError,
  query,
}: {
  hits: ConversationSearchHit[];
  loading: boolean;
  isError: boolean;
  query: string;
}) {
  const navigate = useNavigate();

  // Group hits by conversation so a chat that matched five times
  // doesn't dominate the panel. Order is preserved from the API
  // (which already sorts by ts_rank desc).
  const grouped = useMemo(() => {
    const out = new Map<string, { title: string | null; rows: ConversationSearchHit[] }>();
    for (const h of hits) {
      const existing = out.get(h.conversation_id);
      if (existing) {
        existing.rows.push(h);
      } else {
        out.set(h.conversation_id, {
          title: h.conversation_title,
          rows: [h],
        });
      }
    }
    return out;
  }, [hits]);

  if (loading) {
    return (
      <div className="mt-2 px-2 text-xs text-[var(--text-muted)]">
        Searching…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-2 px-2 text-xs text-red-500">
        Search failed. Try again in a moment.
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="mt-2 px-2 text-xs text-[var(--text-muted)]">
        No matches for &ldquo;{query}&rdquo;.
      </div>
    );
  }

  return (
    <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto pr-1 promptly-scroll">
      {Array.from(grouped.entries()).map(([convId, group]) => (
        <div key={convId}>
          <div className="mb-1 truncate px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {group.title?.trim() || "Untitled chat"}
          </div>
          <div className="flex flex-col gap-1">
            {group.rows.map((hit) => (
              <button
                key={hit.message_id}
                type="button"
                onClick={() => navigate(`/chat/${convId}#m-${hit.message_id}`)}
                className={cn(
                  "rounded-md border border-transparent px-2 py-1.5 text-left text-xs",
                  "text-[var(--text)] transition",
                  "hover:border-[var(--border)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                )}
              >
                <div className="mb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {hit.role === "user" ? "You" : "Assistant"}
                </div>
                <div className="promptly-search-snippet leading-snug text-[var(--text)]">
                  {renderSnippet(hit.snippet)}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
