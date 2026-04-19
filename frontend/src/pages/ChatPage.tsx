import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { GitBranch, Share2 } from "lucide-react";

import { authApi } from "@/api/auth";
import { chatApi } from "@/api/chat";
import { TopNav } from "@/components/layout/TopNav";
import { ChatWindow } from "@/components/chat/ChatWindow";
import { EditableTitle } from "@/components/chat/EditableTitle";
import { EmptyState } from "@/components/chat/EmptyState";
import { InputBar } from "@/components/chat/InputBar";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { PdfEditorPanel } from "@/components/chat/PdfEditorPanel";
import { ShareConversationDialog } from "@/components/chat/ShareConversationDialog";
import {
  useBranchConversation,
  useConversationQuery,
} from "@/hooks/useConversations";
import type { AttachedFile } from "@/components/chat/AttachmentPickerModal";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { useSelectedModel } from "@/store/modelStore";
import type { ChatMessage, WebSearchMode } from "@/api/types";
import { cn } from "@/utils/cn";

// Defaults applied when the user has never touched the toggles.
//   * Tools defaults ON so the AI can invoke artefact tools (PDF,
//     image gen) without the user discovering a hidden switch first.
//   * Web search defaults to "auto" — the model decides per turn so
//     answers stay current without firing a paid search every reply.
const DEFAULT_TOOLS_ENABLED = true;
const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = "auto";

export function ChatPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const setActive = useChatStore((s) => s.setActive);
  const setMessages = useChatStore((s) => s.setMessages);
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const isStreaming = useChatStore((s) => s.isStreaming);
  // Subscribe to message count directly so we can render the live chat pane
  // the moment an optimistic user bubble is appended (before the backend has
  // responded). Keeping this a primitive selector avoids re-renders when
  // unrelated chat state changes.
  const storeMessageCount = useChatStore((s) => s.messages.length);
  const { sendMessage, editAndResend, reattach, cancel } = useStreamingChat();
  const selectedModel = useSelectedModel();
  const isMobile = useIsMobile();

  // Both toggles seed from the user's persisted preferences (server-side
  // ``users.settings``) and write back whenever the user flips them. The
  // PATCH is fire-and-forget with optimistic local update — the worst case
  // is the next reload reverts to the stored value.
  const userSettings = useAuthStore((s) => s.user?.settings);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>(
    () => userSettings?.default_web_search_mode ?? DEFAULT_WEB_SEARCH_MODE
  );
  const [toolsEnabled, setToolsEnabled] = useState(
    () => userSettings?.default_tools_enabled ?? DEFAULT_TOOLS_ENABLED
  );
  // Tracks whether we've already pulled the persisted defaults into local
  // state. Without it, the user object loading after mount would snap the
  // toggles back to defaults the next time ``id`` changes.
  const [seededFromUser, setSeededFromUser] = useState(
    () => userSettings !== undefined
  );

  const { data: conversation } = useConversationQuery(id ?? null);
  const branchMutation = useBranchConversation();
  const handleBranchFrom = useCallback(
    async (messageId: string) => {
      if (!id) return;
      try {
        const branch = await branchMutation.mutateAsync({
          conversationId: id,
          messageId,
        });
        navigate(`/chat/${branch.id}`);
      } catch (err) {
        // Surface any failure on the toast/notification layer once
        // we wire one up; for now log so the dev console at least
        // shows the API response.
        console.error("Failed to branch conversation", err);
      }
    },
    [branchMutation, id, navigate]
  );
  const [shareOpen, setShareOpen] = useState(false);
  // Owner-only share affordance: collaborators see neither the
  // button nor the dialog. Falls open whenever role isn't explicitly
  // collaborator (default-owner for legacy chats without the field).
  const isOwner = useMemo(
    () => (conversation?.role ?? "owner") === "owner",
    [conversation?.role]
  );
  // Memoise the participant list so MessageBubble's prop equality
  // doesn't re-render every keystroke during streaming.
  const participants = useMemo(() => {
    if (!conversation) return null;
    const list = [
      ...(conversation.owner ? [conversation.owner] : []),
      ...(conversation.collaborators ?? []),
    ];
    return list.length > 1 ? list : null; // only render chips on multi-party chats
  }, [conversation]);

  // First-time hydration: when the user object lands (post-bootstrap or
  // after a slow /me round-trip), seed the toggles once.
  useEffect(() => {
    if (!userSettings || seededFromUser) return;
    setWebSearchMode(
      userSettings.default_web_search_mode ?? DEFAULT_WEB_SEARCH_MODE
    );
    setToolsEnabled(userSettings.default_tools_enabled ?? DEFAULT_TOOLS_ENABLED);
    setSeededFromUser(true);
  }, [userSettings, seededFromUser]);

  // When the active conversation switches, re-seed the toggles from the
  // current persisted preferences. Local toggle changes already persist
  // server-side, so this is just "honour the user's saved default for
  // each fresh chat".
  useEffect(() => {
    setActive(id ?? null);
    const s = useAuthStore.getState().user?.settings;
    if (!s) return;
    setWebSearchMode(s.default_web_search_mode ?? DEFAULT_WEB_SEARCH_MODE);
    setToolsEnabled(s.default_tools_enabled ?? DEFAULT_TOOLS_ENABLED);
  }, [id, setActive]);

  // Persist a preference flip to the server. Optimistic: update local
  // state + cached user immediately, fire the PATCH, roll back on
  // failure. Generic over the whitelisted preference keys so we can
  // share the same path for the boolean (``tools_enabled``) and the
  // tri-state web-search mode.
  const persistPreference = useCallback(
    async <K extends "default_tools_enabled" | "default_web_search_mode">(
      key: K,
      value: K extends "default_tools_enabled" ? boolean : WebSearchMode
    ) => {
      const previous = useAuthStore.getState().user?.settings?.[key];
      patchSettings({ [key]: value });
      try {
        const fresh = await authApi.updatePreferences({
          [key]: value,
        } as Record<K, typeof value>);
        setUser(fresh);
      } catch (err) {
        patchSettings({ [key]: previous as never });
        console.warn(`Failed to persist preference ${key}`, err);
      }
    },
    [patchSettings, setUser]
  );

  const handleWebSearchModeChange = useCallback(
    (next: WebSearchMode) => {
      setWebSearchMode(next);
      void persistPreference("default_web_search_mode", next);
    },
    [persistPreference]
  );

  const handleToolsChange = useCallback(
    (next: boolean) => {
      setToolsEnabled(next);
      void persistPreference("default_tools_enabled", next);
    },
    [persistPreference]
  );

  // Hydrate the message list from the loaded conversation. Reset when we have
  // no id. Crucially, we must NOT overwrite the store while a send is in
  // flight — otherwise the first `conversation` refetch after navigating to a
  // freshly-created chat would wipe out the optimistic user bubble.
  useEffect(() => {
    if (!id) {
      setMessages([]);
      useChatStore.getState().resetStream();
      return;
    }
    if (!conversation) return;
    if (useChatStore.getState().isStreaming) return;
    setMessages(conversation.messages);
  }, [id, conversation, setMessages]);

  // Reattach to in-flight generation. The user navigated away while the
  // model was thinking; the backend kept generating in a background task.
  // When they come back to this conversation, ask the server if a stream
  // is still running and, if so, subscribe to it so the response keeps
  // streaming into view from the buffered transcript onwards.
  //
  // Guarded by a per-conversation ref so a refetch of the same chat
  // doesn't fire a fresh subscribe loop on top of the existing one.
  const reattachedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !conversation) return;
    if (reattachedRef.current === id) return;
    if (useChatStore.getState().isStreaming) {
      // Already streaming locally (the user just sent a message and
      // we're showing the live tokens) — nothing to reattach to.
      reattachedRef.current = id;
      return;
    }
    reattachedRef.current = id;
    let cancelled = false;
    void (async () => {
      try {
        const streamId = await chatApi.activeStream(id);
        if (cancelled || !streamId) return;
        // Re-check isStreaming in case the user kicked off a fresh
        // turn between the check above and the network round-trip.
        if (useChatStore.getState().isStreaming) return;
        await reattach(id, streamId);
      } catch (err) {
        // Non-fatal — just means we won't tail. The persisted reply
        // will appear once generation finishes and the user reloads.
        console.warn("Reattach to in-flight stream failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, conversation, reattach]);

  // Reset the reattach guard when the active conversation switches so
  // the new chat gets its own one-shot reattach attempt.
  useEffect(() => {
    if (reattachedRef.current && reattachedRef.current !== id) {
      reattachedRef.current = null;
    }
  }, [id]);

  // Deep-link hash handler: ``#m-<message_id>`` (set by sidebar search
  // jump-to-message). We wait until the conversation messages have been
  // hydrated, then scroll the bubble into view and apply a transient
  // ``promptly-message-flash`` class for visual confirmation. Re-runs on
  // hash *or* hydration so refreshing the page on a deep link still works.
  useEffect(() => {
    const hash = location.hash;
    if (!hash || !hash.startsWith("#m-")) return;
    if (!conversation) return;
    const targetId = hash.slice(3);
    // Ensure the message is part of this conversation before scrolling —
    // a stale hash from another chat shouldn't blindly try to focus
    // something that won't exist.
    const found = conversation.messages.some((m) => m.id === targetId);
    if (!found) return;
    // requestAnimationFrame: wait one paint so the DOM nodes exist.
    const handle = window.requestAnimationFrame(() => {
      const el = document.getElementById(`m-${targetId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("promptly-message-flash");
      window.setTimeout(
        () => el.classList.remove("promptly-message-flash"),
        2000
      );
    });
    return () => window.cancelAnimationFrame(handle);
  }, [location.hash, conversation]);

  const handleSend = useCallback(
    async (text: string, attachments: AttachedFile[] = []) => {
      if (!selectedModel) return;

      // 1. Optimistic user bubble + thinking state, BEFORE any network call.
      //    This is the whole point — users clicking Send must see instant
      //    feedback instead of a 200-500 ms freeze while we create a new
      //    conversation and POST the message.
      const store = useChatStore.getState();
      const optimisticId = `optimistic-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      const optimisticMsg: ChatMessage = {
        id: optimisticId,
        conversation_id: id ?? "",
        role: "user",
        content: text,
        attachments: attachments.length > 0 ? attachments : null,
        created_at: new Date().toISOString(),
      };
      store.setStreamError(null);
      store.setStreaming(true);
      store.appendMessage(optimisticMsg);

      let conversationId = id;
      // If we're on /chat (no id), create a conversation first and navigate to it.
      if (!conversationId) {
        try {
          const conv = await chatApi.create({
            provider_id: selectedModel.provider_id,
            model_id: selectedModel.model_id,
            web_search_mode: webSearchMode,
          });
          upsertConversation(conv);
          conversationId = conv.id;
          navigate(`/chat/${conv.id}`, { replace: true });
        } catch (err) {
          // Roll back the optimistic bubble so the user can retry cleanly.
          useChatStore.setState((s) => ({
            messages: s.messages.filter((m) => m.id !== optimisticId),
            isStreaming: false,
            streamError: err instanceof Error ? err.message : String(err),
          }));
          return;
        }
      }

      await sendMessage(
        conversationId,
        {
          content: text,
          provider_id: selectedModel.provider_id,
          model_id: selectedModel.model_id,
          web_search_mode: webSearchMode,
          attachment_ids: attachments.map((a) => a.id),
          tools_enabled: toolsEnabled,
        },
        { optimisticUserId: optimisticId }
      );
    },
    [
      id,
      navigate,
      selectedModel,
      sendMessage,
      upsertConversation,
      webSearchMode,
      toolsEnabled,
    ]
  );

  const handleEditAndResend = useCallback(
    async (messageId: string, newText: string) => {
      if (!id || !selectedModel) return;
      await editAndResend(id, messageId, {
        content: newText,
        provider_id: selectedModel.provider_id,
        model_id: selectedModel.model_id,
        web_search_mode: webSearchMode,
        tools_enabled: toolsEnabled,
      });
    },
    [editAndResend, id, selectedModel, webSearchMode, toolsEnabled]
  );

  // Raw (possibly null) title — EditableTitle handles the placeholder.
  const rawTitle = conversation?.title ?? null;
  const subtitle = selectedModel
    ? `${selectedModel.display_name} · ${selectedModel.provider_name}`
    : "No model selected";

  // Show the live chat pane whenever the store has any messages (including
  // optimistic ones) or we're mid-stream. Falling back to the server-side
  // `conversation.messages` covers the cold-load case where the store hasn't
  // been hydrated yet.
  const hasMessages =
    storeMessageCount > 0 || (conversation?.messages.length ?? 0) > 0;

  // Footer line under the input bar reflects which web-search mode is
  // currently active so the user understands what'll happen on send
  // without having to open the picker. "Off" falls through to the
  // generic active-model line so users on the default get the
  // model-name reassurance they had before Phase D1.
  const footerText =
    webSearchMode === "always"
      ? "Web search: Always — every reply will run a search and cite sources."
      : webSearchMode === "auto"
        ? "Web search: Auto — the model decides when current info is needed."
        : selectedModel
          ? `Active model: ${selectedModel.display_name}`
          : "";

  return (
    <>
      <TopNav
        title={
          id ? (
            <EditableTitle conversationId={id} title={rawTitle} />
          ) : (
            "New chat"
          )
        }
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            {id && isOwner && (
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)]",
                  // Icon-only on mobile to free up header real estate
                  // for the title — same target size as the hamburger
                  // and ModelSelector trigger so the action row reads
                  // as a single visual unit.
                  isMobile
                    ? "h-9 w-9 justify-center"
                    : "px-2.5 py-1.5 text-xs"
                )}
                title="Share this conversation"
                aria-label="Share this conversation"
              >
                <Share2 className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
                {!isMobile && "Share"}
              </button>
            )}
            <ModelSelector compact={isMobile} />
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {conversation?.parent_conversation_id && (
          <BranchBanner
            parentId={conversation.parent_conversation_id}
            parentMessageId={conversation.parent_message_id ?? null}
          />
        )}
        {(id || isStreaming) && (hasMessages || isStreaming) ? (
          <ChatWindow
            onEditAndResend={handleEditAndResend}
            participants={participants}
            onBranchFrom={id ? handleBranchFrom : undefined}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              hasModel={Boolean(selectedModel)}
              onSuggestion={(s) => handleSend(s)}
            />
          </div>
        )}
        <InputBar
          streaming={isStreaming}
          disabled={!selectedModel}
          onSend={handleSend}
          onCancel={cancel}
          webSearchMode={webSearchMode}
          onWebSearchModeChange={handleWebSearchModeChange}
          toolsEnabled={toolsEnabled}
          onToolsChange={handleToolsChange}
          footer={footerText}
          placeholder={
            selectedModel
              ? "Message Promptly..."
              : "Configure a model in the Models tab first"
          }
        />
      </div>
      {/* Phase A3: side-panel Markdown editor for AI-generated PDFs.
          Renders into the same DOM tree but its fixed positioning takes
          it out of normal flow; null when no file is selected. */}
      <PdfEditorPanel />
      {id && isOwner && (
        <ShareConversationDialog
          open={shareOpen}
          conversationId={id}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  );
}

interface BranchBannerProps {
  parentId: string;
  parentMessageId: string | null;
}

/** Small "branched from" chip rendered above the message list of a
 *  forked conversation. Clicking jumps back to the source — and,
 *  when we know which message it was forked from, scrolls to that
 *  bubble via the same ``#m-<uuid>`` deep-link mechanism Phase 4a
 *  added for full-text search. */
function BranchBanner({ parentId, parentMessageId }: BranchBannerProps) {
  const navigate = useNavigate();
  const target = parentMessageId
    ? `/chat/${parentId}#m-${parentMessageId}`
    : `/chat/${parentId}`;
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-xs text-[var(--text-muted)]">
      <GitBranch className="h-3 w-3 text-[var(--accent)]" />
      <span>Branched from a previous chat.</span>
      <button
        type="button"
        onClick={() => navigate(target)}
        className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
      >
        Jump to original →
      </button>
    </div>
  );
}
