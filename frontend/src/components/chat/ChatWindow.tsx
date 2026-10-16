import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Eye, X } from "lucide-react";

import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/utils/cn";
import type { ConversationParticipant } from "@/api/types";

import {
  CompactedSummaryRow,
  isCompactedSummary,
} from "./CompactedSummaryRow";
import { MessageBubble, type RegenerateOverride } from "./MessageBubble";
import { MessageBoundary } from "@/components/system/RouteBoundary";
import { RememberModal } from "./RememberModal";
import { WorkspaceRememberModal } from "./WorkspaceRememberModal";
import { StreamErrorCard } from "./StreamErrorCard";
import { ThinkingBubble } from "./ThinkingBubble";

// Mirrors the backend's ``_strip_leaked_tool_call_xml`` (chat/router.py).
// Some hosts stream a model's tool call as literal markup in the content
// channel (e.g. DeepSeek's ``<|DSML|tool_calls>…`` blocks) instead of a
// structured call. The backend strips it before persisting, and since the
// ``done`` payload carries the persisted text the finished bubble is clean —
// this client-side pass keeps the markup from flashing in the LIVE bubble
// while tokens are still arriving. Delimiter fragment accepts bare tags and
// ``|…|`` / fullwidth ``｜…｜`` wrapped ones, same as the backend.
const TAG_DELIM = String.raw`(?:\s*[|｜][^|｜>]*[|｜])?\s*`;
const LEAKED_TOOL_XML_RES: RegExp[] = [
  new RegExp(
    String.raw`<${TAG_DELIM}tool_calls\s*>[\s\S]*?(?:</${TAG_DELIM}tool_calls\s*>|$)`,
    "gi"
  ),
  new RegExp(
    String.raw`<${TAG_DELIM}invoke\b[^>]*>[\s\S]*?(?:</${TAG_DELIM}invoke\s*>|$)`,
    "gi"
  ),
];

function stripLeakedToolCallXml(text: string): string {
  if (!text || !text.includes("<")) return text;
  let out = text;
  for (const rx of LEAKED_TOOL_XML_RES) out = out.replace(rx, "");
  return out;
}

interface ChatWindowProps {
  /** Edit-and-resend hook for the most recent user message. When omitted
   *  (e.g. on a brand-new conversation page that hasn't created a chat
   *  yet), the pencil affordance is hidden entirely. */
  onEditAndResend?: (messageId: string, newText: string) => Promise<void>;
  /** In-place patch of an assistant reply — owner-only, no
   *  re-stream. When provided, every persisted assistant bubble
   *  gets an "Edit" affordance that opens the same textarea
   *  editor used for user turns. Omitted on chats the caller
   *  isn't authorised to mutate (collaborators on shared chats,
   *  or anonymous viewers of a public share link). */
  onEditAssistant?: (messageId: string, newText: string) => Promise<void>;
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
  /** Regenerate hook for the most recent persisted assistant message.
   *  Only the last assistant turn is eligible — regenerating older
   *  replies would orphan every turn that followed. Invoked with
   *  ``null`` for "same model" and a concrete override for the
   *  "try a different model" submenu. Omitted on new chats. */
  onRegenerate?: (
    messageId: string,
    override: RegenerateOverride | null
  ) => Promise<void> | void;
  /** Phase 3.1 — resume a truncated reply, appending the continuation
   *  onto the same bubble. Only offered on the last assistant turn when
   *  it was cut off at the output limit. */
  onContinue?: (messageId: string) => Promise<void> | void;
  /** "Dig deeper" on a research report — runs a focused refinement pass.
   *  Surfaced only on assistant messages that are research reports. */
  onDigDeeper?: (messageId: string) => void;
  /** Re-run the last turn after a stream error (same model). Surfaced
   *  as the "Try again" button on the error card. */
  onRetry?: () => void;
  /** Open the model picker after a stream error ("Pick another model"). */
  onPickAnotherModel?: () => void;
  /** Delete a single message. When provided, every persisted message
   *  gets a "Delete" affordance. Omitted on chats the caller can't
   *  mutate. */
  onDelete?: (messageId: string) => Promise<void> | void;
  /** Phase 2.5 — rate an assistant reply thumbs up/down. When provided,
   *  persisted assistant rows get the thumbs affordance. */
  onFeedback?: (
    messageId: string,
    rating: "up" | "down" | null,
    reason?: string
  ) => Promise<void> | void;
  /** Phase 2.6 — switch to a sibling version from the ``‹ 2/3 ›`` pager.
   *  Receives the id of the sibling to activate. */
  onSelectVersion?: (siblingId: string) => Promise<void> | void;
  /** Hide the "Remember" (save to account memory) action — set for
   *  workspace chats, which are a self-contained zone that shouldn't feed
   *  the user's personal account memory. */
  hideRemember?: boolean;
  /** Workspace chats: save a message into the *workspace* memory instead of
   *  the account memory. When set, the message "Remember" action calls this
   *  (no modal) rather than opening the account RememberModal. */
  onRememberToWorkspace?: (content: string) => Promise<void> | void;
  /** Whether the conversation currently on screen is the one actively
   *  streaming. Scoped by the caller (``viewIsStreaming``) so a stream running
   *  in a *different* conversation never leaks its live bubble / thinking
   *  indicator onto the conversation being viewed. Falls back to the global
   *  streaming flag when omitted. */
  streaming?: boolean;
}

interface RowCallbacks {
  edit: (text: string) => Promise<void>;
  editAssistant: (text: string) => Promise<void>;
  branch: () => Promise<void>;
  regenerate: (override: RegenerateOverride | null) => Promise<void>;
  digDeeper: () => Promise<void>;
  continue: () => Promise<void>;
  delete: () => Promise<void>;
  feedback: (rating: "up" | "down" | null, reason?: string) => Promise<void>;
}

export function ChatWindow({
  onEditAndResend,
  onEditAssistant,
  participants,
  onBranchFrom,
  onRegenerate,
  onContinue,
  onDigDeeper,
  onRetry,
  onPickAnotherModel,
  onDelete,
  onFeedback,
  onSelectVersion,
  hideRemember = false,
  onRememberToWorkspace,
  streaming,
}: ChatWindowProps) {
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const streamingContent = useChatStore((s) => s.streamingContent);
  // Live-bubble copy with any leaked tool-call markup elided (see
  // stripLeakedToolCallXml above). Cheap: no-ops unless a "<" is present.
  const displayStreamingContent = useMemo(
    () => stripLeakedToolCallXml(streamingContent),
    [streamingContent]
  );
  const streamingSources = useChatStore((s) => s.streamingSources);
  const streamingAttachments = useChatStore((s) => s.streamingAttachments);
  const toolInvocations = useChatStore((s) => s.toolInvocations);
  const visionRelayInvocations = useChatStore(
    (s) => s.visionRelayInvocations,
  );
  const storeStreaming = useChatStore((s) => s.isStreaming);
  // Scope every streaming affordance (live bubble, thinking indicator,
  // edit/regenerate guards, auto-scroll) to THIS view. When the caller passes
  // ``streaming`` it reflects whether the on-screen conversation is the one
  // streaming; a stream in a different conversation then no longer leaks its
  // live bubble here. Falls back to the global flag when the prop is omitted.
  const isStreaming = streaming ?? storeStreaming;
  const streamError = useChatStore((s) => s.streamError);
  const streamErrorMeta = useChatStore((s) => s.streamErrorMeta);
  const setStreamError = useChatStore((s) => s.setStreamError);
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Room under the newest question, so sending can scroll it to the top of
  // the view with the answer streaming in below — the "scroll your bubble
  // to the top" intent didn't work without it, and the reply streamed in
  // out of sight below the fold (R-066). Shrinks to nothing as the reply
  // grows past a screen.
  const [tailSpace, setTailSpace] = useState(0);
  const tailSpaceRef = useRef(0);
  tailSpaceRef.current = tailSpace;
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // Phase 3.3 — "Remember this" modal state. ``rememberText`` is the
  // message content pre-filled in the modal; null = modal closed.
  const [rememberText, setRememberText] = useState<string | null>(null);
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
    return (
      el.scrollHeight - tailSpaceRef.current - el.scrollTop - el.clientHeight <
      atBottomThreshold
    );
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
  }, [
    streamingContent,
    toolInvocations.length,
    visionRelayInvocations.length,
    isStreaming,
    isAtBottom,
  ]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const users = content.querySelectorAll<HTMLElement>(".promptly-message.flex-row-reverse");
      const lastUser = users[users.length - 1];
      if (!lastUser) {
        setTailSpace(0);
        return;
      }
      const fromLastQuestion =
        content.getBoundingClientRect().bottom - lastUser.getBoundingClientRect().top;
      const need = Math.max(0, Math.round(scroller.clientHeight - fromLastQuestion - 16));
      setTailSpace((prev) => (Math.abs(prev - need) < 4 ? prev : need));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

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
      toolInvocations.length > 0 ||
      visionRelayInvocations.length > 0);

  // Edit and Regenerate work on *every* turn, not just the last (R-067):
  // the backend branches the conversation, and the ‹ 2/3 › pager keeps
  // every earlier version reachable, so nothing after the edited turn is
  // lost. Optimistic rows are out — the backend can't target them yet.
  // Authorship gate (shared workspace chats): you can only rewrite messages
  // *you* sent; a null author is a legacy/solo row owned by the chat owner.
  const canEdit = useCallback(
    (m: (typeof messages)[number]) =>
      !isStreaming &&
      !!onEditAndResend &&
      m.role === "user" &&
      !m.id.startsWith("optimistic-") &&
      (!m.author_user_id || m.author_user_id === currentUserId),
    [isStreaming, onEditAndResend, currentUserId]
  );
  const canRegenerate = useCallback(
    (m: (typeof messages)[number]) =>
      !isStreaming &&
      !!onRegenerate &&
      m.role === "assistant" &&
      !m.id.startsWith("optimistic-"),
    [isStreaming, onRegenerate]
  );
  // Continue (for a truncated reply) still only applies to the latest one.
  const lastAssistantId = useMemo<string | null>(() => {
    if (isStreaming) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].id.startsWith("optimistic-") ? null : messages[i].id;
      }
    }
    return null;
  }, [messages, isStreaming]);

  // A question left without an answer (the reply failed before the error
  // card could show, or the page reloaded mid-send) can be sent again.
  const unansweredUserId = useMemo<string | null>(() => {
    if (isStreaming || !onRetry || streamError) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || last.id.startsWith("optimistic-")) return null;
    if (last.author_user_id && last.author_user_id !== currentUserId) return null;
    return last.id;
  }, [messages, isStreaming, onRetry, streamError, currentUserId]);

  // Stable per-message callbacks. Every row used to get fresh arrow
  // functions on each render, so the memoised MessageBubble re-rendered —
  // and re-parsed its markdown — for every streamed token, in every message
  // of the conversation (R-065/R-089). The handlers read the latest props
  // through a ref, so their identity never changes.
  const handlers = useRef({
    onEditAndResend, onEditAssistant, onBranchFrom, onRegenerate, onContinue,
    onDigDeeper, onDelete, onFeedback, onSelectVersion,
  });
  handlers.current = {
    onEditAndResend, onEditAssistant, onBranchFrom, onRegenerate, onContinue,
    onDigDeeper, onDelete, onFeedback, onSelectVersion,
  };
  const rowCallbacks = useRef(new Map<string, RowCallbacks>());
  const callbacksFor = useCallback((id: string): RowCallbacks => {
    let cb = rowCallbacks.current.get(id);
    if (!cb) {
      cb = {
        edit: async (text) => {
          await handlers.current.onEditAndResend?.(id, text);
        },
        editAssistant: async (text) => {
          await handlers.current.onEditAssistant?.(id, text);
        },
        branch: async () => {
          await handlers.current.onBranchFrom?.(id);
        },
        regenerate: async (override) => {
          await handlers.current.onRegenerate?.(id, override);
        },
        digDeeper: async () => {
          await handlers.current.onDigDeeper?.(id);
        },
        continue: async () => {
          await handlers.current.onContinue?.(id);
        },
        delete: async () => {
          await handlers.current.onDelete?.(id);
        },
        feedback: async (rating, reason) => {
          await handlers.current.onFeedback?.(id, rating, reason);
        },
      };
      rowCallbacks.current.set(id, cb);
    }
    return cb;
  }, []);
  const selectVersion = useCallback(
    (...args: Parameters<NonNullable<typeof onSelectVersion>>) =>
      handlers.current.onSelectVersion?.(...args),
    []
  );
  const remember = useCallback((text: string) => setRememberText(text), []);

  // Build a quick id->username map so MessageBubble can render the
  // author chip without re-walking the participants array per row.
  // ``null`` when there are <=1 participants (solo chat) — that's
  // the signal MessageBubble uses to skip the chip entirely.
  const authorLookup = useMemo(() => {
    if (!participants || participants.length <= 1) return null;
    const map: Record<string, string> = {};
    for (const p of participants) map[p.user_id] = p.username;
    return map;
  }, [participants]);

  // Resolve a message's raw ``model_id`` to a friendly display name so the
  // stats popover (and the ‹2/3› version pager) can show which model made
  // each reply. Falls back to the raw id if the model is no longer listed.
  const availableModels = useModelStore((s) => s.available);
  const modelNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of availableModels) map.set(m.model_id, m.display_name);
    return map;
  }, [availableModels]);
  const resolveModelLabel = useCallback(
    (id: string | null | undefined): string | null =>
      id ? modelNameById.get(id) ?? id : null,
    [modelNameById]
  );

  return (
    <div ref={scrollRef} className="promptly-scroll relative flex-1 overflow-y-auto">
      <div ref={contentRef} className="mx-auto w-full max-w-3xl">
        {messages.map((m) => {
          // Compaction-generated system rows render as a distinct
          // collapsible summary strip rather than an avatar bubble
          // (they're a meta-artifact, not a speaker turn).
          if (isCompactedSummary(m.role, m.content)) {
            return <CompactedSummaryRow key={m.id} content={m.content} />;
          }
          return (
            <MessageBoundary key={m.id} content={m.content}>
            <MessageBubble
              messageId={m.id}
              role={m.role}
              content={m.content}
              sources={m.sources}
              toolCalls={m.tool_calls}
              attachments={m.attachments}
              promptTokens={m.prompt_tokens}
              completionTokens={m.completion_tokens}
              ttftMs={m.ttft_ms}
              totalMs={m.total_ms}
              costUsd={m.cost_usd}
              modelLabel={resolveModelLabel(m.model_id)}
              truncated={m.truncated}
              authorUserId={m.author_user_id}
              authorLookup={authorLookup}
              currentUserId={currentUserId}
              onEdit={
                canEdit(m)
                  ? callbacksFor(m.id).edit
                  : m.role === "assistant" && onEditAssistant
                    ? callbacksFor(m.id).editAssistant
                    : undefined
              }
              editedAt={m.edited_at ?? null}
              onBranch={onBranchFrom ? callbacksFor(m.id).branch : undefined}
              onRegenerate={canRegenerate(m) ? callbacksFor(m.id).regenerate : undefined}
              onDigDeeper={onDigDeeper ? callbacksFor(m.id).digDeeper : undefined}
              onContinue={
                m.id === lastAssistantId && m.truncated && onContinue
                  ? callbacksFor(m.id).continue
                  : undefined
              }
              onDelete={
                onDelete && !m.id.startsWith("optimistic-")
                  ? callbacksFor(m.id).delete
                  : undefined
              }
              feedback={m.feedback}
              feedbackReason={m.feedback_reason}
              onFeedback={
                onFeedback &&
                m.role === "assistant" &&
                !m.id.startsWith("optimistic-")
                  ? callbacksFor(m.id).feedback
                  : undefined
              }
              versionIndex={m.version_index ?? undefined}
              versionCount={m.version_count ?? undefined}
              siblingIds={m.sibling_ids ?? undefined}
              onSelectVersion={onSelectVersion ? selectVersion : undefined}
              onRemember={onRememberToWorkspace || !hideRemember ? remember : undefined}
            />
            {m.id === unansweredUserId && (
              <div className="-mt-1 mb-3 flex justify-end px-4">
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  No reply yet — send again
                </button>
              </div>
            )}
            </MessageBoundary>
          );
        })}

        <VisionWarningBanner />

        {showStreamingBubble && (
          <MessageBubble
            role="assistant"
            content={displayStreamingContent}
            sources={streamingSources}
            attachments={streamingAttachments}
            toolInvocations={toolInvocations}
            visionRelayInvocations={visionRelayInvocations}
            streaming
          />
        )}

        {isStreaming && !showStreamingBubble && <ThinkingBubble />}

        {streamError && (
          <StreamErrorCard
            error={streamError}
            meta={streamErrorMeta}
            onDismiss={() => setStreamError(null, null)}
            onRetry={onRetry}
            onPickAnotherModel={onPickAnotherModel}
          />
        )}

        <div ref={endRef} className="h-6" />
      </div>
      <div aria-hidden style={{ height: tailSpace }} />

      {showJumpToLatest && (
        <button
          type="button"
          onClick={jumpToLatest}
          className={cn(
            "sticky bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5",
            "rounded-full border border-[var(--border)] bg-[var(--surface)]/95 px-3 py-1.5",
            "text-xs font-medium text-[var(--text)] shadow-lg backdrop-blur",
            "transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
          )}
          aria-label="Jump to latest message"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Jump to latest
        </button>
      )}

      {/* "Remember this" modal — workspace chats route to the workspace
          memory (agent-mediated); everywhere else to account memory. */}
      {rememberText !== null &&
        (onRememberToWorkspace ? (
          <WorkspaceRememberModal
            initialText={rememberText}
            onSave={(t) => Promise.resolve(onRememberToWorkspace(t))}
            onClose={() => setRememberText(null)}
          />
        ) : (
          <RememberModal
            initialText={rememberText}
            onClose={() => setRememberText(null)}
          />
        ))}
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
