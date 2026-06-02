import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Brain,
  Check,
  Eye,
  File as FileIcon,
  FileText,
  FlaskConical,
  Globe,
  GlobeLock,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  Wrench,
  X,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { filesApi } from "@/api/files";
import type { ReasoningEffort, WebSearchMode } from "@/api/types";
import { useInvalidateFiles } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useComposerStore } from "@/store/composerStore";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/utils/cn";

import {
  AttachmentPickerModal,
  type AttachedFile,
} from "./AttachmentPickerModal";
import {
  MentionAutocomplete,
  type MentionPickState,
} from "./MentionAutocomplete";
import {
  SlashCommandAutocomplete,
  type SlashPickState,
} from "./SlashCommandAutocomplete";
import {
  EFFORT_META,
  EFFORT_ORDER,
} from "./ReasoningEffortToggle";

interface InputBarProps {
  disabled?: boolean;
  streaming?: boolean;
  onSend: (text: string, attachments: AttachedFile[]) => void;
  onCancel?: () => void;
  placeholder?: string;
  /** Three-mode web-search picker (Phase D1). When omitted the picker
   *  stays hidden — used by surfaces (e.g. study sessions) that don't
   *  expose web search at all. */
  webSearchMode?: WebSearchMode;
  onWebSearchModeChange?: (mode: WebSearchMode) => void;
  /** DeepSeek-only reasoning picker. Both props must be present for the
   *  picker to render — surfaces hide it for non-DeepSeek models so it
   *  doesn't take up composer real estate where it would no-op. */
  reasoningEffort?: ReasoningEffort | null;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  toolsEnabled?: boolean;
  onToolsChange?: (enabled: boolean) => void;
  footer?: React.ReactNode;
  /**
   * Set to false to hide the paperclip button (used e.g. by the study
   * session view where attachments don't apply yet).
   */
  allowAttachments?: boolean;
  /** Phase 11 — open the deep-research confirmation dialog. Only provided
   *  on the main chat surface; study/task views omit it. */
  onResearch?: () => void;
  /**
   * Focus the textarea on mount. Use on surfaces where the student's
   * primary intent is to type — chat / study pages — so the user can
   * start typing immediately without having to click into the field.
   * Uses ``preventScroll`` so we don't jerk the page when focus lands
   * on a long chat history.
   */
  autoFocus?: boolean;
  /** Phase C — enable ``@`` references. Required for the picker to
   *  filter out the current chat and prioritise project siblings.
   *  Pass ``null`` for a not-yet-persisted chat; mentions still work
   *  but the "exclude self" step is a no-op. */
  currentConversationId?: string | null;
  projectId?: string | null;
  /** When true, Enter inserts a newline instead of sending. The send
   *  button is the only submission path. Used by the study session
   *  page where students write multi-line answers. */
  newlineOnEnter?: boolean;
}

/** Pending in-flight upload tracked alongside finished attachments. */
interface PendingUpload {
  /** Local-only id so React has something stable to key on while uploading. */
  tempId: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  error?: string;
}

export function InputBar({
  disabled,
  streaming,
  onSend,
  onCancel,
  placeholder = "Message Promptly...",
  webSearchMode = "off",
  onWebSearchModeChange,
  reasoningEffort = null,
  onReasoningEffortChange,
  toolsEnabled = false,
  onToolsChange,
  footer,
  allowAttachments = true,
  autoFocus = false,
  currentConversationId = null,
  projectId = null,
  onResearch,
  newlineOnEnter = false,
}: InputBarProps) {
  // Persist the draft (text + attachments) in a module-level store so a
  // mobile rotation that flips the AppLayout tree (crossing the 768px
  // breakpoint) and remounts this component doesn't wipe what the user
  // was composing. Keyed per conversation; "__new__" for unsaved chats.
  const draftKey = currentConversationId ?? "__new__";
  // Read once on mount via the lazy initialiser so a remount restores
  // the persisted draft instead of starting blank.
  const [value, setValue] = useState(
    () => useComposerStore.getState().getDraft(draftKey)?.text ?? ""
  );
  const [attachments, setAttachments] = useState<AttachedFile[]>(
    () => useComposerStore.getState().getDraft(draftKey)?.attachments ?? []
  );
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // Caret position inside ``value``. Refreshed on every key / click
  // so the mention popover can detect when the user is mid-``@``.
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Registered by ``MentionAutocomplete`` so we can forward key
  // events to the popover before applying our own (Enter = send)
  // logic. Stored in a ref so re-registers don't cause re-renders.
  const mentionKeyHandler = useRef<
    ((e: { key: string }) => boolean) | null
  >(null);
  const registerMentionKeys = useCallback(
    (handler: (e: { key: string }) => boolean) => {
      mentionKeyHandler.current = handler;
    },
    []
  );
  // Same forwarding mechanism for the ``/`` slash-command popover.
  const slashKeyHandler = useRef<((e: { key: string }) => boolean) | null>(
    null
  );
  const registerSlashKeys = useCallback(
    (handler: (e: { key: string }) => boolean) => {
      slashKeyHandler.current = handler;
    },
    []
  );

  // Which conversation the current ``value`` / ``attachments`` belong
  // to. Tracked in a ref (not just ``draftKey``) because the route can
  // change the key *in place* — both ``/chat`` and ``/chat/:id`` render
  // the same ``ChatPage``, so switching conversations may update the
  // prop without remounting us. Saving under the *loaded* key rather
  // than the latest ``draftKey`` prevents one chat's draft bleeding
  // into another during that transition.
  const loadedDraftKeyRef = useRef(draftKey);

  // Mirror the live draft into the composer store on every change so a
  // remount (e.g. mobile rotation crossing the AppLayout breakpoint)
  // can restore it. Empty drafts are cleared rather than stored so we
  // don't leak blank per-conversation entries.
  useEffect(() => {
    const key = loadedDraftKeyRef.current;
    if (value.trim() === "" && attachments.length === 0) {
      useComposerStore.getState().clearDraft(key);
    } else {
      useComposerStore.getState().saveDraft(key, { text: value, attachments });
    }
  }, [value, attachments]);

  // Conversation switched without a remount: the outgoing draft is
  // already persisted under its old key by the effect above, so just
  // load the new key's draft (if any) and re-point the tracking ref.
  useEffect(() => {
    if (loadedDraftKeyRef.current === draftKey) return;
    loadedDraftKeyRef.current = draftKey;
    const draft = useComposerStore.getState().getDraft(draftKey);
    setValue(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
  }, [draftKey]);

  // Replace the in-progress ``@query`` with a resolved token and
  // advance the caret to sit right after the inserted token. Wrapped
  // in ``setTimeout(0)`` to reassign the textarea's selectionStart
  // only after React has applied the new value — otherwise we'd be
  // writing to a stale DOM node.
  const handleMentionInsert = useCallback(
    (token: string, pick: MentionPickState) => {
      const before = value.slice(0, pick.startIndex);
      const after = value.slice(pick.endIndex);
      const next = `${before}${token} ${after}`;
      setValue(next);
      const newCaret = pick.startIndex + token.length + 1;
      setCaret(newCaret);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        try {
          el.setSelectionRange(newCaret, newCaret);
        } catch {
          // older browsers
        }
      });
    },
    [value]
  );

  // Phase 3.1 — replace the leading ``/query`` with a saved prompt's
  // body and drop the caret at the end so the user can keep typing.
  const handleSlashApply = useCallback(
    (body: string, pick: SlashPickState) => {
      const after = value.slice(pick.endIndex);
      const next = `${body}${after}`;
      setValue(next);
      const newCaret = body.length;
      setCaret(newCaret);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        try {
          el.setSelectionRange(newCaret, newCaret);
        } catch {
          // older browsers
        }
      });
    },
    [value]
  );
  const invalidateFiles = useInvalidateFiles();
  const isMobile = useIsMobile();
  const selectedModel = useModelStore((s) =>
    s.available.find(
      (m) =>
        m.provider_id === s.selectedProviderId &&
        m.model_id === s.selectedModelId
    ) ?? null
  );
  const visionRelayProviderId = useModelStore((s) => s.visionRelayProviderId);
  const visionRelayModelId = useModelStore((s) => s.visionRelayModelId);
  const relayConfigured = !!visionRelayProviderId && !!visionRelayModelId;
  // Resolve the relay's *display* name from the catalog so the chip
  // can say something like "described by GPT-4o" instead of leaking
  // the raw model slug. Catalog lookup falls through gracefully — if
  // the model isn't in the user's list (e.g. an admin pointed the
  // relay at a custom-models entry the user can't see), we show the
  // bare id rather than nothing.
  const relayModel = useModelStore((s) =>
    s.available.find(
      (m) =>
        m.provider_id === visionRelayProviderId &&
        m.model_id === visionRelayModelId,
    ) ?? null,
  );
  const relayLabel = relayConfigured
    ? relayModel?.display_name || visionRelayModelId
    : null;

  const dropAllowed = allowAttachments && !disabled && !streaming;

  // Surface a heads-up *before* send when an image is queued and the
  // currently-selected model can't read images. The backend will also
  // emit a vision_warning post-send, but catching it client-side avoids
  // a wasted round-trip and lets the user pick a different model first.
  //
  // Two flavours of chip:
  //
  // 1. **Relay configured** — informational indigo chip explaining
  //    that the image will be captioned by the relay model before
  //    the chat model sees it. This is the "everything's fine, just
  //    so you know" case — no action needed, and the user can still
  //    pick a native-vision model if they want a higher-fidelity
  //    response.
  // 2. **Relay NOT configured** — amber warning explaining that the
  //    image will be silently dropped. Original behaviour, preserved
  //    so installs that haven't opted into the relay still see the
  //    accurate "your image is going nowhere" message.
  const hasImageAttachment = attachments.some((a) =>
    (a.mime_type || "").toLowerCase().startsWith("image/")
  );
  const visionMismatch =
    hasImageAttachment && selectedModel !== null && !selectedModel.supports_vision;
  // Edge case: the admin pointed the relay at the *same* model the
  // user happens to be chatting with. Don't show a chip at all —
  // it'd be confusing ("X can't read images, but X will translate
  // for X") and the relay code path would no-op anyway.
  const relayIsSelectedModel =
    relayConfigured &&
    selectedModel !== null &&
    visionRelayProviderId === selectedModel.provider_id &&
    visionRelayModelId === selectedModel.model_id;
  const showVisionDrop = visionMismatch && !relayConfigured;
  const showVisionRelay =
    visionMismatch && relayConfigured && !relayIsSelectedModel;

  // Auto-grow the textarea up to ~8 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  // One-shot focus on mount so new chats / study sessions land the
  // cursor in the composer without the user having to click first.
  // ``preventScroll`` keeps long chat histories from jumping to the
  // bottom when focus lands.
  useEffect(() => {
    if (!autoFocus) return;
    if (disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    // Only run on mount — re-focusing on every render would steal
    // focus away from other inputs (model picker, settings popovers)
    // as soon as the user opens them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 3.3 — focus on demand from a global shortcut (new chat /
  // "/"). The store bumps ``focusNonce``; we focus on every change
  // *after* the initial mount (nonce starts at 0, so the first render
  // is a no-op and doesn't double up with the autoFocus effect above).
  const focusNonce = useComposerStore((s) => s.focusNonce);
  useEffect(() => {
    if (focusNonce === 0) return;
    if (disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, [focusNonce, disabled]);

  // ----------------------------------------------------------------
  // Upload helper — dropped files & paste-uploads share this path so the
  // chip lifecycle stays consistent.
  // ----------------------------------------------------------------
  const uploadDroppedFile = useCallback(
    async (file: File) => {
      const tempId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      setPending((prev) => [
        ...prev,
        {
          tempId,
          filename: file.name,
          size_bytes: file.size,
          mime_type: file.type || "application/octet-stream",
        },
      ]);
      try {
        // ``route: "chat"`` tells the backend to drop the file into
        // the user's "Chat Uploads" system folder so the Files page
        // doesn't get cluttered with one-off attachments.
        const result = await filesApi.upload("mine", file, null, "chat");
        setPending((prev) => prev.filter((p) => p.tempId !== tempId));
        setAttachments((prev) => {
          if (prev.some((a) => a.id === result.id)) return prev;
          return [
            ...prev,
            {
              id: result.id,
              filename: result.filename,
              mime_type: result.mime_type,
              size_bytes: result.size_bytes,
            },
          ];
        });
        // Keep the Files page in sync so the user sees the new upload there.
        invalidateFiles("mine");
      } catch (e) {
        const msg = extractError(e);
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === tempId ? { ...p, error: msg } : p
          )
        );
      }
    },
    [invalidateFiles]
  );

  // ----------------------------------------------------------------
  // Clipboard paste — lets the user Ctrl/Cmd+V a screenshot (or any
  // image they copied from a browser / editor) straight into the
  // composer. We reuse ``uploadDroppedFile`` so pasted images flow
  // through the exact same pending → attached chip lifecycle as
  // drag-drop and the file picker.
  //
  // Plain text pastes are left untouched: we only call
  // ``preventDefault`` when at least one image was actually handled,
  // otherwise the browser's default paste behaviour (inserting the
  // clipboard text into the textarea) still works.
  // ----------------------------------------------------------------
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!allowAttachments || disabled || streaming) return;
      const data = event.clipboardData;
      if (!data) return;

      const images: File[] = [];
      // ``items`` is the richer API (gives us screenshots that
      // browsers expose as ``image/png`` entries with no filename);
      // fall back to ``files`` for older surfaces.
      if (data.items && data.items.length > 0) {
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i];
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        }
      }
      if (images.length === 0 && data.files && data.files.length > 0) {
        for (let i = 0; i < data.files.length; i++) {
          const file = data.files[i];
          if (file.type.startsWith("image/")) images.push(file);
        }
      }

      if (images.length === 0) return;
      event.preventDefault();
      for (const file of images) {
        // Screenshots often come through with a generic ``image.png``
        // name (or none at all). Stamp them with a timestamp so the
        // chip label and the Files page entry are distinguishable.
        const named =
          file.name && file.name !== "image.png"
            ? file
            : new File(
                [file],
                `pasted-${new Date()
                  .toISOString()
                  .replace(/[:.]/g, "-")}.${
                  (file.type.split("/")[1] || "png").toLowerCase()
                }`,
                { type: file.type || "image/png" }
              );
        void uploadDroppedFile(named);
      }
    },
    [allowAttachments, disabled, streaming, uploadDroppedFile]
  );

  // ----------------------------------------------------------------
  // Window-level drag listeners. We use a counter to track nested
  // dragenter/dragleave events so the overlay doesn't flicker as the
  // pointer moves over child elements.
  // ----------------------------------------------------------------
  useEffect(() => {
    if (!dropAllowed) {
      setIsDragging(false);
      return;
    }

    let dragDepth = 0;

    const hasFiles = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // Different browsers report this differently; check both shapes.
      if (Array.isArray(types)) return types.includes("Files");
      // DOMStringList in older specs
      for (let i = 0; i < types.length; i++) {
        if ((types as unknown as { [k: number]: string })[i] === "Files") {
          return true;
        }
      }
      return false;
    };

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth += 1;
      setIsDragging(true);
    };

    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDragging(false);
    };

    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Required to allow a drop on this element.
      e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      for (const f of files) {
        void uploadDroppedFile(f);
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [dropAllowed, uploadDroppedFile]);

  const submit = () => {
    const trimmed = value.trim();
    // Same rule as before: a non-empty text body is required even when files
    // are attached — the model needs an actual question.
    if (!trimmed || disabled || streaming) return;
    // Don't send while a drop is still uploading. Cheaper UX than dropping
    // the file silently.
    if (pending.some((p) => !p.error)) return;
    if (speech.isListening) speech.stop();
    onSend(trimmed, attachments);
    setValue("");
    setAttachments([]);
    setPending([]);
    // Clear synchronously too: ``onSend`` may navigate (new chat → its
    // saved id), unmounting us before the sync effect's cleared write
    // lands, which would otherwise leave a stale draft behind.
    useComposerStore.getState().clearDraft(loadedDraftKeyRef.current);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Give the @-mention popover first crack at navigation keys.
    // If it consumes (Up/Down/Enter/Tab while open, Esc), we stop
    // here and don't fall through to Enter-to-send.
    if (mentionKeyHandler.current) {
      const consumed = mentionKeyHandler.current({ key: e.key });
      if (consumed) {
        e.preventDefault();
        return;
      }
    }
    // Then the ``/`` slash-command popover (mutually exclusive with
    // the mention popover, so order is harmless).
    if (slashKeyHandler.current) {
      const consumed = slashKeyHandler.current({ key: e.key });
      if (consumed) {
        e.preventDefault();
        return;
      }
    }
    // On mobile, or when newlineOnEnter is set (e.g. study sessions),
    // Enter inserts a newline. Submit only via the send button.
    if (isMobile || newlineOnEnter) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Keep the caret ref in sync with whatever the textarea's browser-
  // managed selection is at any given moment. ``onSelect`` covers
  // the mouse/keyboard/IME paths; combined with the setValue path
  // below we always know where the caret is when we render the
  // autocomplete.
  const syncCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? 0);
  }, []);

  // Voice dictation (Phase 2.1). The hook delivers finalised chunks via
  // ``onFinal``; we append each to the composer with sensible spacing.
  // Hidden entirely when the Web Speech API is unavailable.
  const speech = useSpeechRecognition({
    onFinal: (chunk) => {
      const piece = chunk.trim();
      if (!piece) return;
      setValue((prev) => {
        const needsSpace =
          prev.length > 0 && !/\s$/.test(prev);
        return `${prev}${needsSpace ? " " : ""}${piece}`;
      });
    },
  });

  // Phase 3.2 — Enhance prompt. ``preview`` holds the model's rewrite
  // until the user accepts or discards it, so we never silently overwrite
  // what they typed.
  const [enhanceStatus, setEnhanceStatus] = useState<
    "idle" | "loading" | "preview" | "error"
  >("idle");
  const [enhancePreview, setEnhancePreview] = useState("");
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  const handleEnhance = useCallback(async () => {
    const draft = value.trim();
    if (!draft || enhanceStatus === "loading") return;
    if (!selectedModel) {
      setEnhanceStatus("error");
      setEnhanceError("Pick a model first.");
      return;
    }
    setEnhanceStatus("loading");
    setEnhanceError(null);
    try {
      const improved = await chatApi.enhancePrompt(
        draft,
        selectedModel.provider_id,
        selectedModel.model_id
      );
      const cleaned = improved.trim();
      if (!cleaned || cleaned === draft) {
        // Nothing meaningfully changed — don't make the user diff two
        // identical blocks. Quietly reset.
        setEnhanceStatus("idle");
        return;
      }
      setEnhancePreview(cleaned);
      setEnhanceStatus("preview");
    } catch (e) {
      setEnhanceStatus("error");
      setEnhanceError(extractError(e));
    }
  }, [value, enhanceStatus, selectedModel]);

  const acceptEnhance = useCallback(() => {
    setValue(enhancePreview);
    setEnhanceStatus("idle");
    setEnhancePreview("");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = enhancePreview.length;
      try {
        el.setSelectionRange(end, end);
      } catch {
        // older browsers
      }
    });
  }, [enhancePreview]);

  const dismissEnhance = useCallback(() => {
    setEnhanceStatus("idle");
    setEnhancePreview("");
    setEnhanceError(null);
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const removePending = (tempId: string) => {
    setPending((prev) => prev.filter((p) => p.tempId !== tempId));
  };

  const uploadingCount = pending.filter((p) => !p.error).length;
  const sendDisabled =
    disabled ||
    streaming ||
    value.trim().length === 0 ||
    uploadingCount > 0;

  return (
    <div className="relative border-t border-[var(--border)] bg-[var(--bg)] px-4 py-4 pb-safe-toolbar pl-safe pr-safe">
      {dropAllowed && isDragging && <DropOverlay />}

      <MentionAutocomplete
        textareaRef={textareaRef}
        value={value}
        caret={caret}
        onInsert={handleMentionInsert}
        currentConversationId={currentConversationId}
        projectId={projectId}
        onKeyRegister={registerMentionKeys}
      />

      <SlashCommandAutocomplete
        textareaRef={textareaRef}
        value={value}
        caret={caret}
        onApply={handleSlashApply}
        onKeyRegister={registerSlashKeys}
      />

      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "flex flex-col gap-2 rounded-card border px-3 py-2 shadow-sm transition",
            "border-[var(--border)] bg-[var(--surface)]",
            "focus-within:border-[var(--accent)]/60",
            isDragging && dropAllowed && "border-[var(--accent)]/60"
          )}
        >
          {(attachments.length > 0 || pending.length > 0) && (
            <div className="flex flex-wrap gap-1.5 pb-1">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  file={a}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
              {pending.map((p) => (
                <PendingChip
                  key={p.tempId}
                  pending={p}
                  onRemove={() => removePending(p.tempId)}
                />
              ))}
            </div>
          )}
          {showVisionDrop && (
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]",
                "bg-amber-500/10 text-amber-700 dark:text-amber-300"
              )}
              role="status"
            >
              <Eye className="h-3 w-3 shrink-0" />
              <span className="leading-snug">
                {selectedModel?.display_name ?? "This model"} can't read
                images. Pick a vision-capable model to have it actually
                see your attachment.
              </span>
            </div>
          )}
          {showVisionRelay && (
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]",
                // Indigo + Eye glyph mirrors the in-stream relay chip
                // so users can visually link the pre-send heads-up
                // with the chip that lights up during the turn.
                "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
              )}
              role="status"
              title={`Image will be described by ${relayLabel} before ${selectedModel?.display_name ?? "the model"} responds.`}
            >
              <Eye className="h-3 w-3 shrink-0" />
              <span className="leading-snug">
                {selectedModel?.display_name ?? "This model"} can't see
                images natively, so they'll be described by{" "}
                <span className="font-medium">{relayLabel}</span> first.
              </span>
            </div>
          )}
          {speech.isListening && (
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]",
                "bg-red-500/10 text-red-600 dark:text-red-400"
              )}
              role="status"
            >
              <Mic className="h-3 w-3 shrink-0 animate-pulse" />
              <span className="leading-snug">
                {speech.interimText || "Listening… speak now."}
              </span>
            </div>
          )}
          {enhanceStatus === "loading" && (
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]",
                "bg-[var(--accent)]/10 text-[var(--accent)]"
              )}
              role="status"
            >
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              <span className="leading-snug">Enhancing your prompt…</span>
            </div>
          )}
          {enhanceStatus === "error" && enhanceError && (
            <div
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px]",
                "bg-amber-500/10 text-amber-700 dark:text-amber-300"
              )}
              role="alert"
            >
              <span className="leading-snug">
                Couldn't enhance: {enhanceError}
              </span>
              <button
                onClick={dismissEnhance}
                className="shrink-0 rounded p-0.5 hover:bg-[var(--hover-strong)]"
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {enhanceStatus === "preview" && (
            <div
              className={cn(
                "rounded-md border px-2.5 py-2 text-xs",
                "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]"
              )}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)]">
                <Sparkles className="h-3 w-3" />
                Enhanced prompt
              </div>
              <p className="promptly-scroll max-h-40 overflow-y-auto whitespace-pre-wrap leading-snug text-[var(--text)]">
                {enhancePreview}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={acceptEnhance}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
                >
                  <Check className="h-3 w-3" /> Use this
                </button>
                <button
                  onClick={dismissEnhance}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] hover:bg-[var(--hover)]"
                >
                  Keep mine
                </button>
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              // Caret moves implicitly after typing; read it from
              // the DOM after React flushes the new value.
              requestAnimationFrame(syncCaret);
            }}
            onKeyDown={handleKey}
            onKeyUp={syncCaret}
            onSelect={syncCaret}
            onClick={syncCaret}
            onPaste={handlePaste}
            placeholder={placeholder}
            rows={1}
            disabled={disabled}
            className={cn(
              "promptly-scroll max-h-[220px] min-h-[28px] w-full resize-none bg-transparent px-1 py-1",
              "text-sm text-[var(--text)] placeholder:text-[var(--text-muted)]",
              "focus:outline-none disabled:opacity-60"
            )}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {allowAttachments && (
                <button
                  onClick={() => setPickerOpen(true)}
                  disabled={disabled || streaming}
                  className={cn(
                    "inline-flex items-center rounded-full border transition",
                    "border-[var(--border)] text-[var(--text-muted)]",
                    "hover:border-[var(--accent)]/60 hover:text-[var(--text)]",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    // Mobile: icon-only circle, matching Web/Tools
                    // toggles for a consistent four-pill row.
                    isMobile
                      ? "h-9 w-9 justify-center"
                      : "h-8 gap-1.5 px-2.5 text-xs"
                  )}
                  aria-label="Attach files"
                  title="Attach files"
                >
                  <Paperclip
                    className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"}
                  />
                  {!isMobile && <span className="font-medium">Attach</span>}
                </button>
              )}
              {/* Phase 10 — Enhance always visible in the main bar. */}
              <button
                type="button"
                onClick={() => void handleEnhance()}
                disabled={
                  disabled ||
                  streaming ||
                  value.trim().length === 0 ||
                  enhanceStatus === "loading"
                }
                title="Enhance prompt — rewrite for a sharper answer"
                className={cn(
                  "inline-flex items-center rounded-full border transition",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  isMobile ? "h-9 w-9 justify-center" : "h-8 gap-1.5 px-2.5 text-xs",
                  enhanceStatus === "loading"
                    ? "border-[var(--accent)]/60 text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/60 hover:text-[var(--accent)]"
                )}
              >
                {enhanceStatus === "loading" ? (
                  <Loader2 className={cn(isMobile ? "h-4 w-4" : "h-3.5 w-3.5", "animate-spin")} />
                ) : (
                  <Sparkles className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
                )}
                {!isMobile && <span className="font-medium">Enhance</span>}
              </button>
              {speech.supported && (
                <button
                  type="button"
                  onClick={() => speech.toggle()}
                  disabled={disabled || streaming}
                  className={cn(
                    "inline-flex items-center rounded-full border transition",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    speech.isListening
                      ? "border-red-500/60 bg-red-500/10 text-red-600 dark:text-red-400"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/60 hover:text-[var(--text)]",
                    isMobile
                      ? "h-9 w-9 justify-center"
                      : "h-8 gap-1.5 px-2.5 text-xs"
                  )}
                  aria-label={
                    speech.isListening ? "Stop dictation" : "Dictate message"
                  }
                  aria-pressed={speech.isListening}
                  title={
                    speech.isListening
                      ? "Stop dictation"
                      : "Dictate — speak to type"
                  }
                >
                  <Mic
                    className={cn(
                      isMobile ? "h-4 w-4" : "h-3.5 w-3.5",
                      speech.isListening && "animate-pulse"
                    )}
                  />
                  {!isMobile && (
                    <span className="font-medium">
                      {speech.isListening ? "Listening…" : "Voice"}
                    </span>
                  )}
                </button>
              )}
              <ComposerMoreMenu
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
                webSearchMode={webSearchMode}
                onWebSearchModeChange={onWebSearchModeChange}
                toolsEnabled={toolsEnabled}
                onToolsChange={onToolsChange}
                onResearch={onResearch}
                researchDisabled={disabled || streaming || value.trim().length === 0}
                disabled={disabled || streaming}
              />
            </div>
            {streaming ? (
              <button
                onClick={onCancel}
                className={cn(
                  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                  "bg-[var(--text)] text-[var(--bg)] transition hover:opacity-90"
                )}
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={sendDisabled}
                className={cn(
                  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition",
                  "bg-[var(--accent)] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                )}
                aria-label="Send message"
                title={
                  uploadingCount > 0
                    ? "Waiting for uploads to finish..."
                    : newlineOnEnter
                    ? "Send"
                    : "Send (Enter)"
                }
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        {/* Footer row is desktop-only. On mobile we hide it entirely so
            the composer hugs the bottom safe-area inset and the
            on-screen keyboard doesn't fight a redundant strip of
            text. The web-search mode is still discoverable via the
            pill above; the keyboard hint is meaningless on touch. */}
        <div className="mt-1.5 hidden items-center justify-between gap-3 text-[11px] text-[var(--text-muted)] md:flex">
          <span className="truncate">
            {uploadingCount > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Uploading {uploadingCount} file{uploadingCount === 1 ? "" : "s"}
                ...
              </span>
            ) : allowAttachments ? (
              <span>
                {footer}
                {footer ? " · " : ""}Drop files here to attach
              </span>
            ) : (
              footer
            )}
          </span>
          <span className="shrink-0">
            {newlineOnEnter ? "Click send to submit" : "Enter to send · Shift+Enter for newline"}
          </span>
        </div>
      </div>

      {allowAttachments && (
        <AttachmentPickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          alreadyAttached={attachments}
          onAttach={(files) => {
            setAttachments((prev) => {
              const existingIds = new Set(prev.map((a) => a.id));
              const merged = [...prev];
              for (const f of files) {
                if (!existingIds.has(f.id)) {
                  merged.push(f);
                }
              }
              return merged;
            });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Composer "More" menu — keeps the action row uncluttered for casual
// users by tucking the lower-frequency controls (reasoning effort,
// enhance-prompt) behind a single ⋯-style affordance. Power users get
// everything one tap deeper. The reasoning options render *inline*
// here rather than nesting the standalone ReasoningEffortToggle's own
// popover (which would clip), reusing its shared EFFORT_META/ORDER.
// Opens upward like the other composer popovers.
// ----------------------------------------------------------------
const WEB_LABELS: Record<WebSearchMode, string> = {
  off: "Off",
  auto: "Auto",
  always: "Always",
};
const WEB_ORDER: WebSearchMode[] = ["off", "auto", "always"];

// Phase 10 — Web + Tools moved inside More; Enhance moves to the main bar.
// Phase 11 — Deep Research action added at the bottom.
function ComposerMoreMenu({
  reasoningEffort,
  onReasoningEffortChange,
  webSearchMode,
  onWebSearchModeChange,
  toolsEnabled,
  onToolsChange,
  onResearch,
  researchDisabled,
  disabled,
}: {
  reasoningEffort: ReasoningEffort | null;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  webSearchMode: WebSearchMode;
  onWebSearchModeChange?: (mode: WebSearchMode) => void;
  toolsEnabled: boolean;
  onToolsChange?: (enabled: boolean) => void;
  onResearch?: () => void;
  researchDisabled?: boolean;
  disabled?: boolean;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const displayEffort: ReasoningEffort = reasoningEffort ?? "medium";
  const reasoningActive =
    !!onReasoningEffortChange &&
    reasoningEffort !== null &&
    reasoningEffort !== "off";

  const hasWebSection = !!onWebSearchModeChange;
  const hasToolsSection = !!onToolsChange;
  const hasReasoningSection = !!onReasoningEffortChange;
  const hasResearchSection = !!onResearch;
  const hasAnySection = hasWebSection || hasToolsSection || hasReasoningSection || hasResearchSection;

  if (!hasAnySection) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More options"
        title="More — web search, tools, reasoning effort"
        className={cn(
          "inline-flex items-center rounded-full border transition",
          "disabled:cursor-not-allowed disabled:opacity-40",
          isMobile ? "h-9 w-9 justify-center" : "h-8 gap-1.5 px-2.5 text-xs",
          open || reasoningActive
            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
            : "border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
        )}
      >
        <SlidersHorizontal className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!isMobile && <span className="font-medium">More</span>}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full left-0 z-30 mb-2 w-64 origin-bottom-left",
            "rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-lg",
            "p-1 text-sm"
          )}
        >
          {/* Web search section */}
          {hasWebSection && (
            <>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {webSearchMode === "off" ? (
                  <GlobeLock className="h-3 w-3" />
                ) : (
                  <Globe className="h-3 w-3" />
                )}
                Web search
              </div>
              {WEB_ORDER.map((value) => {
                const selected = value === webSearchMode;
                return (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => onWebSearchModeChange!(value)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition",
                      "hover:bg-[var(--accent)]/[0.08]",
                      selected && "bg-[var(--accent)]/[0.06]"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-4 w-4 shrink-0 items-center justify-center",
                        selected ? "text-[var(--accent)]" : "text-transparent"
                      )}
                      aria-hidden
                    >
                      <Check className="h-4 w-4" />
                    </span>
                    <span
                      className={cn(
                        "text-sm font-medium",
                        selected ? "text-[var(--accent)]" : "text-[var(--text)]"
                      )}
                    >
                      {WEB_LABELS[value]}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {/* Tools toggle */}
          {hasToolsSection && (
            <>
              {hasWebSection && <div className="my-1 border-t border-[var(--border)]" />}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={toolsEnabled}
                onClick={() => onToolsChange!(!toolsEnabled)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition",
                  "hover:bg-[var(--accent)]/[0.08]",
                  toolsEnabled && "bg-[var(--accent)]/[0.06]"
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-4 w-4 shrink-0 items-center justify-center",
                    toolsEnabled ? "text-[var(--accent)]" : "text-transparent"
                  )}
                  aria-hidden
                >
                  <Check className="h-4 w-4" />
                </span>
                <span className="flex items-center gap-1.5">
                  <Wrench className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <span
                    className={cn(
                      "text-sm font-medium",
                      toolsEnabled ? "text-[var(--accent)]" : "text-[var(--text)]"
                    )}
                  >
                    AI tools
                  </span>
                </span>
              </button>
            </>
          )}

          {/* Deep Research action */}
          {hasResearchSection && (
            <>
              {(hasWebSection || hasToolsSection || hasReasoningSection) && (
                <div className="my-1 border-t border-[var(--border)]" />
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onResearch!();
                }}
                disabled={researchDisabled}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition",
                  "hover:bg-[var(--accent)]/[0.08]",
                  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                )}
              >
                <FlaskConical className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--text)]">
                    Deep Research
                  </span>
                  <span className="block text-xs leading-snug text-[var(--text-muted)]">
                    Multi-source investigation with cited report.
                  </span>
                </span>
              </button>
            </>
          )}

          {/* Reasoning effort (DeepSeek only) */}
          {hasReasoningSection && (
            <>
              {(hasWebSection || hasToolsSection) && (
                <div className="my-1 border-t border-[var(--border)]" />
              )}
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                <Brain className="h-3 w-3" />
                Reasoning effort
              </div>
              {EFFORT_ORDER.map((value) => {
                const m = EFFORT_META[value];
                const selected = value === displayEffort;
                return (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => onReasoningEffortChange!(value)}
                    title={m.description}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition",
                      "hover:bg-[var(--accent)]/[0.08]",
                      selected && "bg-[var(--accent)]/[0.06]"
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-4 w-4 shrink-0 items-center justify-center",
                        selected ? "text-[var(--accent)]" : "text-transparent"
                      )}
                      aria-hidden
                    >
                      <Check className="h-4 w-4" />
                    </span>
                    <span
                      className={cn(
                        "text-sm font-medium",
                        selected ? "text-[var(--accent)]" : "text-[var(--text)]"
                      )}
                    >
                      {m.label}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Drop overlay — fills the viewport while files are being dragged.
// Pointer-events:none so the underlying drag/drop logic still gets
// the events; the overlay is purely visual.
// ----------------------------------------------------------------
function DropOverlay() {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center",
        "bg-[var(--bg)]/80 backdrop-blur-sm"
      )}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-3 rounded-card border-2 border-dashed px-10 py-8 text-center",
          "border-[var(--accent)] bg-[var(--surface)] shadow-lg"
        )}
      >
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-full",
            "bg-[var(--accent)]/10 text-[var(--accent)]"
          )}
        >
          <Upload className="h-6 w-6" />
        </div>
        <div>
          <div className="text-base font-semibold text-[var(--text)]">
            Drop to attach
          </div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            Files will upload to your "My files" pool · up to 40 MB each
          </div>
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  file,
  onRemove,
}: {
  file: AttachedFile;
  onRemove: () => void;
}) {
  const Icon = pickIcon(file.mime_type);
  return (
    <div
      className={cn(
        "inline-flex max-w-xs items-center gap-1.5 rounded-full border px-2 py-1 text-xs",
        "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
      )}
      title={`${file.filename} · ${humanSize(file.size_bytes)}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
      <span className="truncate">{file.filename}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 text-[var(--text-muted)] hover:bg-black/[0.06] hover:text-[var(--text)] dark:hover:bg-white/[0.08]"
        aria-label={`Remove ${file.filename}`}
        title="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function PendingChip({
  pending,
  onRemove,
}: {
  pending: PendingUpload;
  onRemove: () => void;
}) {
  const errored = Boolean(pending.error);
  return (
    <div
      className={cn(
        "inline-flex max-w-xs items-center gap-1.5 rounded-full border px-2 py-1 text-xs",
        errored
          ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]"
      )}
      title={
        errored
          ? `${pending.filename} — ${pending.error}`
          : `Uploading ${pending.filename}...`
      }
    >
      {errored ? (
        <X className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
      )}
      <span className="truncate">{pending.filename}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--hover-strong)]"
        aria-label={`Remove ${pending.filename}`}
        title="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function pickIcon(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  )
    return FileText;
  return FileIcon;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extractError(e: unknown): string {
  if (typeof e === "object" && e && "response" in e) {
    const resp = (e as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
