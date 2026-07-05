import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlignLeft,
  Columns3,
  FileText,
  Loader2,
  PenTool,
  Search,
  Sparkles,
  Table2,
  Type,
} from "lucide-react";

import {
  workspacesApi,
  type WorkspaceItemNode,
  type WorkspaceSearchHit,
} from "@/api/workspaces";
import { cn } from "@/utils/cn";
import { setPendingHighlight } from "./deepCitation";

/**
 * The workspace search pane (Batch 4.3) — one box over three passes:
 * item titles, Postgres full-text (with highlighted fragments), and
 * embedding similarity for meaning-matches that share no keywords.
 * Complements ⌘K (jump by title) and Ask (synthesised answer): search
 * shows *where things are said*.
 */
const KIND_ICON: Record<string, typeof FileText> = {
  note: FileText,
  canvas: PenTool,
  board: Columns3,
  sheet: Table2,
  file: FileText,
};

const SOURCE_META: Record<
  WorkspaceSearchHit["source"],
  { label: string; icon: typeof Type }
> = {
  title: { label: "Title matches", icon: Type },
  text: { label: "Found in content", icon: AlignLeft },
  semantic: { label: "Related by meaning", icon: Sparkles },
};

/** ts_headline output is trusted-ish (our own DB) but sanitise anyway:
 *  strip every tag except <mark>. */
function sanitizeSnippet(snippet: string): string {
  return snippet
    .replace(/<(?!\/?mark\b)[^>]*>/gi, "")
    .slice(0, 400);
}

export function WorkspaceSearchPane({
  workspaceId,
  onSelectNode,
}: {
  workspaceId: string;
  onSelectNode: (node: WorkspaceItemNode) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ["workspaces", "search", workspaceId, debounced],
    queryFn: () => workspacesApi.search(workspaceId, debounced),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  const hits = data?.hits ?? [];
  const groups = (["title", "text", "semantic"] as const)
    .map((source) => ({
      source,
      hits: hits.filter((h) => h.source === source),
    }))
    .filter((g) => g.hits.length > 0);

  const openHit = (h: WorkspaceSearchHit) => {
    if (!h.item_id) return; // pinned file without a tree item — v1 no-op
    // Deep citation (4.2): notes scroll straight to the matched passage.
    if (h.snippet && h.ref_id && h.kind === "note") {
      setPendingHighlight(h.ref_id, h.snippet);
    }
    onSelectNode({
      id: h.item_id,
      kind: h.kind as WorkspaceItemNode["kind"],
      ref_id: h.ref_id,
      title: h.title,
      icon: null,
      position: 0,
      indexing_status: null,
      children: [],
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 focus-within:border-[var(--accent)]">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this workspace — titles, content, and meaning…"
            className="flex-1 bg-transparent py-2.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {isFetching && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
          )}
        </div>
      </div>

      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl">
          {debounced.length < 2 ? (
            <p className="py-8 text-center text-sm text-[var(--text-muted)]">
              Type at least two characters. Results cover item titles, the
              full text of notes / canvases / sheets / boards / pinned
              files, and semantic matches when embeddings are set up.
            </p>
          ) : hits.length === 0 && !isFetching ? (
            <p className="py-8 text-center text-sm text-[var(--text-muted)]">
              Nothing found for “{debounced}”.
            </p>
          ) : (
            groups.map(({ source, hits: groupHits }) => {
              const meta = SOURCE_META[source];
              const GroupIcon = meta.icon;
              return (
                <section key={source} className="mb-6">
                  <h2 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    <GroupIcon className="h-3 w-3" />
                    {meta.label} · {groupHits.length}
                  </h2>
                  <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
                    {groupHits.map((h, i) => {
                      const KindIcon = KIND_ICON[h.kind] ?? FileText;
                      return (
                        <li key={`${h.item_id ?? h.ref_id}-${i}`}>
                          <button
                            type="button"
                            onClick={() => openHit(h)}
                            disabled={!h.item_id}
                            className={cn(
                              "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition",
                              h.item_id
                                ? "hover:bg-[var(--hover)]"
                                : "cursor-default opacity-70"
                            )}
                          >
                            <KindIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-[var(--text)]">
                                {h.title}
                              </span>
                              {h.snippet && (
                                <span
                                  className="search-snippet mt-0.5 line-clamp-2 block text-xs text-[var(--text-muted)]"
                                  // Sanitised to <mark>-only above.
                                  dangerouslySetInnerHTML={{
                                    __html: sanitizeSnippet(h.snippet),
                                  }}
                                />
                              )}
                            </span>
                            <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]/70">
                              {h.kind}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
          {debounced.length >= 2 &&
            data &&
            !data.semantic_available &&
            hits.length > 0 && (
              <p className="text-center text-[11px] text-[var(--text-muted)]/70">
                Semantic matching is off — an admin can configure an
                embedding model to enable it.
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
