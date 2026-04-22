import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { AtSign, FolderKanban, MessagesSquare } from "lucide-react";

import { chatApi, type MentionCandidate } from "@/api/chat";
import { cn } from "@/utils/cn";

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
  // Start of the ``@`` itself — m.index points at the preceding
  // whitespace when there is one, so add the length of the
  // leading whitespace group. Simplest path: scan back from caret.
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
  /** Current project id (if any) so same-project siblings surface
   *  first. Optional — standalone chats still get the generic
   *  recents section. */
  projectId: string | null;
  /** Parent uses this to intercept keystrokes (Up/Down/Enter/Esc)
   *  when the popover is open. Returns ``true`` if the key was
   *  consumed so the parent can ``preventDefault``. The handler
   *  only reads ``.key`` so either a DOM or React event works. */
  onKeyRegister: (
    handler: (e: { key: string }) => boolean
  ) => void;
}

/** Inline popover below the composer textarea that surfaces
 *  ``@``-mention candidates. Backed by the new ``/conversations/
 *  mention-candidates`` endpoint. Closes on caret leaving the
 *  trigger, Esc, click-outside, or successful insertion.
 *
 *  Kept in its own component so the ``InputBar`` stays focused on
 *  attachments + send logic rather than also owning popover state.
 */
export function MentionAutocomplete({
  textareaRef,
  value,
  caret,
  onInsert,
  currentConversationId,
  projectId,
  onKeyRegister,
}: MentionAutocompleteProps) {
  const pick = useMemo(
    () => detectMentionTrigger(value, caret),
    [value, caret]
  );

  const [results, setResults] = useState<{
    project: MentionCandidate[];
    recent: MentionCandidate[];
  }>({ project: [], recent: [] });
  const [highlighted, setHighlighted] = useState(0);
  const [fetching, setFetching] = useState(false);

  // Flat list of rows the keyboard cycles through, in render order.
  const flat = useMemo(
    () => [...results.project, ...results.recent],
    [results]
  );

  // Debounced fetch whenever the query string changes.
  useEffect(() => {
    if (!pick) {
      setResults({ project: [], recent: [] });
      setHighlighted(0);
      return;
    }
    let cancelled = false;
    const q = pick.query;
    // Tiny debounce so rapid typing doesn't fire a request per
    // keystroke. The backend endpoint is cheap but there's no
    // point hammering it either.
    const timer = window.setTimeout(async () => {
      setFetching(true);
      try {
        const data = await chatApi.mentionCandidates({
          q,
          projectId,
          excludeId: currentConversationId,
          limit: 12,
        });
        if (cancelled) return;
        setResults({
          project: data.project_candidates,
          recent: data.recent_candidates,
        });
        setHighlighted(0);
      } catch {
        if (!cancelled) {
          setResults({ project: [], recent: [] });
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pick?.query, projectId, currentConversationId, pick]);

  const insert = useCallback(
    (cand: MentionCandidate) => {
      if (!pick) return;
      // Escape square brackets in the title so they don't break
      // our ``@[title](id)`` shape. The resolver regex refuses any
      // ``]`` in the title group, so a stray bracket would produce
      // a broken token the backend would silently ignore.
      const safeTitle = cand.title.replace(/\[/g, "(").replace(/\]/g, ")");
      const token = `@[${safeTitle}](${cand.id})`;
      onInsert(token, pick);
    },
    [pick, onInsert]
  );

  // Register a keyboard handler with the parent so we can hijack
  // Up/Down/Enter/Tab/Esc while the popover is open. Returning
  // ``true`` means "handled — parent should preventDefault".
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
          const cand = flat[highlighted];
          if (cand) {
            insert(cand);
            return true;
          }
          return false;
        }
        case "Escape":
          // Clearing query manually is the parent's job — it holds
          // the textarea state. We just mark the key as handled so
          // the parent can call preventDefault + detect "popover
          // dismissed" via a subsequent ``pick === null`` render.
          // For now the simplest escape is: shift focus away. The
          // popover closes naturally when the caret isn't in a
          // mention context anymore. Returning ``false`` lets the
          // browser's default Esc behaviour run; returning ``true``
          // here would swallow Esc without actually closing
          // anything. So we pick ``true`` and let the parent
          // dismiss via a blur-then-refocus trick.
          return true;
        default:
          return false;
      }
    });
    // Re-register on every render so the closure captures the
    // latest ``highlighted`` / ``flat`` / ``pick``.
  }, [pick, flat, highlighted, onKeyRegister, insert]);

  if (!pick) return null;

  const empty = flat.length === 0 && !fetching;

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 right-0 mx-auto mb-2 max-w-3xl px-4"
      )}
    >
      <div
        role="listbox"
        aria-label="Reference another conversation"
        className={cn(
          "max-h-72 overflow-y-auto rounded-card border shadow-lg",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
          <AtSign className="h-3 w-3" />
          <span>
            Reference a chat —{" "}
            <span className="font-mono text-[var(--text)]">
              {pick.query ? `@${pick.query}` : "type to search"}
            </span>
          </span>
          {fetching && <span className="ml-auto text-[10px]">Searching...</span>}
        </div>
        {empty && (
          <div className="px-3 py-4 text-xs text-[var(--text-muted)]">
            {pick.query
              ? `No chats matching "${pick.query}".`
              : "No other chats yet."}
          </div>
        )}
        {results.project.length > 0 && (
          <CandidateGroup
            heading="In this project"
            candidates={results.project}
            offset={0}
            highlighted={highlighted}
            setHighlighted={setHighlighted}
            onPick={insert}
            textareaRef={textareaRef}
          />
        )}
        {results.recent.length > 0 && (
          <CandidateGroup
            heading={
              results.project.length > 0 ? "Other recent chats" : "Recent chats"
            }
            candidates={results.recent}
            offset={results.project.length}
            highlighted={highlighted}
            setHighlighted={setHighlighted}
            onPick={insert}
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
  // Keep focus on the textarea when clicking a candidate —
  // otherwise the blur would close the popover before the click
  // lands and the pick would be lost.
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
              {c.project_title && (
                <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <FolderKanban className="h-2.5 w-2.5" />
                  {c.project_title}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
