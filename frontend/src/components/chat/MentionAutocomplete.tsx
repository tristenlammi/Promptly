import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { AtSign, FileText, LayoutGrid, MessagesSquare, Plug } from "lucide-react";

import {
  chatApi,
  type MentionCandidate,
  type MentionConnectorCandidate,
} from "@/api/chat";
import { filesApi } from "@/api/files";
import { cn } from "@/utils/cn";

/** Minimal file shape the popover needs — works for both a global Drive
 *  ``FileItem`` and a workspace-scoped ``MentionFileCandidate``. */
type MentionFile = {
  id: string;
  filename: string;
  kind?: string;
  mime_type?: string;
};

/** Pattern we detect in the textarea to trigger the popover.
 *  Matches ``@<query>`` where ``@`` sits at the start of input
 *  or after whitespace / a newline, and the query is the current
 *  run of non-whitespace characters up to the cursor. An empty
 *  query (just ``@``) is a valid trigger — we show recents as
 *  soon as the symbol is typed. */
const TRIGGER_RE = /(?:^|\s)@([^\s@\[\]()\n]{0,30})$/;

export interface MentionPickState {
  /** The raw query text after ``@`` — may be empty. */
  query: string;
  /** Index in the textarea where ``@`` sits. */
  startIndex: number;
  /** Cursor position at trigger time (end of query). */
  endIndex: number;
}

/** A single selectable row — either another chat or a Drive file. The
 *  kind discriminator drives both the inserted token shape and the
 *  icon / navigation behaviour of the rendered chip. */
type MentionRow =
  | { kind: "chat"; cand: MentionCandidate }
  | { kind: "file"; file: MentionFile }
  | { kind: "connector"; connector: MentionConnectorCandidate };

/** Detect an active ``@``-mention trigger in ``text`` given the
 *  current caret position. Returns ``null`` if the caret isn't in
 *  a mention context (no ``@`` before it, or a whitespace in the
 *  way, or the caret sits inside an already-resolved token). */
export function detectMentionTrigger(
  text: string,
  caret: number
): MentionPickState | null {
  if (caret < 1) return null;
  const before = text.slice(0, caret);
  const m = TRIGGER_RE.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  const atIndex = before.lastIndexOf("@", caret - 1);
  if (atIndex < 0) return null;
  return {
    query,
    startIndex: atIndex,
    endIndex: caret,
  };
}

interface MentionAutocompleteProps {
  /** Anchor — the textarea whose content / caret we track. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Current textarea value (controlled in the parent). */
  value: string;
  /** Caret position in ``value`` — re-read on every change / key. */
  caret: number;
  /** Called when the user picks a candidate. The parent replaces
   *  the in-progress ``@query`` with the returned token ``+ " "``. */
  onInsert: (token: string, pick: MentionPickState) => void;
  /** Current conversation id so the backend can exclude it from
   *  candidates (users shouldn't @-mention themselves). */
  currentConversationId: string | null;
  /** Current workspace id (if any) so same-workspace siblings surface
   *  first. Optional — standalone chats still get the generic
   *  recents section. */
  workspaceId: string | null;
  /** Parent uses this to intercept keystrokes (Up/Down/Enter/Esc)
   *  when the popover is open. */
  onKeyRegister: (handler: (e: { key: string }) => boolean) => void;
}

/** Inline popover below the composer that surfaces ``@``-mention
 *  candidates — other chats (resolved to a summary server-side) and
 *  Drive files (resolved to their text content server-side). Closes
 *  on caret leaving the trigger, Esc, click-outside, or insertion. */
export function MentionAutocomplete({
  textareaRef,
  value,
  caret,
  onInsert,
  currentConversationId,
  workspaceId,
  onKeyRegister,
}: MentionAutocompleteProps) {
  const pick = useMemo(
    () => detectMentionTrigger(value, caret),
    [value, caret]
  );

  const [results, setResults] = useState<{
    workspace: MentionCandidate[];
    recent: MentionCandidate[];
    files: MentionFile[];
    connectors: MentionConnectorCandidate[];
  }>({ workspace: [], recent: [], files: [], connectors: [] });
  const [highlighted, setHighlighted] = useState(0);
  const [fetching, setFetching] = useState(false);

  // Flat list of rows the keyboard cycles through, in render order.
  const flat = useMemo<MentionRow[]>(
    () => [
      ...results.workspace.map((c) => ({ kind: "chat" as const, cand: c })),
      ...results.recent.map((c) => ({ kind: "chat" as const, cand: c })),
      ...results.files.map((f) => ({ kind: "file" as const, file: f })),
      ...results.connectors.map((c) => ({
        kind: "connector" as const,
        connector: c,
      })),
    ],
    [results]
  );

  // Debounced fetch whenever the query string changes. Chats and
  // files are fetched in parallel; a blank query browses recents of
  // both so the popover is useful the instant ``@`` is typed.
  useEffect(() => {
    if (!pick) {
      setResults({ workspace: [], recent: [], files: [], connectors: [] });
      setHighlighted(0);
      return;
    }
    let cancelled = false;
    const q = pick.query;
    const timer = window.setTimeout(async () => {
      setFetching(true);
      // Inside a workspace, ``@`` is scoped to that workspace: only its
      // chats + its files/notes/canvases (all from the mention endpoint).
      // Outside a workspace, browse the user's recents + whole Drive.
      const globalFilesPromise = (async (): Promise<MentionFile[]> => {
        if (workspaceId) return []; // workspace files come from the endpoint
        const qq = q.trim();
        if (!qq) {
          return (await filesApi.listRecent("mine", 6)).files;
        }
        const [searchR, recentR] = await Promise.allSettled([
          filesApi.search(qq, "mine", 6),
          filesApi.listRecent("mine", 50),
        ]);
        const byId = new Map<string, MentionFile>();
        if (searchR.status === "fulfilled") {
          for (const h of searchR.value.hits) byId.set(h.file.id, h.file);
        }
        if (recentR.status === "fulfilled") {
          const ql = qq.toLowerCase();
          for (const f of recentR.value.files) {
            if (!byId.has(f.id) && f.filename.toLowerCase().includes(ql)) {
              byId.set(f.id, f);
            }
          }
        }
        return Array.from(byId.values()).slice(0, 6);
      })();
      const [chats, gfiles] = await Promise.allSettled([
        chatApi.mentionCandidates({
          q,
          workspaceId,
          excludeId: currentConversationId,
          limit: 8,
        }),
        globalFilesPromise,
      ]);
      if (cancelled) return;
      const chatVal = chats.status === "fulfilled" ? chats.value : null;
      setResults({
        workspace: chatVal ? chatVal.workspace_candidates : [],
        // Suppress the workspace-agnostic recents when composing inside a
        // workspace — references should stay within it.
        recent: chatVal && !workspaceId ? chatVal.recent_candidates : [],
        files: workspaceId
          ? (chatVal?.workspace_file_candidates ?? []).map((f) => ({
              id: f.id,
              filename: f.filename,
              kind: f.kind,
            }))
          : gfiles.status === "fulfilled"
            ? gfiles.value
            : [],
        connectors: chatVal?.connector_candidates ?? [],
      });
      setHighlighted(0);
      setFetching(false);
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pick?.query, workspaceId, currentConversationId, pick]);

  const insert = useCallback(
    (row: MentionRow) => {
      if (!pick) return;
      const title =
        row.kind === "chat"
          ? row.cand.title
          : row.kind === "file"
            ? row.file.filename
            : row.connector.name;
      // Escape square brackets so they don't break the ``@[title](id)``
      // shape the resolver regex expects.
      const safeTitle = (title || "Untitled").replace(/\[/g, "(").replace(/\]/g, ")");
      // Files carry a ``file:`` prefix and connectors a ``connector:``
      // prefix so the backend resolver (and the chip renderer) can tell
      // the three reference kinds apart.
      const id =
        row.kind === "chat"
          ? row.cand.id
          : row.kind === "file"
            ? `file:${row.file.id}`
            : `connector:${row.connector.id}`;
      const token = `@[${safeTitle}](${id})`;
      onInsert(token, pick);
    },
    [pick, onInsert]
  );

  useEffect(() => {
    onKeyRegister((e: { key: string }) => {
      if (!pick) return false;
      if (flat.length === 0 && e.key !== "Escape") return false;
      switch (e.key) {
        case "ArrowDown":
          setHighlighted((h) => (h + 1) % Math.max(flat.length, 1));
          return true;
        case "ArrowUp":
          setHighlighted(
            (h) => (h - 1 + Math.max(flat.length, 1)) % Math.max(flat.length, 1)
          );
          return true;
        case "Enter":
        case "Tab": {
          const row = flat[highlighted];
          if (row) {
            insert(row);
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
  }, [pick, flat, highlighted, onKeyRegister, insert]);

  if (!pick) return null;

  const empty = flat.length === 0 && !fetching;
  const fileOffset = results.workspace.length + results.recent.length;
  const connectorOffset = fileOffset + results.files.length;

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 right-0 mx-auto mb-2 max-w-3xl px-4"
      )}
    >
      <div
        role="listbox"
        aria-label="Reference a chat, file or connector"
        className={cn(
          "max-h-72 overflow-y-auto rounded-card border shadow-lg",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
          <AtSign className="h-3 w-3" />
          <span>
            Reference a chat, file or connector —{" "}
            <span className="font-mono text-[var(--text)]">
              {pick.query ? `@${pick.query}` : "type to search"}
            </span>
          </span>
          {fetching && <span className="ml-auto text-[10px]">Searching...</span>}
        </div>
        {empty && (
          <div className="px-3 py-4 text-xs text-[var(--text-muted)]">
            {pick.query
              ? `Nothing matching "${pick.query}".`
              : "No chats or files yet."}
          </div>
        )}
        {results.workspace.length > 0 && (
          <CandidateGroup
            heading="In this workspace"
            candidates={results.workspace}
            offset={0}
            highlighted={highlighted}
            setHighlighted={setHighlighted}
            onPick={(c) => insert({ kind: "chat", cand: c })}
            textareaRef={textareaRef}
          />
        )}
        {results.recent.length > 0 && (
          <CandidateGroup
            heading={
              results.workspace.length > 0 ? "Other recent chats" : "Recent chats"
            }
            candidates={results.recent}
            offset={results.workspace.length}
            highlighted={highlighted}
            setHighlighted={setHighlighted}
            onPick={(c) => insert({ kind: "chat", cand: c })}
            textareaRef={textareaRef}
          />
        )}
        {results.files.length > 0 && (
          <FileGroup
            heading={
              workspaceId
                ? "Workspace notes, canvases & files"
                : pick.query
                  ? "Files"
                  : "Recent files"
            }
            files={results.files}
            offset={fileOffset}
            highlighted={highlighted}
            setHighlighted={setHighlighted}
            onPick={(f) => insert({ kind: "file", file: f })}
            textareaRef={textareaRef}
          />
        )}
        {results.connectors.length > 0 && (
          <ConnectorGroup
            heading="Connectors"
            connectors={results.connectors}
            offset={connectorOffset}
            highlighted={highlighted}
            setHighlighted={setHighlighted}
            onPick={(c) => insert({ kind: "connector", connector: c })}
            textareaRef={textareaRef}
          />
        )}
        <div className="border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
          ↑↓ navigate · Enter or Tab to insert · Esc to close
        </div>
      </div>
    </div>
  );
}

interface CandidateGroupProps {
  heading: string;
  candidates: MentionCandidate[];
  offset: number;
  highlighted: number;
  setHighlighted: (i: number) => void;
  onPick: (c: MentionCandidate) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

function CandidateGroup({
  heading,
  candidates,
  offset,
  highlighted,
  setHighlighted,
  onPick,
  textareaRef,
}: CandidateGroupProps) {
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    textareaRef.current?.focus();
  };
  return (
    <div className="py-1">
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {heading}
      </div>
      {candidates.map((c, i) => {
        const globalIndex = offset + i;
        const active = globalIndex === highlighted;
        return (
          <button
            key={c.id}
            role="option"
            aria-selected={active}
            onMouseDown={keepFocus}
            onClick={() => onPick(c)}
            onMouseEnter={() => setHighlighted(globalIndex)}
            className={cn(
              "flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition",
              active
                ? "bg-[var(--accent)]/10 text-[var(--text)]"
                : "text-[var(--text-muted)] hover:bg-[var(--accent)]/5 hover:text-[var(--text)]"
            )}
          >
            <MessagesSquare
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                active ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-[var(--text)]">
                {c.title || "Untitled chat"}
              </span>
              {c.workspace_title && (
                <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <LayoutGrid className="h-2.5 w-2.5" />
                  {c.workspace_title}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface ConnectorGroupProps {
  heading: string;
  connectors: MentionConnectorCandidate[];
  offset: number;
  highlighted: number;
  setHighlighted: (i: number) => void;
  onPick: (c: MentionConnectorCandidate) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

function ConnectorGroup({
  heading,
  connectors,
  offset,
  highlighted,
  setHighlighted,
  onPick,
  textareaRef,
}: ConnectorGroupProps) {
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    textareaRef.current?.focus();
  };
  return (
    <div className="py-1">
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {heading}
      </div>
      {connectors.map((c, i) => {
        const globalIndex = offset + i;
        const active = globalIndex === highlighted;
        return (
          <button
            key={c.id}
            role="option"
            aria-selected={active}
            onMouseDown={keepFocus}
            onClick={() => onPick(c)}
            onMouseEnter={() => setHighlighted(globalIndex)}
            className={cn(
              "flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition",
              active
                ? "bg-[var(--accent)]/10 text-[var(--text)]"
                : "text-[var(--text-muted)] hover:bg-[var(--accent)]/5 hover:text-[var(--text)]"
            )}
          >
            <Plug
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                active ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-[var(--text)]">
                {c.name}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                {c.tool_count} tool{c.tool_count === 1 ? "" : "s"}
                {c.kind !== "mcp" ? ` · ${c.kind}` : ""}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface FileGroupProps {
  heading: string;
  files: MentionFile[];
  offset: number;
  highlighted: number;
  setHighlighted: (i: number) => void;
  onPick: (f: MentionFile) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

function FileGroup({
  heading,
  files,
  offset,
  highlighted,
  setHighlighted,
  onPick,
  textareaRef,
}: FileGroupProps) {
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    textareaRef.current?.focus();
  };
  return (
    <div className="py-1">
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {heading}
      </div>
      {files.map((f, i) => {
        const globalIndex = offset + i;
        const active = globalIndex === highlighted;
        return (
          <button
            key={f.id}
            role="option"
            aria-selected={active}
            onMouseDown={keepFocus}
            onClick={() => onPick(f)}
            onMouseEnter={() => setHighlighted(globalIndex)}
            className={cn(
              "flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition",
              active
                ? "bg-[var(--accent)]/10 text-[var(--text)]"
                : "text-[var(--text-muted)] hover:bg-[var(--accent)]/5 hover:text-[var(--text)]"
            )}
          >
            <FileText
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0",
                active ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-[var(--text)]">
                {f.filename}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                {f.kind ?? f.mime_type}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
