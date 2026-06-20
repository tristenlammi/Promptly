import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Clock,
  FolderKanban,
  Ghost,
  GitBranch,
  Zap,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { TopNav } from "@/components/layout/TopNav";
import { ChatWindow } from "@/components/chat/ChatWindow";
import { ContextWarningBanner } from "@/components/chat/ContextWarningBanner";
import { ContextWindowPill } from "@/components/chat/ContextWindowPill";
import { SummariseToWorkspaceButton } from "@/components/chat/SummariseToWorkspaceButton";
import { WorkspaceFilesToggle } from "@/components/chat/WorkspaceFilesToggle";
import type { RegenerateOverride } from "@/components/chat/MessageBubble";
import { EditableTitle } from "@/components/chat/EditableTitle";
import { EmptyState } from "@/components/chat/EmptyState";
import { StreamingAnnouncer } from "@/components/chat/StreamingAnnouncer";
import { InputBar } from "@/components/chat/InputBar";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { ConversationInstructionsButton } from "@/components/chat/ConversationInstructionsButton";
import { MemoryConversationButton } from "@/components/chat/MemoryConversationButton";
import { ResearchDialog } from "@/components/chat/ResearchDialog";
import { VoiceModeOverlay } from "@/components/chat/VoiceModeOverlay";
import { ResearchProgressCard } from "@/components/chat/ResearchProgressCard";
import { PdfEditorPanel } from "@/components/chat/PdfEditorPanel";
import { CodeArtifactPanel } from "@/components/codeArtifacts/CodeArtifactPanel";
import {
  useBranchConversation,
  useConversationQuery,
} from "@/hooks/useConversations";
import type { AttachedFile } from "@/components/chat/AttachmentPickerModal";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useWorkspace } from "@/hooks/useWorkspaces";
import { useAvailableModels } from "@/hooks/useProviders";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { useResearch } from "@/hooks/useResearch";
import { useResearchStore, isResearchActive } from "@/store/researchStore";
import { useAuthStore } from "@/store/authStore";
import { useComposerStore } from "@/store/composerStore";
import { useChatStore } from "@/store/chatStore";
import { useModelStore, useSelectedModel } from "@/store/modelStore";
import type {
  ChatMessage,
  ConversationDetail,
  ReasoningEffort,
  TemporaryMode,
  WebSearchMode,
} from "@/api/types";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

// Defaults applied when the user has never touched the toggles.
//   * Tools defaults ON so the AI can invoke artefact tools (PDF,
//     image gen) without the user discovering a hidden switch first.
//   * Web search defaults to "auto" — the model decides per turn so
//     answers stay current without firing a paid search every reply.
const DEFAULT_TOOLS_ENABLED = true;
const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = "auto";

export function ChatPage({
  embeddedConversationId,
  embedded = false,
  onExitToWorkspace,
}: {
  /** When set, drive the page off this conversation id instead of the
   *  route param — lets the Workspace navigator render a chat inline in
   *  its main pane (rail + nav stay visible). */
  embeddedConversationId?: string;
  /** Hide the page chrome (TopNav) when rendered inside another shell. */
  embedded?: boolean;
  /** When embedded in the workspace shell, the "Back to workspace"
   *  breadcrumb calls this to return to the workspace home instead of
   *  navigating (the route is already ``/workspaces/:id``, so a navigate
   *  would be a no-op). */
  onExitToWorkspace?: () => void;
} = {}) {
  const { id: routeId } = useParams<{ id?: string }>();
  const id = embeddedConversationId ?? routeId;
  const navigate = useNavigate();
  const location = useLocation();
  // Phase Z1 — temporary chat mode picked from the sidebar split button.
  // Carried via ``?temporary=ephemeral`` or ``?temporary=one_hour`` so a
  // hard refresh on /chat preserves the selection. Once the conversation
  // is created the mode is persisted on the row, so we don't need to keep
  // the query string after the navigate(`/chat/{id}`) replace.
  const pendingTemporaryMode = useMemo<TemporaryMode | null>(() => {
    if (id) return null;
    const raw = new URLSearchParams(location.search).get("temporary");
    if (raw === "ephemeral" || raw === "one_hour") return raw;
    return null;
  }, [id, location.search]);
  const setActive = useChatStore((s) => s.setActive);
  const setMessages = useChatStore((s) => s.setMessages);
  const replaceMessage = useChatStore((s) => s.replaceMessage);
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const isStreaming = useChatStore((s) => s.isStreaming);
  // Subscribe to message count directly so we can render the live chat pane
  // the moment an optimistic user bubble is appended (before the backend has
  // responded). Keeping this a primitive selector avoids re-renders when
  // unrelated chat state changes.
  const storeMessageCount = useChatStore((s) => s.messages.length);
  const {
    sendMessage,
    editAndResend,
    regenerate,
    continueGenerate,
    reattach,
    cancel,
  } = useStreamingChat();
  const selectedModel = useSelectedModel();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // Load the model catalogue here (not only inside <ModelSelector>) so an
  // embedded workspace chat — which hides the top bar + selector — still
  // populates ``available``; otherwise the selected model can't resolve and
  // sending is blocked with a "configure a model" dead end.
  useAvailableModels();

  // Both toggles seed from the user's account defaults whenever a new chat
  // starts. Web search mode also reads the per-conversation stored value
  // when opening an existing chat. Toggle changes inside a chat are
  // local-only and do NOT overwrite account-level defaults.
  const userSettings = useAuthStore((s) => s.user?.settings);

  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>(
    () => userSettings?.default_web_search_mode ?? DEFAULT_WEB_SEARCH_MODE
  );
  const [toolsEnabled, setToolsEnabled] = useState(
    () => userSettings?.default_tools_enabled ?? DEFAULT_TOOLS_ENABLED
  );
  // Phase 9 — per-conversation memory capture pause.
  const [memoryCapturePaused, setMemoryCapturePaused] = useState(false);

  // Phase 11 — Deep Research.
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const { startResearch, cancelResearch } = useResearch();
  const researchStep = useResearchStore((s) => s.step);
  const researchConvId = useResearchStore((s) => s.conversationId);
  const researchRunning = id
    ? isResearchActive({ conversationId: researchConvId, step: researchStep }, id)
    : false;
  // Read current composer draft so the research dialog can pre-fill the topic.
  const composerDraft = useComposerStore(
    (s) => s.getDraft(id ?? "__new__")?.text ?? ""
  );
  // DeepSeek-only reasoning state. ``null`` means "no override on this
  // turn, use whatever the conversation has stored" — for non-DeepSeek
  // chats this column is always NULL so the chat router doesn't attach
  // any extra request fields. The dropdown only renders when the
  // currently-selected model is on a DeepSeek provider; flipping the
  // selector away from DeepSeek hides the chip but leaves the conv's
  // stored value untouched (so flipping back picks it up again).
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(null);
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

  // Tracks which conversation id we've already seeded webSearchMode from —
  // avoids re-seeding on every incremental background refresh of the
  // conversation query.
  const webSearchSeededForRef = useRef<string | null>(null);

  // First-time hydration: when the user object lands (post-bootstrap or
  // after a slow /me round-trip), seed the toggles once. Tools always
  // come from account defaults. Web search mode only falls back to the
  // account default here when we're not already in a conversation that
  // has seeded its own value (avoids clobbering a conversation-specific
  // mode if the user object arrives after the conversation query).
  useEffect(() => {
    if (!userSettings || seededFromUser) return;
    if (!id || webSearchSeededForRef.current !== id) {
      setWebSearchMode(
        userSettings.default_web_search_mode ?? DEFAULT_WEB_SEARCH_MODE
      );
    }
    setToolsEnabled(userSettings.default_tools_enabled ?? DEFAULT_TOOLS_ENABLED);
    setSeededFromUser(true);
  }, [userSettings, seededFromUser, id]);

  // When the active conversation switches, seed toggles from account
  // defaults. Tools have no per-conversation storage so they always come
  // from the account default. Web search mode for *existing* chats is
  // seeded from the loaded conversation in the effect below.
  useEffect(() => {
    setActive(id ?? null);
    // Reset per-conversation seed tracking on every chat switch.
    webSearchSeededForRef.current = null;
    const s = useAuthStore.getState().user?.settings;
    // Tools always come from account defaults (no per-conversation storage).
    if (s) setToolsEnabled(s.default_tools_enabled ?? DEFAULT_TOOLS_ENABLED);
    // For new chats there is no conversation to seed from — use account default.
    if (!id && s) {
      setWebSearchMode(s.default_web_search_mode ?? DEFAULT_WEB_SEARCH_MODE);
    }
  }, [id, setActive]);

  // Seed webSearchMode from the loaded conversation's stored mode once per
  // conversation. Guarded by the ref so in-chat toggle changes aren't
  // clobbered on every background refresh of the conversation query.
  useEffect(() => {
    if (!id || !conversation) return;
    if (webSearchSeededForRef.current === id) return;
    webSearchSeededForRef.current = id;
    setWebSearchMode(conversation.web_search_mode ?? DEFAULT_WEB_SEARCH_MODE);
  }, [id, conversation]);

  // Default-model behaviour: every NEW chat starts on the user's
  // configured default; opening an EXISTING chat snaps the picker to
  // that conversation's stored model so swapping models in chat A
  // doesn't leak into chat B. The user can still pick a different
  // model mid-chat — the next send persists that pick onto the
  // conversation, and the snap below honours it from then on.
  const convModelId = conversation?.model_id ?? null;
  const convProviderId = conversation?.provider_id ?? null;
  const convReasoningEffort = conversation?.reasoning_effort ?? null;
  // A workspace chat falls back to the workspace's default model when the
  // conversation itself carries none — so chats in a workspace start on the
  // workspace's model instead of a "configure a model" dead end.
  const chatWorkspaceId = conversation?.workspace_id ?? undefined;
  const { data: chatWorkspace } = useWorkspace(chatWorkspaceId);
  const wsDefaultModelId = chatWorkspace?.default_model_id ?? null;
  const wsDefaultProviderId = chatWorkspace?.default_provider_id ?? null;
  useEffect(() => {
    if (!id) {
      useModelStore.getState().applyDefault();
      return;
    }
    const store = useModelStore.getState();
    if (convProviderId && convModelId) {
      if (
        store.selectedProviderId !== convProviderId ||
        store.selectedModelId !== convModelId
      ) {
        store.setSelection(convProviderId, convModelId);
      }
    } else if (
      wsDefaultProviderId &&
      wsDefaultModelId &&
      !store.selectedModelId
    ) {
      // No per-conversation model + nothing selected yet → seed the
      // workspace default. Guarded on an empty selection so we never stomp
      // a model the user deliberately picked mid-chat.
      store.setSelection(wsDefaultProviderId, wsDefaultModelId);
    }
  }, [
    id,
    convProviderId,
    convModelId,
    wsDefaultProviderId,
    wsDefaultModelId,
  ]);

  // Hydrate the reasoning chip from the loaded conversation whenever
  // we switch into a different chat. We deliberately don't sync the
  // other direction (local state -> conversation column) here — that
  // happens on send / via the PATCH in ``handleReasoningEffortChange``
  // so swapping chats can't accidentally clobber a freshly-picked
  // value before it's been persisted.
  useEffect(() => {
    setReasoningEffort(convReasoningEffort);
  }, [id, convReasoningEffort]);

  // Phase 9 — seed memory capture paused from the loaded conversation.
  useEffect(() => {
    setMemoryCapturePaused(conversation?.memory_capture_paused ?? false);
  }, [id, conversation?.memory_capture_paused]);

  // The Effort control is shown only for models that natively support a
  // reasoning/effort knob — for everything else it would be a no-op dressed
  // as a feature, so we hide it entirely.
  const reasoningSupported = Boolean(selectedModel?.supports_native_reasoning);

  // Phase 9 — show the memory header control when memory isn't globally off.
  // Resolves the memory_mode / legacy memory_enabled setting consistently.
  const memoryEnabled = (() => {
    const m = userSettings?.memory_mode;
    if (m === "off") return false;
    if (m === "auto" || m === "manual") return true;
    return userSettings?.memory_enabled !== false;
  })();

  // Toggle changes in a chat are local-only — they never touch account
  // defaults. Account defaults only change through the Settings page.
  const handleWebSearchModeChange = useCallback((next: WebSearchMode) => {
    setWebSearchMode(next);
  }, []);

  const handleToolsChange = useCallback((next: boolean) => {
    setToolsEnabled(next);
  }, []);

  // Reasoning effort isn't a user-wide default — it's per-conversation
  // and only meaningful for DeepSeek models. Picking a value updates
  // local state immediately so the chip reflects the choice; the
  // server-side persistence happens on the next send (the chat
  // router writes through to ``conversations.reasoning_effort``). For
  // conversations that exist but where the user changes the dropdown
  // before sending, we also fire a PATCH so the value sticks even if
  // they navigate away without sending.
  const handleReasoningEffortChange = useCallback(
    (next: ReasoningEffort) => {
      setReasoningEffort(next);
      if (id) {
        void chatApi
          .update(id, { reasoning_effort: next })
          .catch((err: unknown) => {
            console.warn("Failed to persist reasoning_effort", err);
          });
      }
    },
    [id]
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

  // Phase Z1 — ephemeral chat cleanup. Track the most recently active
  // conversation along with its temporary_mode; whenever the user
  // navigates to a different chat (or unmounts ChatPage entirely), if
  // the previous chat was ephemeral, fire DELETE so it disappears
  // immediately instead of waiting for the 24h sweeper backstop.
  // Fire-and-forget — failures are harmless because the sweeper still
  // catches it eventually.
  const removeConversation = useChatStore((s) => s.removeConversation);
  const lastActiveRef = useRef<{ id: string; mode: TemporaryMode | null } | null>(
    null
  );
  useEffect(() => {
    const previous = lastActiveRef.current;
    if (id && conversation) {
      lastActiveRef.current = {
        id,
        mode: (conversation.temporary_mode as TemporaryMode | null) ?? null,
      };
    } else if (!id) {
      lastActiveRef.current = null;
    }
    if (previous && previous.mode === "ephemeral" && previous.id !== id) {
      void chatApi.remove(previous.id).catch(() => {});
      removeConversation(previous.id);
    }
  }, [id, conversation, removeConversation]);

  useEffect(() => {
    return () => {
      const previous = lastActiveRef.current;
      if (previous && previous.mode === "ephemeral") {
        void chatApi.remove(previous.id).catch(() => {});
        removeConversation(previous.id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            // Only seed reasoning_effort on creation when the user has
            // a DeepSeek model selected — for every other provider we
            // leave the column NULL so the API default applies.
            reasoning_effort:
              reasoningSupported && reasoningEffort
                ? reasoningEffort
                : undefined,
            temporary_mode: pendingTemporaryMode,
          });
          upsertConversation(conv);
          // Preseed the conversation-detail query cache so the chat page
          // doesn't blink "no conversation" between the navigate and
          // the first GET. The detail extends the summary with messages,
          // so a stub list is enough; the real fetch will replace it.
          // Critical for Phase Z1's tinted temporary-chat banner: it
          // reads ``conversation.temporary_mode`` and would otherwise
          // briefly disappear immediately after first send.
          queryClient.setQueryData(["conversation", conv.id], {
            ...conv,
            messages: [],
          });
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
          reasoning_effort:
            reasoningSupported && reasoningEffort
              ? reasoningEffort
              : undefined,
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
      reasoningSupported,
      reasoningEffort,
      toolsEnabled,
      pendingTemporaryMode,
      queryClient,
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
        reasoning_effort:
          reasoningSupported && reasoningEffort ? reasoningEffort : undefined,
        tools_enabled: toolsEnabled,
      });
    },
    [
      editAndResend,
      id,
      selectedModel,
      webSearchMode,
      reasoningSupported,
      reasoningEffort,
      toolsEnabled,
    ]
  );

  /** In-place patch of an assistant reply — no re-stream. The
   *  backend ``PATCH`` endpoint mutates ``content`` + stamps
   *  ``edited_at`` and returns the new row, which we splice into
   *  the local store so the bubble updates without a refetch.
   *  Owner-only on the server, so we don't need to gate this in
   *  the UI for collaborators. */
  const handleEditAssistant = useCallback(
    async (messageId: string, newText: string) => {
      if (!id) return;
      const updated = await chatApi.editAssistantMessage(id, messageId, newText);
      replaceMessage(messageId, updated);
    },
    [id, replaceMessage]
  );

  /** Regenerate the most recent assistant reply.
   *
   *  ``override`` comes from the "Try a different model" submenu; when
   *  ``null`` we fall back to whatever model is currently selected in
   *  the global picker (which is almost always also the conversation's
   *  active model — the submenu keeps them in sync on pick). This lets
   *  a one-click "retry" work without a body override, and a submenu
   *  pick force a specific provider in a single round-trip. */
  const handleRegenerate = useCallback(
    async (messageId: string, override: RegenerateOverride | null) => {
      if (!id) return;
      const provider_id = override?.provider_id ?? selectedModel?.provider_id;
      const model_id = override?.model_id ?? selectedModel?.model_id;
      if (!provider_id || !model_id) return;
      await regenerate(id, messageId, {
        provider_id,
        model_id,
        web_search_mode: webSearchMode,
        reasoning_effort:
          reasoningSupported && reasoningEffort ? reasoningEffort : undefined,
        tools_enabled: toolsEnabled,
      });
    },
    [
      regenerate,
      id,
      selectedModel,
      webSearchMode,
      reasoningSupported,
      reasoningEffort,
      toolsEnabled,
    ]
  );

  /** Phase 3.1 — resume a reply that was cut off at the output limit.
   *  Streams the continuation onto the same bubble using the
   *  conversation's current settings (no model override needed). */
  const handleContinue = useCallback(
    async (messageId: string) => {
      if (!id) return;
      const provider_id = selectedModel?.provider_id;
      const model_id = selectedModel?.model_id;
      await continueGenerate(id, messageId, {
        provider_id,
        model_id,
        web_search_mode: webSearchMode,
        reasoning_effort:
          reasoningSupported && reasoningEffort ? reasoningEffort : undefined,
        tools_enabled: toolsEnabled,
      });
    },
    [
      continueGenerate,
      id,
      selectedModel,
      webSearchMode,
      reasoningSupported,
      reasoningEffort,
      toolsEnabled,
    ]
  );

  /** Phase 2.6 — switch the visible thread to a sibling version from the
   *  ``‹ 2/3 ›`` pager. The backend re-resolves the active path and hands
   *  back the full conversation detail, which we both push into the
   *  store (instant swap) and write into the query cache so a later
   *  refetch / hydrate doesn't bounce back to the previous version. */
  const handleSelectVersion = useCallback(
    async (siblingId: string) => {
      if (!id) return;
      try {
        const detail = await chatApi.activateMessageVersion(id, siblingId);
        setMessages(detail.messages);
        queryClient.setQueryData(["conversation", id], detail);
      } catch (err) {
        const detail2 =
          err instanceof Error ? err.message : "Couldn't switch version.";
        window.alert(detail2);
      }
    },
    [id, setMessages, queryClient]
  );

  /** One-click recovery after a stream error. Re-runs the most recent
   *  user turn with the currently-selected model. The user message is
   *  persisted before the stream drains, so in the common case (upstream
   *  rejected the request) we edit-and-resend it — which clears any
   *  partial assistant reply and re-streams. In the rare pre-persist
   *  failure the user bubble is still optimistic, so we drop it and send
   *  fresh to avoid leaving a duplicate. */
  const handleRetry = useCallback(() => {
    if (!id) return;
    const store = useChatStore.getState();
    const msgs = store.messages;
    let target: (typeof msgs)[number] | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        target = msgs[i];
        break;
      }
    }
    if (!target) return;
    store.setStreamError(null, null);
    if (target.id.startsWith("optimistic-")) {
      store.setMessages(msgs.filter((m) => m.id !== target!.id));
      void handleSend(target.content);
    } else {
      void handleEditAndResend(target.id, target.content);
    }
  }, [id, handleEditAndResend, handleSend]);

  const handlePickAnotherModel = useCallback(() => {
    useModelStore.getState().requestPickerOpen();
  }, []);

  /** Delete a single message. Confirms first (it's destructive and not
   *  undoable), removes it from the local store optimistically, then
   *  calls the owner-only backend endpoint. On failure we refetch the
   *  conversation so the store snaps back to the server's truth. */
  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!id) return;
      const ok = await confirm({
        title: "Delete message",
        message: "Delete this message? This can't be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const store = useChatStore.getState();
      const snapshot = store.messages;
      store.removeMessage(messageId);
      try {
        await chatApi.deleteMessage(id, messageId);
      } catch (err) {
        store.setMessages(snapshot);
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? "Couldn't delete that message. Try again.";
        toast.error(detail);
      }
    },
    [id]
  );

  /** Rate an assistant reply thumbs up/down (Phase 2.5). Persists via
   *  the backend and splices the returned row into the store so the
   *  thumb state (and any reason) reflects the server's truth. */
  const handleMessageFeedback = useCallback(
    async (
      messageId: string,
      rating: "up" | "down" | null,
      reason?: string
    ) => {
      if (!id) return;
      try {
        const updated = await chatApi.setMessageFeedback(
          id,
          messageId,
          rating,
          reason
        );
        replaceMessage(messageId, updated);
      } catch {
        // Non-critical — leave the previous state in place. A failed
        // rating isn't worth interrupting the user with an alert.
      }
    },
    [id, replaceMessage]
  );

  // Context-window compaction — destructive (middle of the chat
  // becomes a single system summary). Gate on ``window.confirm`` to
  // match the pattern used elsewhere (PDF editor discard, provider
  // delete) and refetch the conversation afterwards so the store
  // picks up the shortened message list.
  const handleCompact = useCallback(async () => {
    if (!id) return;
    const ok = await confirm({
      title: "Compact this conversation?",
      message:
        "We'll keep your first and last few messages intact and replace " +
        "everything in between with a concise summary generated by the " +
        "current model. This frees up context space so the chat can keep " +
        "going — but the original middle messages will be gone.",
      confirmLabel: "Compact",
      danger: true,
    });
    if (!ok) return;
    try {
      await chatApi.compact(id);
      await queryClient.invalidateQueries({
        queryKey: ["conversation", id],
      });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success("Conversation compacted");
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Compaction failed. Try again in a moment.";
      toast.error(detail);
    }
  }, [id, queryClient]);

  // "Keep this chat" — promote the current temporary chat to a permanent
  // one. Clears the temporary lifecycle server-side (and the sweeper
  // deadline) so it survives navigation and stops counting down. Only
  // meaningful for a persisted, owned temporary chat.
  const handleKeepChat = useCallback(async () => {
    if (!id) return;
    try {
      await chatApi.update(id, { temporary_mode: null });
      queryClient.setQueryData<ConversationDetail>(
        ["conversation", id],
        (old) =>
          old ? { ...old, temporary_mode: null, expires_at: null } : old
      );
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success("Chat kept — it won't expire anymore");
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't keep the chat. Try again in a moment.";
      toast.error(detail);
    }
  }, [id, queryClient]);

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

  // Phase Z1 — what kind of chat is this? Either it's an in-flight
  // pre-creation /chat?temporary=… selection, or the conversation has
  // already been persisted with the mode on the row.
  const effectiveTemporaryMode: TemporaryMode | null =
    pendingTemporaryMode ??
    ((conversation?.temporary_mode as TemporaryMode | null) ?? null);

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
      {!embedded && (
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
            {/* Share + export moved off the top-nav and onto the
                sidebar row's right-click / long-press context menu —
                they weren't frequent enough to keep paying for header
                real estate. Pin and delete remain on the sidebar
                row's hover/quick-action cluster. */}
            {/* Save-summary-to-workspace is only meaningful when the chat
                already lives in a workspace. We also hide it for empty
                chats — there's nothing to summarise before the user
                has exchanged a few turns with the model. */}
            {id &&
              isOwner &&
              !effectiveTemporaryMode &&
              conversation?.workspace_id &&
              hasMessages && (
                <SummariseToWorkspaceButton
                  conversationId={id}
                  compact={isMobile}
                />
              )}
            {id &&
              isOwner &&
              !effectiveTemporaryMode &&
              conversation?.workspace_id && (
                <WorkspaceFilesToggle conversationId={id} compact={isMobile} />
              )}
            {id && isOwner && (
              <ConversationInstructionsButton
                conversationId={id}
                value={conversation?.system_prompt ?? null}
                compact={isMobile}
                onSaved={(next) => {
                  queryClient.setQueryData<ConversationDetail>(
                    ["conversation", id],
                    (old) =>
                      old ? { ...old, system_prompt: next } : old
                  );
                }}
              />
            )}
            {/* Phase 9 — memory header control: active-facts popover + per-
                conversation capture pause. Hidden when memory is globally off
                or this is an unsaved conversation (no id to PATCH). */}
            {id && isOwner && memoryEnabled && (
              <MemoryConversationButton
                conversationId={id}
                capturePaused={memoryCapturePaused}
                onCapturePausedChange={setMemoryCapturePaused}
                compact={isMobile}
              />
            )}
            {!isMobile && (
              <ContextWindowPill
                conversationId={id ?? null}
                onCompact={id ? handleCompact : undefined}
              />
            )}
            <ModelSelector compact={isMobile} />
          </div>
        }
      />
      )}
      {/* Horizontal split — chat column on the left, artifact panel
          (when open) on the right with a draggable resizer between
          them. ``min-w-0`` on the chat column is critical: without
          it, long lines of code in assistant replies would force
          the column to its content width and squeeze the panel to
          zero. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {effectiveTemporaryMode && (
            <TemporaryChatBanner
              mode={effectiveTemporaryMode}
              expiresAt={conversation?.expires_at ?? null}
              // Conversion only applies once the chat is actually
              // persisted (an in-flight pre-creation selection has no
              // row to PATCH) and only for its owner.
              onKeep={
                id && isOwner && conversation?.temporary_mode
                  ? handleKeepChat
                  : undefined
              }
            />
          )}
          {conversation?.parent_conversation_id && (
            <BranchBanner
              parentId={conversation.parent_conversation_id}
              parentMessageId={conversation.parent_message_id ?? null}
            />
          )}
          {conversation?.workspace_id && (
            <WorkspaceBreadcrumb
              workspaceId={conversation.workspace_id}
              onBack={onExitToWorkspace}
            />
          )}
          {/* Context-window UI (pill + warning banner) is desktop-only
              — the mobile header has no space for the pill and the
              banner chews up precious vertical room above the chat.
              Users can still run into long conversations on mobile, but
              they'll just see a 5xx-style provider refusal once the
              window overflows; a noisy banner is the worse tradeoff. */}
          {id && isOwner && !isMobile && (
            <ContextWarningBanner
              conversationId={id}
              onCompact={handleCompact}
            />
          )}
          <StreamingAnnouncer streaming={isStreaming} />
          {(id || isStreaming) && (hasMessages || isStreaming) ? (
            <ChatWindow
              onEditAndResend={handleEditAndResend}
              onEditAssistant={id ? handleEditAssistant : undefined}
              participants={participants}
              onBranchFrom={id ? handleBranchFrom : undefined}
              onRegenerate={id ? handleRegenerate : undefined}
              onContinue={id ? handleContinue : undefined}
              onRetry={id ? handleRetry : undefined}
              onPickAnotherModel={handlePickAnotherModel}
              onDelete={id && isOwner ? handleDeleteMessage : undefined}
              onFeedback={id && isOwner ? handleMessageFeedback : undefined}
              onSelectVersion={id ? handleSelectVersion : undefined}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                hasModel={Boolean(selectedModel)}
                modelName={selectedModel?.display_name ?? null}
                workspaceId={conversation?.workspace_id ?? null}
                onSuggestion={(s) => handleSend(s)}
              />
            </div>
          )}
          {/* Phase 11 — live research progress. Shown between the message
              list and composer while a research job is running for this
              conversation. Disappears automatically when done. */}
          {researchRunning && id && (
            <ResearchProgressCard
              conversationId={id}
              onCancel={cancelResearch}
            />
          )}

          <InputBar
            streaming={isStreaming}
            disabled={!selectedModel}
            onSend={handleSend}
            onCancel={cancel}
            webSearchMode={webSearchMode}
            onWebSearchModeChange={handleWebSearchModeChange}
            reasoningEffort={reasoningEffort}
            // Shown only for models with a native reasoning knob (gated by
            // ``reasoningSupported`` → supports_native_reasoning).
            onReasoningEffortChange={
              reasoningSupported ? handleReasoningEffortChange : undefined
            }
            toolsEnabled={toolsEnabled}
            onToolsChange={handleToolsChange}
            onResearch={() => setResearchDialogOpen(true)}
            onVoiceMode={() => setVoiceModeOpen(true)}
            footer={footerText}
            autoFocus
            currentConversationId={id ?? null}
            workspaceId={conversation?.workspace_id ?? null}
            placeholder={
              selectedModel
                ? "Message Promptly... (@ to reference a chat)"
                : "Configure a model in the Models tab first"
            }
          />
        </div>
        {/* Code Artifact split-pane companion. Renders nothing when
            closed, so the chat column owns the full width by default.
            When open it self-mounts a draggable resizer + the panel
            aside as siblings of the chat column. */}
        <CodeArtifactPanel />
      </div>
      {/* Phase A3: side-panel Markdown editor for AI-generated PDFs.
          Renders into the same DOM tree but its fixed positioning takes
          it out of normal flow; null when no file is selected. */}
      <PdfEditorPanel />

      {/* Voice mode (Phase 2) — hands-free conversational overlay. Mounted
          only while open so all teardown lives in its unmount cleanup. */}
      {voiceModeOpen && (
        <VoiceModeOverlay
          onClose={() => setVoiceModeOpen(false)}
          onSend={(text) => void handleSend(text)}
          onCancelStream={cancel}
          modelReady={!!selectedModel}
        />
      )}

      {/* Phase 11 — Deep Research confirmation dialog. */}
      <ResearchDialog
        open={researchDialogOpen}
        initialQuery={composerDraft}
        onClose={() => setResearchDialogOpen(false)}
        onStart={async (query) => {
          if (!selectedModel) return;

          // For new (unsaved) chats, create a conversation first so
          // research has a persistent home and the URL updates.
          let convId = id;
          if (!convId) {
            try {
              const newConv = await chatApi.create({
                provider_id: selectedModel.provider_id,
                model_id: selectedModel.model_id,
              });
              convId = String(newConv.id);
              setActive(convId);
              upsertConversation(newConv);
              navigate(`/chat/${convId}`, { replace: true });
            } catch {
              return;
            }
          }

          void startResearch(convId, {
            query,
            provider_id: selectedModel.provider_id,
            model_id: selectedModel.model_id,
          });
        }}
      />
    </>
  );
}

interface BranchBannerProps {
  parentId: string;
  parentMessageId: string | null;
}

/** Breadcrumb above the message list when this chat lives under a
 *  :class:`Workspace`. Fetches the workspace title on demand so the
 *  bar actually reads as "Workspace: X" rather than just an ID link.
 *  Cheap single-query hit cached by TanStack — the workspace list /
 *  detail page queries share the cache key.
 *
 *  Also surfaces a "Retrieval on" badge when the workspace has flipped
 *  to semantic retrieval mode (indexed text exceeds ~6k tokens) so
 *  users understand why they might not see every pinned file verbatim
 *  in the context. */
function WorkspaceBreadcrumb({
  workspaceId,
  onBack,
}: {
  workspaceId: string;
  /** When embedded in the workspace shell, return to the workspace home
   *  in-place instead of navigating to the (already-current) route. */
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const { data: workspace } = useWorkspace(workspaceId);
  // Explicit "back to workspace" affordance rather than a subtle
  // breadcrumb link. Chats inside a workspace now carry the workspace's
  // shared context (system prompt, files, references, collaborators),
  // so the round-trip back to the workspace detail page — where all
  // sibling chats live — is a core navigation step users expect to
  // find with no hunting.
  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-xs">
      <button
        type="button"
        onClick={() =>
          onBack ? onBack() : navigate(`/workspaces/${workspaceId}`)
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition",
          "border-[var(--border)] text-[var(--text-muted)]",
          "hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
        )}
        title="Back to workspace home"
        aria-label="Back to workspace home"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to workspace
      </button>
      <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
        <FolderKanban className="h-3 w-3 text-[var(--accent)]" />
        <span className="truncate font-medium text-[var(--text)]">
          {workspace?.title ?? "Workspace"}
        </span>
      </span>
      {workspace?.retrieval_active && (
        <span
          title="This workspace uses semantic retrieval — only the most relevant chunks are included in context each turn"
          className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]"
        >
          <Zap className="h-2.5 w-2.5" />
          Retrieval on
        </span>
      )}
    </div>
  );
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

/**
 * Phase Z1 — tinted strip above the chat that announces "this is a
 * temporary chat" the way Chrome's incognito header does. Two
 * flavors:
 *   - ephemeral → ghost icon, neutral copy ("Disappears when you leave").
 *   - one_hour  → clock icon + a live countdown ("Expires in 47m").
 *
 * Mobile collapses the secondary copy so the strip stays a single
 * line and doesn't eat scroll real estate.
 */
function TemporaryChatBanner({
  mode,
  expiresAt,
  onKeep,
}: {
  mode: TemporaryMode;
  expiresAt: string | null;
  /** When provided, renders a "Keep this chat" action that promotes the
   *  temporary chat to a permanent one. Omitted for pre-creation
   *  selections (nothing to PATCH yet) and non-owners. */
  onKeep?: () => void | Promise<void>;
}) {
  const [keeping, setKeeping] = useState(false);
  // Tick once a minute for the 1-hour countdown so the visible "47m
  // remaining" stays roughly accurate without burning CPU.
  const [, force] = useState(0);
  useEffect(() => {
    if (mode !== "one_hour") return;
    const t = window.setInterval(() => force((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [mode]);

  const Icon = mode === "ephemeral" ? Ghost : Clock;
  const title =
    mode === "ephemeral" ? "Temporary chat" : "Temporary chat (1 hour)";

  let detail = "Disappears when you navigate away.";
  if (mode === "one_hour") {
    if (expiresAt) {
      const deltaMs = new Date(expiresAt).getTime() - Date.now();
      if (deltaMs <= 0) {
        detail = "Expiring now…";
      } else {
        const mins = Math.max(1, Math.round(deltaMs / 60_000));
        if (mins < 60) {
          detail = `Expires in ${mins}m. Sliding TTL — every message resets the timer.`;
        } else {
          const hrs = Math.floor(mins / 60);
          const remMins = mins % 60;
          detail = `Expires in ${hrs}h ${remMins}m. Sliding TTL — every message resets the timer.`;
        }
      }
    } else {
      detail = "Auto-deletes 1 hour after your last message.";
    }
  }

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 border-b px-4 py-2 text-xs",
        // Chrome-style tinted bar — distinct enough that you can't
        // miss it, calm enough that it doesn't scream. Uses amber
        // for the warm "temporary" feel so it doesn't clash with the
        // app's blue/violet accent.
        "border-amber-500/30 bg-amber-500/10 text-amber-800",
        "dark:text-amber-200"
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold">{title}</span>
      <span className="hidden text-amber-700/80 dark:text-amber-200/70 sm:inline">
        · {detail}
      </span>
      {onKeep && (
        <button
          type="button"
          disabled={keeping}
          onClick={() => {
            setKeeping(true);
            // Parent handler swallows its own errors + toasts; we just
            // need the spinner to clear if the row sticks around (it
            // unmounts on success, so this mostly matters on failure).
            void Promise.resolve(onKeep()).finally(() => setKeeping(false));
          }}
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 font-semibold transition",
            "border-amber-500/40 hover:bg-amber-500/20",
            "disabled:cursor-not-allowed disabled:opacity-60"
          )}
        >
          <Check className="h-3 w-3" />
          Keep this chat
        </button>
      )}
    </div>
  );
}
