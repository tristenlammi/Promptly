import { useEffect, useMemo, useRef } from "react";
import { Eye, X } from "lucide-react";

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
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingSources = useChatStore((s) => s.streamingSources);
  const streamingAttachments = useChatStore((s) => s.streamingAttachments);
  const toolInvocations = useChatStore((s) => s.toolInvocations);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamError = useChatStore((s) => s.streamError);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamingContent, isStreaming, toolInvocations.length]);

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
    <div className="promptly-scroll flex-1 overflow-y-auto">
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
