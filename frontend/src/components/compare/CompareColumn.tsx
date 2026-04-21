import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crown, Loader2, User as UserIcon, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { chatApi } from "@/api/chat";
import { authHeader } from "@/api/client";
import type { ChatMessage } from "@/api/types";
import { cn } from "@/utils/cn";

/**
 * A single column of a compare view. Owns:
 *
 *   * A local message list (seeded from ``GET /conversations/{id}``),
 *   * An optional in-flight SSE stream (``streamId``) that the parent
 *     hands down when a send fans out to this column,
 *   * Render of a minimal assistant bubble thread. No regen, no
 *     branch, no tools — those are disabled in compare mode by
 *     design (see backend module docstring).
 *
 * Keeping the state local (rather than in the global chat store) is
 * deliberate: the global store assumes a single active conversation,
 * and compare mode runs 2–4 conversations in parallel. A per-column
 * local-state approach avoids leaking pre-crown drafts into the
 * sidebar/store and keeps each stream isolated.
 */

interface Props {
  conversationId: string;
  headerLabel: string; // e.g. "Claude Sonnet 4 · Anthropic"
  isCrowned: boolean;
  crownDisabled: boolean;
  onCrown: () => void;
  // When non-null the column is actively streaming. The parent
  // obtains stream ids from ``POST /compare/groups/{id}/send`` and
  // passes one per column.
  activeStreamId: string | null;
  onStreamEnded: () => void;
}

export function CompareColumn({
  conversationId,
  headerLabel,
  isCrowned,
  crownDisabled,
  onCrown,
  activeStreamId,
  onStreamEnded,
}: Props) {
  // Load the persisted message list for this column. The parent
  // invalidates this query via the TanStack client whenever a fresh
  // stream ends, so new assistant turns show up automatically.
  const {
    data: detail,
    isLoading,
  } = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => chatApi.get(conversationId),
  });

  const persistedMessages: ChatMessage[] = useMemo(
    () => detail?.messages ?? [],
    [detail]
  );

  // Streaming state — plain local state since only this column cares.
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ``onStreamEnded`` is typically a non-memoised arrow function from
  // the parent (``() => parentOnStreamEnded(col.conversation_id)``),
  // so its identity changes on every CompareRun render. If we put
  // that in the effect deps we'd abort + re-open the SSE on every
  // parent render, which in turn re-subscribes to the same session
  // tens of times in a row. After the backend's completed-session
  // TTL (180 s) or Redis ctx TTL (60 s) expires, a re-subscribe
  // surfaces as "Stream not found or expired" — the failure the
  // user was hitting. The ref dodges the issue entirely: the effect
  // re-runs only when the stream id actually changes, but always
  // calls the latest parent callback.
  const onStreamEndedRef = useRef(onStreamEnded);
  useEffect(() => {
    onStreamEndedRef.current = onStreamEnded;
  }, [onStreamEnded]);

  useEffect(() => {
    if (!activeStreamId) {
      setStreamingContent("");
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setStreamError(null);
    setStreamingContent("");

    const run = async () => {
      try {
        const resp = await fetch(chatApi.streamUrl(activeStreamId), {
          headers: {
            Accept: "text/event-stream",
            ...authHeader(),
          },
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(
            `Stream failed (${resp.status}). The column is out of sync.`
          );
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        let accumulated = "";
        while (!ac.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLines: string[] = [];
            for (const line of raw.split("\n")) {
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).replace(/^ /, ""));
              }
            }
            if (!dataLines.length) continue;
            try {
              const payload = JSON.parse(dataLines.join("\n")) as {
                event?: string;
                delta?: string;
                done?: boolean;
                error?: string;
              };
              if (payload.event === "error" || payload.error) {
                setStreamError(
                  payload.error || "The model couldn't respond. Try again."
                );
                break;
              }
              if (payload.delta) {
                accumulated += payload.delta;
                setStreamingContent(accumulated);
              }
              if (payload.event === "done" || payload.done) {
                // Let the parent refetch the conversation so the
                // persisted assistant row replaces the in-flight
                // streaming bubble.
                onStreamEndedRef.current();
                return;
              }
            } catch {
              // Swallow malformed chunks — they're never
              // load-bearing for the visible text.
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setStreamError((e as Error).message || "Streaming failed.");
        }
      }
    };
    void run();

    return () => {
      ac.abort();
    };
  }, [activeStreamId]);

  const showStreamingBubble =
    Boolean(activeStreamId) && (streamingContent.length > 0 || !streamError);

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border",
        "border-[var(--border)] bg-[var(--surface)]",
        isCrowned && "ring-2 ring-[var(--accent)] ring-offset-0"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2 text-xs",
          "border-[var(--border)]"
        )}
      >
        <div className="min-w-0 flex-1 truncate font-semibold text-[var(--text)]">
          {headerLabel}
        </div>
        <button
          type="button"
          onClick={onCrown}
          disabled={crownDisabled}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition",
            isCrowned
              ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
              : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/60 hover:text-[var(--text)]",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          title={
            isCrowned
              ? "This column is the current pick"
              : "Pick this response as the winner"
          }
        >
          <Crown className="h-3 w-3" />
          {isCrowned ? "Crowned" : "Crown"}
        </button>
      </div>

      <div className="promptly-scroll flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {isLoading && persistedMessages.length === 0 && (
          <div className="flex items-center justify-center py-6 text-xs text-[var(--text-muted)]">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            Loading…
          </div>
        )}

        {persistedMessages.map((m) => (
          <MinimalBubble key={m.id} role={m.role} content={m.content} />
        ))}

        {showStreamingBubble && (
          <MinimalBubble
            role="assistant"
            content={streamingContent}
            streaming
          />
        )}

        {streamError && (
          <div
            className={cn(
              "rounded-md border px-2 py-1.5 text-[11px]",
              "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
            )}
          >
            {streamError}
          </div>
        )}

        {!isLoading && persistedMessages.length === 0 && !showStreamingBubble && (
          <div className="py-6 text-center text-[11px] text-[var(--text-muted)]">
            Waiting for the first prompt…
          </div>
        )}
      </div>
    </div>
  );
}

function MinimalBubble({
  role,
  content,
  streaming,
}: {
  role: ChatMessage["role"];
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  if (role === "system") return null; // don't render system rows in compare view

  return (
    <div
      className={cn(
        "flex items-start gap-2",
        isUser && "justify-end"
      )}
    >
      {!isUser && (
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "bg-[var(--accent)] text-white"
          )}
        >
          <Sparkles className="h-3 w-3" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[92%] rounded-lg border px-2.5 py-1.5 text-xs leading-relaxed",
          isUser
            ? "border-[var(--accent)]/40 bg-[var(--accent)]/10"
            : "border-[var(--border)] bg-[var(--bg)]"
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{content}</div>
        ) : (
          <div className="prose prose-sm max-w-none dark:prose-invert [&_p]:my-1 [&_pre]:my-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content || "…"}
            </ReactMarkdown>
            {streaming && (
              <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-[var(--text)]/50" />
            )}
          </div>
        )}
      </div>
      {isUser && (
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "bg-[var(--accent)]/20 text-[var(--accent)]"
          )}
        >
          <UserIcon className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}
