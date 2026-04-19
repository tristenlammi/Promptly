import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Eye, X } from "lucide-react";

import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { cn } from "@/utils/cn";
import type { ConversationParticipant } from "@/api/types";

import { MessageBubble } from "./MessageBubble";
import { ThinkingBubble } from "./ThinkingBubble";

interface ChatWindowProps {
  /** Edit-and-resend hook for the most recent user message. When omitted
   *  (e.g. on a brand-new conversation page that hasn't created a chat
   *  yet), the pencil affordance is hidden entirely. */
  onEditAndResend?: (messageId: string, newText: string) => Promise<void>;
  /** Phase 4b — owner + accepted collaborators on the active chat.
   *  When set (i.e. >1 participant), MessageBubble renders "from
   *  Jane" chips so it's clear who said what. ``null`` for solo
   *  chats so the chip is hidden entirely. */
  participants?: ConversationParticipant[] | null;
  /** Phase 4c — branching action. When provided, every persisted
   *  message gets a "Branch" hover affordance that forks a new
   *  conversation up to and including that message. Omitted on new
   *  chats (no conversation id to branch from yet). */
  onBranchFrom?: (messageId: string) => Promise<void> | void;
}

export function ChatWindow({
  onEditAndResend,
  participants,
  onBranchFrom,
}: ChatWindowProps) {
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingSources = useChatStore((s) => s.streamingSources);
  const streamingAttachments = useChatStore((s) => s.streamingAttachments);
  const toolInvocations = useChatStore((s) => s.toolInvocations);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamError = useChatStore((s) => s.streamError);
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const messagesCountRef = useRef(messages.length);
  // Tracks which conversation we've already snapped to the bottom for.
  // ``null`` means "no conversation initialised yet" — set to the
  // active id once we've performed the on-open scroll so it doesn't
  // re-fire on every subsequent message append.
  const initialScrolledForRef = useRef<string | null>(null);

  // Distance in px from the bottom under which we consider the user
  // "parked at the latest". Used purely to decide pill visibility —
  // we deliberately do NOT auto-follow the streaming tail (the user
  // explicitly wants the viewport to stay static while tokens land
  // so they can read at their own pace).
  const atBottomThreshold = 96;

  const isAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < atBottomThreshold;
  }, []);

  // Refresh the "Jump to latest" pill on real scroll events from the
  // user. The pill is only ever surfaced while a stream is in flight
  // — outside of streaming there's nothing new to jump to.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setShowJumpToLatest((prev) => {
        const next = !isAtBottom() && isStreaming;
        return prev === next ? prev : next;
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [isStreaming, isAtBottom]);

  // When the user opens (or switches to) a conversation, snap the
  // viewport to the bottom so the latest exchange is visible. We
  // gate on activeId so we only do this once per conversation —
  // appending new messages later in the same chat is handled by the
  // separate user-submit effect below. The messages.length check
  // covers the async load: activeId flips first, then messages arrive
  // a tick later. We wait for the second event before scrolling so
  // the DOM actually has the bubbles to scroll past.
  useEffect(() => {
    if (!activeId) {
      initialScrolledForRef.current = null;
      return;
    }
    if (initialScrolledForRef.current === activeId) return;
    if (messages.length === 0) return;
    initialScrolledForRef.current = activeId;
    // Sync snap to avoid a visible scroll animation on chat open;
    // messages.length is "right" by this point so set the count ref
    // accordingly so the user-submit effect doesn't double-scroll.
    messagesCountRef.current = messages.length;
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
  }, [activeId, messages.length]);

  // When the user submits a message, scroll their fresh bubble to the
  // top of the viewport rather than to the bottom. That way the AI
  // reply has visible room below it to render into, and we never have
  // to auto-follow the tail. (ChatGPT uses this same pattern.)
  // Assistant message persistence — i.e. the turn finalizing — is
  // intentionally a no-op: the user has been reading at their own
  // pace and we won't yank them around.
  useEffect(() => {
    if (messages.length <= messagesCountRef.current) {
      messagesCountRef.current = messages.length;
      return;
    }
    const last = messages[messages.length - 1];
    messagesCountRef.current = messages.length;
    if (last?.role !== "user") return;
    // One frame of grace so the new bubble is mounted before we ask
    // the browser to scroll to it.
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(last.id)}"]`
      );
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }
      setShowJumpToLatest(false);
    });
  }, [messages]);

  // Tokens streaming in grow scrollHeight underneath the viewport
  // without firing a scroll event, so the pill state needs an explicit
  // nudge whenever the streaming buffer changes. NO auto-scroll here.
  useEffect(() => {
    setShowJumpToLatest(!isAtBottom() && isStreaming);
  }, [streamingContent, toolInvocations.length, isStreaming, isAtBottom]);

  const jumpToLatest = () => {
    setShowJumpToLatest(false);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  // Show the live streaming bubble whenever a stream is in flight AND
  // we have something to show — partial text, an attachment a tool just
  // produced, or a tool invocation in any state. Without this widening,
  // a turn that starts with a tool call (no text yet) would render the
  // generic ThinkingBubble and the user wouldn't see the spinner for
  // their tool.
  const showStreamingBubble =
    isStreaming &&
    (streamingContent.length > 0 ||
      (streamingAttachments?.length ?? 0) > 0 ||
      toolInvocations.length > 0);

  // Find the id of the conversation's most recent user message. Only this
  // one renders the pencil — editing earlier turns is intentionally not
  // supported (would orphan every assistant reply that came after).
  // Optimistic placeholders (id starts with "optimistic-") are skipped
  // because the backend doesn't know about them yet.
  const lastEditableUserId = useMemo<string | null>(() => {
    if (isStreaming) return null;
    if (!onEditAndResend) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      if (m.id.startsWith("optimistic-")) return null;
      return m.id;
    }
    return null;
  }, [messages, isStreaming, onEditAndResend]);

  // Build a quick id->username map so MessageBubble can render the
  // author chip without re-walking the participants array per row.
  // ``null`` when there are <=1 participants (solo chat) — that's
  // the signal MessageBubble uses to skip the chip entirely.
  const authorLookup = (() => {
    if (!participants || participants.length <= 1) return null;
    const map: Record<string, string> = {};
    for (const p of participants) map[p.user_id] = p.username;
    return map;
  })();

  return (
    <div ref={scrollRef} className="promptly-scroll relative flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            messageId={m.id}
            role={m.role}
            content={m.content}
            sources={m.sources}
            attachments={m.attachments}
            promptTokens={m.prompt_tokens}
            completionTokens={m.completion_tokens}
            ttftMs={m.ttft_ms}
            totalMs={m.total_ms}
            costUsd={m.cost_usd}
            authorUserId={m.author_user_id}
            authorLookup={authorLookup}
            currentUserId={currentUserId}
            onEdit={
              m.id === lastEditableUserId && onEditAndResend
                ? (newText) => onEditAndResend(m.id, newText)
                : undefined
            }
            onBranch={onBranchFrom ? () => onBranchFrom(m.id) : undefined}
          />
        ))}

        <VisionWarningBanner />

        {showStreamingBubble && (
          <MessageBubble
            role="assistant"
            content={streamingContent}
            sources={streamingSources}
            attachments={streamingAttachments}
            toolInvocations={toolInvocations}
            streaming
          />
        )}

        {isStreaming && !showStreamingBubble && <ThinkingBubble />}

        {streamError && (
          <div
            className={cn(
              "mx-4 my-3 rounded-card border px-4 py-3 text-sm",
              "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
            )}
            role="alert"
          >
            {streamError}
          </div>
        )}

        <div ref={endRef} className="h-6" />
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          onClick={jumpToLatest}
          className={cn(
            "sticky bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5",
            "rounded-full border border-[var(--border)] bg-[var(--surface)]/95 px-3 py-1.5",
            "text-xs font-medium text-[var(--text)] shadow-lg backdrop-blur",
            "transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          )}
          aria-label="Jump to latest message"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function VisionWarningBanner() {
  const warnings = useChatStore((s) => s.visionWarnings);
  const dismiss = useChatStore((s) => s.dismissVisionWarning);

  if (warnings.length === 0) return null;

  return (
    <div className="mx-4 mt-3 space-y-2">
      {warnings.map((message, idx) => (
        <div
          key={`${idx}-${message.slice(0, 16)}`}
          className={cn(
            "flex items-start gap-2 rounded-card border px-3 py-2 text-xs",
            "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          )}
          role="status"
        >
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 leading-snug">{message}</span>
          <button
            type="button"
            onClick={() => dismiss(idx)}
            className="rounded p-0.5 text-amber-700/70 hover:bg-amber-500/20 hover:text-amber-700 dark:text-amber-300/70 dark:hover:text-amber-300"
            aria-label="Dismiss warning"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
