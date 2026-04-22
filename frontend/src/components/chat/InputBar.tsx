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
  Eye,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Square,
  Upload,
  X,
} from "lucide-react";

import { filesApi } from "@/api/files";
import type { WebSearchMode } from "@/api/types";
import { useInvalidateFiles } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/utils/cn";

import {
  AttachmentPickerModal,
  type AttachedFile,
} from "./AttachmentPickerModal";
import { ToolsToggle } from "./ToolsToggle";
import { WebSearchToggle } from "./WebSearchToggle";

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
  toolsEnabled?: boolean;
  onToolsChange?: (enabled: boolean) => void;
  footer?: React.ReactNode;
  /**
   * Set to false to hide the paperclip button (used e.g. by the study
   * session view where attachments don't apply yet).
   */
  allowAttachments?: boolean;
  /**
   * Focus the textarea on mount. Use on surfaces where the student's
   * primary intent is to type — chat / study pages — so the user can
   * start typing immediately without having to click into the field.
   * Uses ``preventScroll`` so we don't jerk the page when focus lands
   * on a long chat history.
   */
  autoFocus?: boolean;
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
  toolsEnabled = false,
  onToolsChange,
  footer,
  allowAttachments = true,
  autoFocus = false,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const invalidateFiles = useInvalidateFiles();
  const isMobile = useIsMobile();
  const selectedModel = useModelStore((s) =>
    s.available.find(
      (m) =>
        m.provider_id === s.selectedProviderId &&
        m.model_id === s.selectedModelId
    ) ?? null
  );

  const dropAllowed = allowAttachments && !disabled && !streaming;

  // Surface a heads-up *before* send when an image is queued and the
  // currently-selected model can't read images. The backend will also
  // emit a vision_warning post-send, but catching it client-side avoids
  // a wasted round-trip and lets the user pick a different model first.
  const hasImageAttachment = attachments.some((a) =>
    (a.mime_type || "").toLowerCase().startsWith("image/")
  );
  const visionMismatch =
    hasImageAttachment && selectedModel !== null && !selectedModel.supports_vision;

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
    onSend(trimmed, attachments);
    setValue("");
    setAttachments([]);
    setPending([]);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // On mobile, Enter should insert a newline so users have a
    // dedicated tap target (the send button) for submission. The
    // on-screen keyboard's Enter key on phones is almost universally
    // expected to be "new line" in chat UIs (iMessage, WhatsApp,
    // Messenger all behave this way).
    if (isMobile) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

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
          {visionMismatch && (
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
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKey}
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
              {onWebSearchModeChange && (
                <WebSearchToggle
                  mode={webSearchMode}
                  onChange={onWebSearchModeChange}
                  disabled={disabled || streaming}
                />
              )}
              {onToolsChange && (
                <ToolsToggle
                  enabled={toolsEnabled}
                  onToggle={onToolsChange}
                  disabled={disabled || streaming}
                />
              )}
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
            Enter to send · Shift+Enter for newline
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
        className="ml-0.5 rounded-full p-0.5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
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
