import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CornerDownLeft,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  Search,
  Shapes,
  Sparkles,
} from "lucide-react";

import {
  workspacesApi,
  type WorkspaceAskCitation,
  type WorkspaceAskResponse,
  type WorkspaceItemNode,
} from "@/api/workspaces";
import { cn } from "@/utils/cn";
import { setPendingHighlight } from "./deepCitation";

/** Rewrite bare ``[n]`` citation markers into markdown links on a
 *  ``#ws-cite-n`` anchor so the renderer below can turn them into
 *  clickable jumps. Only indices that actually exist in the citation
 *  list are rewritten, and code spans / fences are left untouched so a
 *  literal ``[0]`` in a code sample doesn't become a link. */
function linkifyCitations(
  markdown: string,
  citations: WorkspaceAskCitation[]
): string {
  if (citations.length === 0) return markdown;
  const known = new Set(citations.map((c) => c.index));
  // Split out fenced blocks and inline code, transform the rest.
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[(\d{1,2})\]/g, (m, n) =>
            known.has(Number(n)) ? `[\\[${n}\\]](#ws-cite-${n})` : m
          )
    )
    .join("");
}

/** The grounded answer, rendered as real markdown. Inline ``[n]``
 *  markers become clickable and jump to the cited item, matching the
 *  source pills underneath. */
function AskAnswer({
  answer,
  onJump,
}: {
  answer: WorkspaceAskResponse;
  onJump: (itemId: string | null, snippet?: string | null) => void;
}) {
  const byIndex = useMemo(
    () => new Map(answer.citations.map((c) => [c.index, c])),
    [answer.citations]
  );
  const body = useMemo(
    () => linkifyCitations(answer.answer, answer.citations),
    [answer]
  );
  return (
    <div className="promptly-prose text-sm leading-relaxed text-[var(--text)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => {
            const cite = href?.match(/^#ws-cite-(\d+)$/);
            if (cite) {
              const c = byIndex.get(Number(cite[1]));
              return (
                <button
                  type="button"
                  disabled={!c?.item_id}
                  onClick={() => onJump(c?.item_id ?? null, c?.snippet)}
                  title={c ? (c.item_id ? `Open ${c.title}` : c.title) : undefined}
                  className={cn(
                    "mx-0.5 inline-flex -translate-y-[1px] items-center rounded-full border border-[var(--border)] px-1.5 text-[11px] font-medium no-underline",
                    c?.item_id
                      ? "text-[var(--accent)] hover:bg-[var(--hover)]"
                      : "cursor-default text-[var(--text-muted)]"
                  )}
                >
                  {c ? c.index : children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/**
 * ⌘K command palette for a workspace (Phase 3).
 *
 * Two things in one bar:
 *  - **Quick-switcher** — fuzzy-jump to any note / canvas / chat in the
 *    workspace (Obsidian's most-loved feature).
 *  - **Ask this workspace** — the top row runs a grounded Q&A across the
 *    whole workspace pool and renders a cited answer; clicking a citation
 *    jumps to the source item.
 */
interface FlatItem {
  node: WorkspaceItemNode;
  /** Breadcrumb of ancestor folder titles, for disambiguation. */
  path: string;
}

// ---------------------------------------------------------------------
// Recents — the empty-query palette shows what you touched last instead
// of an arbitrary tree slice. Plain localStorage (per workspace, newest
// first, small cap); ids that no longer resolve in the tree are ignored
// at read time, so stale entries age out harmlessly.
// ---------------------------------------------------------------------
const RECENTS_CAP = 8;
const recentsKey = (workspaceId: string) => `promptly.ws.recents.${workspaceId}`;

export function recordRecentItem(workspaceId: string, itemId: string): void {
  try {
    const key = recentsKey(workspaceId);
    const prev: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
    const next = [itemId, ...prev.filter((id) => id !== itemId)].slice(
      0,
      RECENTS_CAP
    );
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Quota/parse failures just mean no recents — never break selection.
  }
}

function readRecentIds(workspaceId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(recentsKey(workspaceId)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function flatten(
  nodes: WorkspaceItemNode[],
  trail: string[] = []
): FlatItem[] {
  const out: FlatItem[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      out.push(...flatten(node.children, [...trail, node.title]));
    } else {
      out.push({ node, path: trail.join(" / ") });
    }
  }
  return out;
}

function KindIcon({ kind }: { kind: WorkspaceItemNode["kind"] }) {
  const cls = "h-4 w-4 shrink-0 text-[var(--text-muted)]";
  if (kind === "canvas") return <Shapes className={cls} />;
  if (kind === "chat") return <MessageSquare className={cls} />;
  if (kind === "folder") return <Folder className={cls} />;
  return <FileText className={cls} />;
}

export function WorkspaceCommandPalette({
  workspaceId,
  tree,
  open,
  onClose,
  onSelectNode,
}: {
  workspaceId: string;
  tree: WorkspaceItemNode[];
  open: boolean;
  onClose: () => void;
  onSelectNode: (node: WorkspaceItemNode) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<WorkspaceAskResponse | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(() => flatten(tree), [tree]);
  const { results, recentCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Empty query: lead with what was opened last (``open`` is a dep so
      // reopening the palette re-reads localStorage).
      const byId = new Map(flat.map((f) => [f.node.id, f]));
      const recents = readRecentIds(workspaceId)
        .map((id) => byId.get(id))
        .filter((f): f is FlatItem => Boolean(f));
      const recentIds = new Set(recents.map((f) => f.node.id));
      const rest = flat.filter((f) => !recentIds.has(f.node.id));
      return {
        results: [...recents, ...rest].slice(0, 50),
        recentCount: recents.length,
      };
    }
    return {
      results: flat
        .filter(
          (f) =>
            f.node.title.toLowerCase().includes(q) ||
            f.path.toLowerCase().includes(q)
        )
        .slice(0, 50),
      recentCount: 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ``open`` only re-reads recents
  }, [flat, query, workspaceId, open]);

  // Reset everything each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setAnswer(null);
      setAskError(null);
      setAsking(false);
      // Focus after the element is painted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  const canAsk = query.trim().length > 0;
  // Row 0 is the "Ask" action when there's a query; items follow.
  const rowCount = (canAsk ? 1 : 0) + results.length;

  const runAsk = async () => {
    const q = query.trim();
    if (!q) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const res = await workspacesApi.ask(workspaceId, q);
      setAnswer(res);
    } catch {
      setAskError("Couldn't get an answer. Try again in a moment.");
    } finally {
      setAsking(false);
    }
  };

  const activate = (row: number) => {
    if (canAsk && row === 0) {
      void runAsk();
      return;
    }
    const item = results[row - (canAsk ? 1 : 0)];
    if (item) {
      onSelectNode(item.node);
      onClose();
    }
  };

  const jumpToCitation = (itemId: string | null, snippet?: string | null) => {
    if (!itemId) return;
    const match = flat.find((f) => f.node.id === itemId);
    if (match) {
      // Deep citation (4.2): hand the cited passage to the note pane so
      // it scrolls straight to it after opening.
      if (snippet && match.node.ref_id) {
        setPendingHighlight(match.node.ref_id, snippet);
      }
      onSelectNode(match.node);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(0, rowCount - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(cursor);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-card border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to an item, or ask this workspace…"
            className="flex-1 bg-transparent py-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>

        {/* Answer view takes over once an ask is in flight / done. */}
        {asking || answer || askError ? (
          <div className="max-h-[50vh] overflow-y-auto px-4 py-3">
            {asking && (
              <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Asking this workspace…
              </div>
            )}
            {askError && (
              <div className="rounded-card border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]">
                {askError}
              </div>
            )}
            {answer && (
              <div>
                <AskAnswer answer={answer} onJump={jumpToCitation} />
                {answer.citations.length > 0 && (
                  <div className="mt-3 border-t border-[var(--border)] pt-2">
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      Sources
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {answer.citations.map((c) => (
                        <button
                          key={c.index}
                          type="button"
                          disabled={!c.item_id}
                          onClick={() => jumpToCitation(c.item_id, c.snippet)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs",
                            c.item_id
                              ? "text-[var(--text)] hover:bg-[var(--hover)]"
                              : "cursor-default text-[var(--text-muted)]"
                          )}
                          title={c.item_id ? `Open ${c.title}` : c.title}
                        >
                          <span className="text-[var(--text-muted)]">
                            [{c.index}]
                          </span>
                          <span className="max-w-[12rem] truncate">
                            {c.title}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setAnswer(null);
                    setAskError(null);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  className="mt-3 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  ← Back to search
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Result list */
          <ul className="max-h-[50vh] overflow-y-auto py-1.5">
            {canAsk && (
              <li>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(0)}
                  onClick={() => activate(0)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                    cursor === 0 ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]"
                  )}
                >
                  <Sparkles className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                  <span className="flex-1 truncate text-[var(--text)]">
                    Ask this workspace:{" "}
                    <span className="text-[var(--text-muted)]">“{query.trim()}”</span>
                  </span>
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                </button>
              </li>
            )}
            {results.length === 0 && !canAsk && (
              <li className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                No items yet.
              </li>
            )}
            {results.map((f, i) => {
              const row = i + (canAsk ? 1 : 0);
              // Recents only exist on an empty query, so these labels never
              // collide with the "Ask …" row (which needs query text).
              const header =
                recentCount > 0 && i === 0
                  ? "Recent"
                  : recentCount > 0 && i === recentCount
                    ? "Everything else"
                    : null;
              return (
                <li key={f.node.id}>
                  {header && (
                    <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      {header}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(row)}
                    onClick={() => activate(row)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                      cursor === row
                        ? "bg-[var(--accent)]/10"
                        : "hover:bg-[var(--hover)]"
                    )}
                  >
                    <KindIcon kind={f.node.kind} />
                    <span className="flex-1 truncate text-[var(--text)]">
                      {f.node.title || "Untitled"}
                    </span>
                    {f.path && (
                      <span className="max-w-[10rem] shrink-0 truncate text-xs text-[var(--text-muted)]">
                        {f.path}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
