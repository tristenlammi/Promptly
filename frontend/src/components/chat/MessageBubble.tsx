import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Check,
  Copy,
  Download,
  Eye,
  ExternalLink,
  File as FileIcon,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Pencil,
  Puzzle,
  User as UserIcon,
  Sparkles,
} from "lucide-react";

import { apiClient } from "@/api/client";
import { filesApi } from "@/api/files";
import type {
  ChatMessage,
  MessageAttachmentSnapshot,
  Source,
  ToolInvocation,
} from "@/api/types";
import { useEditorStore } from "@/store/editorStore";
import { cn } from "@/utils/cn";

import { MessageStats } from "./MessageStats";
import { ToolStatusBlock } from "./ToolStatusBlock";

interface MessageBubbleProps {
  role: ChatMessage["role"];
  content: string;
  streaming?: boolean;
  sources?: Source[] | null;
  attachments?: MessageAttachmentSnapshot[] | null;
  /** Persistent server-side message id. Used to anchor the bubble for
   *  search "jump to message" deep links (``#m-<uuid>`` in the URL).
   *  Optional because the live streaming bubble is rendered before the
   *  message has been committed to the database. */
  messageId?: string;
  /** Phase 4b — for shared chats, who actually sent this user
   *  message. ``null`` for assistant rows or when the row predates
   *  author tracking. */
  authorUserId?: string | null;
  /** Phase 4b — id -> username map for participants on the chat.
   *  ``null`` for solo conversations: the signal to skip the chip
   *  altogether so single-user chats stay visually unchanged. */
  authorLookup?: Record<string, string> | null;
  /** Phase 4b — current viewer's user id, used so the viewer's own
   *  messages keep saying "You" even on a shared chat. */
  currentUserId?: string | null;
  /** Phase 4c — fork-from-here action. When provided, a small
   *  "Branch" affordance shows up alongside the edit pencil so
   *  the user can spin a new conversation off this message. The
   *  promise should resolve once the navigation is queued; the
   *  bubble doesn't update its own state. */
  onBranch?: () => Promise<void> | void;
  /** Tool calls fired during *this* turn. Only meaningful on assistant
   *  rows — the streaming bubble passes the live in-flight list, the
   *  persisted bubble passes nothing (the chips and reply text are the
   *  permanent record once the turn lands). */
  toolInvocations?: ToolInvocation[] | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  ttftMs?: number | null;
  totalMs?: number | null;
  costUsd?: number | null;
  /** Edit-and-resend hook. When provided, a pencil icon renders below
   *  the bubble that swaps it into an inline editor. The promise should
   *  resolve once the new stream has been kicked off; the bubble exits
   *  edit mode as soon as it does. */
  onEdit?: (newText: string) => Promise<void>;
  /** Study module — when this assistant turn produced a whiteboard
   *  exercise, the parent passes a handler that re-opens it in the
   *  right-hand pane. Renders a "Open exercise" action below the reply
   *  so the student always has an escape hatch if the auto-route
   *  didn't flip them to the whiteboard. Undefined for non-study
   *  messages and for assistant turns with no exercise. */
  onOpenExercise?: () => void | Promise<void>;
  /** Whether the exercise has already been submitted and graded. Used
   *  to relabel the action button ("Revisit exercise" vs "Open
   *  exercise") so the student knows they're re-opening an old one. */
  exerciseReviewed?: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard may be unavailable on insecure origins; fail quietly.
        }
      }}
      className={cn(
        "absolute right-2 top-2 inline-flex items-center gap-1 rounded-md px-2 py-1",
        "bg-white/10 text-xs text-white/80 opacity-0 transition",
        "hover:bg-white/20 hover:text-white group-hover:opacity-100",
        "focus:opacity-100"
      )}
      aria-label={copied ? "Copied" : "Copy code"}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// Wrap <pre> to add a copy button.
const markdownComponents: Components = {
  pre({ children, ...props }) {
    const code =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((children as any)?.props?.children ?? "") as string;
    const text = typeof code === "string" ? code : String(code);
    return (
      <div className="group relative">
        <pre {...props}>{children}</pre>
        <CopyButton text={text} />
      </div>
    );
  },
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

/** Strip the AI's inline ``[1]`` / ``[2]`` style citation references
 *  from the visible reply. The model is told (via the search-tool
 *  system prompt) to cite sources inline; we used to render those as
 *  pill links inside the prose, but the user-facing source list at
 *  the bottom of the bubble already covers that need without breaking
 *  reading flow. The regex is conservative — only single-digit and
 *  two-digit numbers are eligible, so things like ``[note]`` or
 *  ``[TODO]`` survive untouched. Adjacent stripped chips collapse
 *  into a single space so the prose doesn't end up with awkward
 *  double spacing. */
function stripInlineCitations(markdown: string): string {
  if (!markdown) return markdown;
  return markdown
    .replace(/(?:\s*\[\d{1,2}\])+/g, "")
    .replace(/\s+([.,;:!?])/g, "$1");
}

function Avatar({ role }: { role: ChatMessage["role"] }) {
  if (role === "user") {
    return (
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          "bg-[var(--accent)]/20 text-[var(--accent)]"
        )}
      >
        <UserIcon className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
        "bg-[var(--accent)] text-white"
      )}
    >
      <Sparkles className="h-4 w-4" />
    </div>
  );
}

/** Phase 4b — compute the "You" / "Promptly" / "Jane" label.
 *
 *  For solo chats (``authorLookup === null``), returns the original
 *  "You"/"Promptly" labels so single-user chats are visually
 *  identical to before. For shared chats, looks up the author by
 *  id; falls back to "Friend" when the author has been deleted or
 *  is otherwise missing from the participants snapshot.
 */
function computeAuthorLabel(
  isUser: boolean,
  authorUserId: string | null | undefined,
  authorLookup: Record<string, string> | null | undefined,
  currentUserId: string | null | undefined
): string {
  if (!isUser) return "Promptly";
  if (!authorLookup) return "You";
  if (!authorUserId) return "You";
  if (currentUserId && authorUserId === currentUserId) return "You";
  return authorLookup[authorUserId] ?? "Friend";
}

function MessageBubbleImpl({
  role,
  content,
  streaming,
  sources,
  attachments,
  toolInvocations,
  promptTokens,
  completionTokens,
  ttftMs,
  totalMs,
  costUsd,
  messageId,
  authorUserId,
  authorLookup,
  currentUserId,
  onEdit,
  onBranch,
  onOpenExercise,
  exerciseReviewed,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const hasSources = !isUser && sources && sources.length > 0;
  // Phase A1: assistant rows can carry attachments too (artefacts
  // produced by tool calls). The chip UI is identical across roles.
  const hasAttachments = !!attachments && attachments.length > 0;
  const hasToolInvocations = !!toolInvocations && toolInvocations.length > 0;
  const hasStats =
    !isUser &&
    !streaming &&
    (promptTokens != null ||
      completionTokens != null ||
      ttftMs != null ||
      totalMs != null ||
      (costUsd != null && costUsd > 0));
  const canEdit = isUser && !!onEdit;
  // Copy action shows on every persisted assistant reply with text.
  // Skipped while streaming (content keeps changing) and on user
  // turns (they already have the source via the Edit affordance).
  const canCopy = !isUser && !streaming && !!content && content.trim().length > 0;

  const [editing, setEditing] = useState(false);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [copyClicked, setCopyClicked] = useState(false);

  const handleCopyMessage = async () => {
    if (!content) return;
    try {
      // Copy what the user actually sees — stripped of the bracketed
      // [1]/[2] inline citation markers we hide from the rendered prose.
      await navigator.clipboard.writeText(stripInlineCitations(content));
      setCopyClicked(true);
      setCopiedFlash(true);
      window.setTimeout(() => setCopyClicked(false), 1500);
      window.setTimeout(() => setCopiedFlash(false), 1500);
    } catch {
      // Clipboard API can throw on insecure origins / locked-down
      // browsers. Fail quietly — the long-press fallback (mobile) and
      // text-selection (desktop) still work.
    }
  };

  // Phase 5 — long-press to copy on touch devices. ~500ms hold copies
  // the message text via the Clipboard API and shows a transient
  // confirmation. Cancelled by movement / pointer release. Skips
  // gracefully when there's nothing to copy or the browser doesn't
  // expose ``navigator.clipboard`` (older iOS Safari in non-secure
  // contexts).
  const longPressRef = useRef<{
    timer: number | null;
    startX: number;
    startY: number;
  }>({ timer: null, startX: 0, startY: 0 });

  const cancelLongPress = () => {
    if (longPressRef.current.timer !== null) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return; // desktop uses copy button
    if (!content?.trim()) return;
    longPressRef.current.startX = e.clientX;
    longPressRef.current.startY = e.clientY;
    cancelLongPress();
    longPressRef.current.timer = window.setTimeout(async () => {
      try {
        await navigator.clipboard?.writeText(content);
        setCopiedFlash(true);
        window.setTimeout(() => setCopiedFlash(false), 1500);
      } catch {
        // Clipboard write can throw in cross-origin / non-secure
        // contexts; silently no-op rather than surfacing a scary
        // error for a power-user gesture.
      }
    }, 500);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const dx = Math.abs(e.clientX - longPressRef.current.startX);
    const dy = Math.abs(e.clientY - longPressRef.current.startY);
    if (dx > 8 || dy > 8) cancelLongPress();
  };

  return (
    <div
      id={messageId ? `m-${messageId}` : undefined}
      data-message-id={messageId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      className={cn(
        "promptly-message flex gap-3 px-4 py-4 transition-colors duration-700",
        "rounded-md",
        isUser && "flex-row-reverse",
        copiedFlash && "bg-emerald-500/10"
      )}
    >
      <Avatar role={role} />
      <div
        className={cn(
          "min-w-0",
          isUser ? "flex max-w-[80%] flex-col items-end" : "flex-1"
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)]">
          <span>
            {computeAuthorLabel(isUser, authorUserId, authorLookup, currentUserId)}
          </span>
          {hasStats && (
            <MessageStats
              promptTokens={promptTokens}
              completionTokens={completionTokens}
              ttftMs={ttftMs}
              totalMs={totalMs}
              costUsd={costUsd}
            />
          )}
        </div>
        {editing && canEdit ? (
          <UserMessageEditor
            initialText={content}
            onCancel={() => setEditing(false)}
            onSave={async (newText) => {
              // Close the editor immediately on submit. If the parent
              // throws, the message is still in the store and the user
              // can re-open the editor and try again.
              setEditing(false);
              await onEdit!(newText);
            }}
          />
        ) : (
          <div
            className={cn(
              "promptly-prose text-sm text-[var(--text)]",
              // User messages get a distinct chat-bubble treatment: tinted
              // background, faint border, rounded corners with a smaller top-
              // right corner so the bubble "points" toward the user avatar.
              // AI replies stay bare so markdown content breathes across the
              // full width of the column.
              isUser &&
                cn(
                  "w-fit max-w-full whitespace-pre-wrap",
                  "rounded-2xl rounded-tr-md",
                  "border border-[var(--accent)]/25",
                  "bg-[var(--accent)]/10 dark:bg-[var(--accent)]/15",
                  "px-4 py-2.5 shadow-sm"
                )
            )}
          >
            {isUser ? (
              content
            ) : (
              <>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={markdownComponents}
                >
                  {stripInlineCitations(content || "")}
                </ReactMarkdown>
                {streaming && (
                  <span
                    aria-hidden
                    className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-[var(--accent)] align-text-bottom"
                  />
                )}
              </>
            )}
          </div>
        )}
        {hasToolInvocations && (
          <div className="mt-2 flex flex-col gap-1.5">
            {toolInvocations!.map((t) => (
              <ToolStatusBlock key={t.id} invocation={t} />
            ))}
          </div>
        )}
        {hasAttachments && !editing && (
          <AttachmentChips
            attachments={attachments!}
            align={isUser ? "end" : "start"}
            showDownload={!isUser}
          />
        )}
        {((canEdit && !editing) ||
          (onBranch && !streaming) ||
          canCopy ||
          (onOpenExercise && !streaming)) && (
          <div className="mt-1.5 flex items-center gap-1">
            {onOpenExercise && !streaming && (
              <button
                type="button"
                onClick={() => void onOpenExercise()}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
                  "text-[var(--accent)] transition",
                  "hover:bg-[var(--accent)]/[0.08]"
                )}
                title={
                  exerciseReviewed
                    ? "Re-open this exercise in the whiteboard"
                    : "Open this exercise in the whiteboard"
                }
                aria-label={
                  exerciseReviewed ? "Revisit exercise" : "Open exercise"
                }
              >
                <Puzzle className="h-3 w-3" />
                <span>
                  {exerciseReviewed ? "Revisit exercise" : "Open exercise"}
                </span>
              </button>
            )}
            {canCopy && (
              <button
                type="button"
                onClick={() => void handleCopyMessage()}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
                  "text-[var(--text-muted)] transition",
                  "hover:bg-black/[0.04] hover:text-[var(--text)]",
                  "dark:hover:bg-white/[0.06]",
                  copyClicked && "text-emerald-600 dark:text-emerald-400"
                )}
                title={copyClicked ? "Copied" : "Copy reply to clipboard"}
                aria-label={copyClicked ? "Copied" : "Copy reply"}
              >
                {copyClicked ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copyClicked ? "Copied" : "Copy"}</span>
              </button>
            )}
            {canEdit && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
                  "text-[var(--text-muted)] transition",
                  "hover:bg-black/[0.04] hover:text-[var(--text)]",
                  "dark:hover:bg-white/[0.06]"
                )}
                title="Edit and resend"
                aria-label="Edit and resend"
              >
                <Pencil className="h-3 w-3" />
                <span>Edit</span>
              </button>
            )}
            {onBranch && !streaming && (
              <button
                type="button"
                onClick={() => void onBranch()}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
                  "text-[var(--text-muted)] transition",
                  "hover:bg-black/[0.04] hover:text-[var(--text)]",
                  "dark:hover:bg-white/[0.06]"
                )}
                title="Branch from here — fork into a new conversation"
                aria-label="Branch from here"
              >
                <GitBranch className="h-3 w-3" />
                <span>Branch</span>
              </button>
            )}
          </div>
        )}
        {hasSources && <SourcesFooter sources={sources!} />}
      </div>
    </div>
  );
}

interface UserMessageEditorProps {
  initialText: string;
  onSave: (newText: string) => Promise<void> | void;
  onCancel: () => void;
}

function UserMessageEditor({
  initialText,
  onSave,
  onCancel,
}: UserMessageEditorProps) {
  const [text, setText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosize the textarea to fit content. Re-runs every time `text`
  // changes so the editor grows / shrinks with the user's typing.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 360)}px`;
  }, [text]);

  // Focus + place caret at end on first mount. Done in an effect so it
  // runs after the textarea is in the DOM and after the autosize pass.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const trimmed = text.trim();
  const unchanged = trimmed === initialText.trim();
  const disabled = submitting || trimmed.length === 0 || unchanged;

  const handleSubmit = async () => {
    if (disabled) return;
    setSubmitting(true);
    try {
      await onSave(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    // Enter (without Shift) submits, matching the main InputBar's behavior.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      className={cn(
        "w-full max-w-full rounded-2xl rounded-tr-md",
        "border border-[var(--accent)]/40",
        "bg-[var(--accent)]/10 dark:bg-[var(--accent)]/15",
        "px-3 py-2 shadow-sm"
      )}
    >
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={submitting}
        rows={1}
        className={cn(
          "w-full resize-none bg-transparent text-sm text-[var(--text)]",
          "outline-none placeholder:text-[var(--text-muted)]",
          "disabled:opacity-60"
        )}
        placeholder="Edit your message..."
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs",
            "text-[var(--text-muted)] hover:bg-black/[0.05] hover:text-[var(--text)]",
            "dark:hover:bg-white/[0.06]",
            "disabled:opacity-50"
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={disabled}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-semibold text-white",
            "bg-[var(--accent)] hover:opacity-90",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          {submitting ? "Sending..." : "Save & resend"}
        </button>
      </div>
    </div>
  );
}

function AttachmentChips({
  attachments,
  align = "end",
  showDownload = false,
}: {
  attachments: MessageAttachmentSnapshot[];
  /** ``end`` for user turns (right-aligned under the bubble), ``start``
   *  for assistant turns (left-aligned under the reply). */
  align?: "start" | "end";
  /** Render an inline download button next to each chip. Used for
   *  assistant artefacts so the user can grab the file straight from
   *  chat without round-tripping through the Files tab. */
  showDownload?: boolean;
}) {
  const openEditor = useEditorStore((s) => s.openEditor);
  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap gap-2",
        align === "end" ? "justify-end" : "justify-start"
      )}
    >
      {attachments.map((a) => {
        // Images get a real thumbnail tile (Phase B1 — assistant-
        // generated images need a visual preview, not a generic chip).
        // We use the same component for user-uploaded images so a
        // round-trip ("here's a photo" → "here's an edited version")
        // stays visually consistent.
        if (a.mime_type.startsWith("image/")) {
          return (
            <ImageAttachmentTile
              key={a.id}
              attachment={a}
              showDownload={showDownload}
            />
          );
        }
        const Icon =
          a.mime_type.startsWith("text/") ||
          a.mime_type === "application/json" ||
          a.mime_type === "application/xml"
            ? FileText
            : FileIcon;
        // Every PDF chip is clickable (Phase B3): rendered_pdf rows
        // open the editable Markdown side panel; everything else
        // (user uploads, missing-source rows) opens the read-only
        // preview. The store doesn't care which mode — the panel
        // decides based on ``source_kind``. We still expose the
        // download button next to the chip so the user can grab the
        // file without round-tripping through the panel.
        const isPdf = a.mime_type === "application/pdf";
        const isEditablePdf = isPdf && a.source_kind === "rendered_pdf";
        const isPreviewPdf = isPdf && !isEditablePdf;
        const isOpenable = isPdf;
        const ChipBase = isOpenable ? "button" : "div";
        const HoverIcon = isEditablePdf ? Pencil : isPreviewPdf ? Eye : null;
        const chipTitle = isEditablePdf
          ? `Click to edit ${a.filename}`
          : isPreviewPdf
            ? `Click to preview ${a.filename}`
            : `${a.filename} · ${a.mime_type}`;
        return (
          <div
            key={a.id}
            className={cn(
              "inline-flex max-w-xs items-stretch overflow-hidden rounded-full border text-xs",
              "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
            )}
          >
            <ChipBase
              {...(isOpenable
                ? {
                    type: "button" as const,
                    onClick: () => openEditor(a),
                    title: chipTitle,
                    "aria-label": isEditablePdf
                      ? `Open ${a.filename} in the editor`
                      : `Preview ${a.filename}`,
                  }
                : { title: chipTitle })}
              className={cn(
                "group/chip inline-flex min-w-0 items-center gap-1.5 px-2 py-1 text-left",
                isOpenable &&
                  "cursor-pointer transition hover:bg-[var(--accent)]/[0.08]"
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
              <span className="truncate">{a.filename}</span>
              {HoverIcon && (
                <HoverIcon
                  className={cn(
                    "h-3 w-3 shrink-0 text-[var(--text-muted)] transition",
                    "opacity-0 group-hover/chip:opacity-100"
                  )}
                  aria-hidden
                />
              )}
            </ChipBase>
            {showDownload && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void downloadAttachment(a);
                }}
                title={`Download ${a.filename}`}
                aria-label={`Download ${a.filename}`}
                className={cn(
                  "inline-flex w-6 shrink-0 items-center justify-center border-l",
                  "border-[var(--border)] text-[var(--text-muted)] transition",
                  "hover:bg-black/[0.06] hover:text-[var(--text)]",
                  "dark:hover:bg-white/[0.08]"
                )}
              >
                <Download className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Inline image preview for an attachment chip.
 *
 * We can't drop a plain ``<img src=/api/files/{id}>`` into the DOM —
 * downloads require a Bearer token and ``<img>`` won't send one. The
 * tile fetches the bytes via the authenticated ``apiClient``, wraps
 * them in an object URL, and revokes it on unmount so we don't leak
 * memory across long chat sessions.
 *
 * Click → opens the image in a new tab (using a fresh blob URL the
 * browser is happy to render). Optional download button overlays the
 * top-right corner on hover when ``showDownload`` is on (assistant
 * turns).
 */
function ImageAttachmentTile({
  attachment,
  showDownload,
}: {
  attachment: MessageAttachmentSnapshot;
  showDownload: boolean;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const path = filesApi.downloadUrl(attachment.id).replace(/^\/api/, "");
        const res = await apiClient.get<Blob>(path, { responseType: "blob" });
        if (!active) return;
        createdUrl = window.URL.createObjectURL(res.data);
        setBlobUrl(createdUrl);
      } catch {
        if (active) setErrored(true);
      }
    })();
    return () => {
      active = false;
      if (createdUrl) window.URL.revokeObjectURL(createdUrl);
    };
  }, [attachment.id]);

  const openInNewTab = () => {
    if (!blobUrl) return;
    window.open(blobUrl, "_blank", "noopener");
  };

  return (
    <div
      className={cn(
        "group/img relative inline-flex max-w-[260px] flex-col overflow-hidden rounded-lg border",
        "border-[var(--border)] bg-[var(--surface)] text-xs"
      )}
    >
      <button
        type="button"
        onClick={openInNewTab}
        disabled={!blobUrl}
        title={`${attachment.filename} · click to open full size`}
        aria-label={`Open ${attachment.filename} in a new tab`}
        className={cn(
          "relative flex h-40 w-full items-center justify-center overflow-hidden",
          "bg-black/[0.04] transition dark:bg-white/[0.04]",
          blobUrl && "cursor-zoom-in hover:bg-black/[0.06] dark:hover:bg-white/[0.06]",
          !blobUrl && "cursor-default"
        )}
      >
        {blobUrl ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img
            src={blobUrl}
            alt={attachment.filename}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        ) : errored ? (
          <span className="flex flex-col items-center gap-1 text-[var(--text-muted)]">
            <ImageIcon className="h-5 w-5" />
            <span>Failed to load</span>
          </span>
        ) : (
          <span className="flex flex-col items-center gap-1 text-[var(--text-muted)]">
            <ImageIcon className="h-5 w-5 animate-pulse" />
          </span>
        )}
        {showDownload && blobUrl && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              void downloadAttachment(attachment);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                void downloadAttachment(attachment);
              }
            }}
            title={`Download ${attachment.filename}`}
            aria-label={`Download ${attachment.filename}`}
            className={cn(
              "absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center",
              "rounded-md border border-[var(--border)] bg-[var(--surface)]/90 backdrop-blur",
              "text-[var(--text-muted)] opacity-0 transition",
              "hover:text-[var(--text)] group-hover/img:opacity-100",
              "focus-visible:opacity-100"
            )}
          >
            <Download className="h-3.5 w-3.5" />
          </span>
        )}
      </button>
      <div
        className="truncate border-t border-[var(--border)] px-2 py-1 text-[var(--text-muted)]"
        title={attachment.filename}
      >
        {attachment.filename}
      </div>
    </div>
  );
}

function SourcesFooter({ sources }: { sources: Source[] }) {
  return (
    <details className="mt-3 rounded-card border border-[var(--border)] bg-black/[0.02] dark:bg-white/[0.03]">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-card px-3 py-2 text-xs",
          "text-[var(--text-muted)] hover:text-[var(--text)]"
        )}
      >
        <ExternalLink className="h-3 w-3" />
        <span className="font-medium">
          {sources.length} source{sources.length === 1 ? "" : "s"}
        </span>
      </summary>
      <ol className="space-y-2 px-3 pb-3 pt-1 text-xs">
        {sources.map((s, idx) => {
          let host = "";
          try {
            host = new URL(s.url).host;
          } catch {
            host = s.url;
          }
          return (
            <li key={`${s.url}-${idx}`} className="flex gap-2">
              <span className="shrink-0 font-mono text-[var(--text-muted)]">
                [{idx + 1}]
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  {s.title || host}
                </a>
                <div className="truncate text-[var(--text-muted)]">{host}</div>
                {s.snippet && (
                  <div className="mt-0.5 line-clamp-2 text-[var(--text)] opacity-80">
                    {s.snippet}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** Authenticated blob download for an attachment chip.
 *  Mirrors ``downloadAuthed`` in FilesPage — kept local rather than
 *  shared because this is the only other call site today and the
 *  function is six lines. Lift to a shared util if a third caller
 *  shows up. */
async function downloadAttachment(
  a: MessageAttachmentSnapshot
): Promise<void> {
  try {
    const path = filesApi.downloadUrl(a.id).replace(/^\/api/, "");
    const res = await apiClient.get<Blob>(path, { responseType: "blob" });
    const url = window.URL.createObjectURL(res.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = a.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  } catch {
    // Best-effort — the chip stays visible so the user can retry.
    // A toast system would slot in here once we add one.
  }
}

export const MessageBubble = memo(MessageBubbleImpl);
