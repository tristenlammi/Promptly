import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import {
  AtSign,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  ExternalLink,
  File as FileIcon,
  FileText,
  GitBranch,
  Image as ImageIcon,
  PanelRight as PanelRightIcon,
  Pencil,
  Puzzle,
  RefreshCw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User as UserIcon,
  Sparkles,
  Volume2,
} from "lucide-react";

import { apiClient } from "@/api/client";
import { filesApi } from "@/api/files";
import { MermaidDiagram } from "./MermaidDiagram";
import type {
  ChatMessage,
  MessageAttachmentSnapshot,
  Source,
  ToolInvocation,
  VisionRelayInvocation,
} from "@/api/types";
import { useCodeArtifactStore } from "@/stores/codeArtifactStore";
import {
  normaliseLanguage,
  shouldShowOpenButton,
} from "@/components/codeArtifacts/previewable";
import { useEditorStore } from "@/store/editorStore";
import { useModelStore } from "@/store/modelStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

/** Override passed to a regenerate handler. ``null`` regenerates with
 *  the currently-selected global model (same as clicking the primary
 *  regen button). An explicit pair forces a different model — powers
 *  the "try with Claude instead" submenu. */
export interface RegenerateOverride {
  provider_id: string;
  model_id: string;
}

import { MessageStats } from "./MessageStats";
import { ToolStatusBlock } from "./ToolStatusBlock";
import { VisionRelayChip } from "./VisionRelayChip";

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
  /** Vision-relay captioning calls fired *before* this turn's reply
   *  began (each image attached to a non-vision chat model gets one).
   *  Only meaningful on the streaming bubble — once the assistant
   *  reply commits, the caption text is already baked into the model's
   *  output and the chips clear. */
  visionRelayInvocations?: VisionRelayInvocation[] | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  ttftMs?: number | null;
  totalMs?: number | null;
  costUsd?: number | null;
  /** Set on the just-streamed assistant reply when the upstream hit
   *  its output-token ceiling and the text is cut off mid-thought.
   *  Renders a subtle "response was cut off" hint with a regenerate
   *  nudge. Only ever true on a freshly streamed message. */
  truncated?: boolean;
  /** Edit-and-resend hook. When provided, a pencil icon renders below
   *  the bubble that swaps it into an inline editor. The promise should
   *  resolve once the new stream has been kicked off; the bubble exits
   *  edit mode as soon as it does. */
  onEdit?: (newText: string) => Promise<void>;
  /** ISO timestamp stamped by the in-place assistant-edit endpoint
   *  on the most recent rewrite. Renders a tiny "edited" pill in
   *  the meta row so the owner can spot retroactively-rewritten
   *  replies at a glance. ``null`` / ``undefined`` for every
   *  original-state row. */
  editedAt?: string | null;
  /** Regenerate-this-reply hook. Only passed for the most recent
   *  persisted assistant message. Called with ``null`` when the user
   *  clicks the primary "Regenerate" button (reuses the currently
   *  selected global model) or with an explicit override when they
   *  pick "Try a different model" → <model> from the chevron submenu.
   *  Resolves once the new stream has been kicked off. */
  onRegenerate?: (override: RegenerateOverride | null) => Promise<void> | void;
  /** Delete-this-message hook. When provided, a "Delete" action shows
   *  in the row's overflow menu. The parent confirms + removes the
   *  message; the bubble just invokes the callback. */
  onDelete?: () => Promise<void> | void;
  /** Phase 2.5 — current thumbs rating on this assistant reply
   *  (``null`` when unrated) and its optional reason note. */
  feedback?: "up" | "down" | null;
  feedbackReason?: string | null;
  /** Rate-this-reply hook. When provided (assistant rows), thumbs
   *  up/down show in the action row. ``rating: null`` clears. */
  onFeedback?: (
    rating: "up" | "down" | null,
    reason?: string
  ) => Promise<void> | void;
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
        "inline-flex items-center gap-1 rounded-md px-2 py-1",
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

/** Button that opens a fenced code block in the right-hand Code
 *  Artifact side panel. Only rendered when the block is long enough
 *  or the language has a live preview (HTML / SVG / Markdown /
 *  JSON / CSV) — see {@link shouldShowOpenButton}. */
function OpenInPanelButton({
  source,
  rawLanguage,
}: {
  source: string;
  rawLanguage: string;
}) {
  const language = normaliseLanguage(rawLanguage);
  if (!shouldShowOpenButton(source, language)) return null;
  return (
    <button
      type="button"
      onClick={() => {
        useCodeArtifactStore.getState().openArtifact({
          source,
          language,
          filenameStem: "artifact",
        });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1",
        "bg-white/10 text-xs text-white/80 opacity-0 transition",
        "hover:bg-white/20 hover:text-white group-hover:opacity-100",
        "focus:opacity-100"
      )}
      aria-label="Open in panel"
      title="Open in side panel"
    >
      <PanelRightIcon className="h-3 w-3" />
      Open
    </button>
  );
}

// Phase C — ``@[title](id)`` mention tokens. We rewrite them to a
// Markdown link pointing at a fake ``promptly-mention:`` protocol
// before handing the content to ReactMarkdown, then the ``a``
// renderer below spots that href prefix and swaps in a chip.
// Same preprocessing is applied to user messages (which render as
// plain text), using ``renderMentionText`` directly.
// ``@[title](id)`` for chat mentions and ``@[title](file:id)`` for
// Drive-file mentions (Phase 2.2). The optional ``file:`` prefix group
// discriminates the two.
const MENTION_TOKEN_RE =
  /@\[([^\]\n]+?)\]\((file:)?([0-9a-fA-F-]{32,})\)/g;

function rewriteMentionsForMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  // Replace chat mentions with ``[@title](promptly-mention:id)`` and
  // file mentions with ``[@title](promptly-file:id)``. The zero-width
  // space between ``@`` and title prevents Markdown parsers from
  // collapsing adjacent tokens into one link.
  return markdown.replace(
    MENTION_TOKEN_RE,
    (_m, title: string, prefix: string | undefined, id: string) => {
      const safe = title.replace(/[\[\]]/g, "");
      const proto = prefix ? "promptly-file" : "promptly-mention";
      return `[@\u200B${safe}](${proto}:${id})`;
    }
  );
}

/** Render a plain-text string (user messages) replacing any
 *  ``@[title](id)`` tokens with mention chips. Returns a list of
 *  React nodes in input order — plain text segments survive
 *  unchanged (``whitespace-pre-wrap`` styling on the parent
 *  preserves their newlines). */
function renderMentionText(text: string): ReactNode {
  if (!text) return null;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_TOKEN_RE.lastIndex = 0;
  while ((match = MENTION_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(
        <FileMentionChip key={`mention-${match.index}`} title={match[1]} />
      );
    } else {
      parts.push(
        <MentionChip
          key={`mention-${match.index}`}
          title={match[1]}
          conversationId={match[3]}
        />
      );
    }
    lastIndex = MENTION_TOKEN_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

/** Inline chip rendered wherever a ``@[title](id)`` token appears.
 *  Clicking it navigates to that chat (new page, not a modal, so
 *  the browser back button brings the user back naturally). */
function MentionChip({
  title,
  conversationId,
}: {
  title: string;
  conversationId: string;
}) {
  const navigate = useNavigate();
  const clean = (title || "").replace(/[\[\]]/g, "").trim() || "Chat";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(`/chat/${conversationId}`);
      }}
      className={cn(
        "mx-[1px] inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 align-baseline text-[12px] font-medium leading-5 transition",
        "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]",
        "hover:bg-[var(--accent)]/20 hover:border-[var(--accent)]/60"
      )}
      title={`Go to chat: ${clean}`}
    >
      <AtSign className="h-3 w-3" />
      <span className="max-w-[14rem] truncate">{clean}</span>
    </button>
  );
}

/** Inline chip rendered wherever a ``@[name](file:id)`` token appears
 *  (Phase 2.2). Non-navigating — it just signals that a Drive file's
 *  contents were pulled into the turn as context. */
function FileMentionChip({ title }: { title: string }) {
  const clean = (title || "").replace(/[\[\]]/g, "").trim() || "File";
  return (
    <span
      className={cn(
        "mx-[1px] inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 align-baseline text-[12px] font-medium leading-5",
        "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
      )}
      title={`Referenced file: ${clean}`}
    >
      <FileText className="h-3 w-3" />
      <span className="max-w-[14rem] truncate">{clean}</span>
    </span>
  );
}

/** Recursively reduce a ReactNode subtree to its plain text content.
 *
 *  We need this because once ``rehype-highlight`` runs over a fenced
 *  code block, the inner ``<code>`` no longer holds a single string
 *  — it holds a tree of ``<span>`` tokens with whitespace text
 *  nodes between them. ``String(arr)`` on that gives you literally
 *  ``"[object Object],[object Object],…"`` which is what showed up
 *  in the artifact panel's preview. Walking the tree gets the
 *  original source back faithfully (including newlines, since they
 *  survive as bare text siblings between the colour spans).
 */
function extractTextFromNode(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromNode).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return extractTextFromNode((node as any).props?.children);
  }
  return "";
}

// Wrap <pre> to add Copy + (when eligible) Open-in-panel buttons.
// Hoisted so the plugin arrays keep a stable identity across renders
// (a fresh ``[remarkGfm]`` literal every render defeats react-markdown's
// internal memoisation). ``rehype-highlight`` walks the whole AST and
// emits a tree of <span>s per code block — cheap once, but ruinous when
// it re-runs on every streamed token of a long code-heavy reply. We
// therefore skip it entirely while ``streaming`` and only highlight the
// final, persisted bubble.
// ``remark-math`` parses ``$…$`` / ``$$…$$`` into math nodes and
// ``rehype-katex`` renders them. ``throwOnError: false`` keeps a
// half-typed equation mid-stream (e.g. an unmatched ``$``) from
// blowing up the whole bubble — KaTeX just renders the raw source in
// the error colour until the closing delimiter arrives.
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkMath];
const REHYPE_PLUGINS_WITH_HIGHLIGHT: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false }],
  rehypeHighlight,
];
// While streaming we skip the expensive ``rehype-highlight`` AST walk
// but still render math so equations don't flash in as raw text at the
// end of the turn.
const REHYPE_PLUGINS_NONE: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false }],
];

const markdownComponents: Components = {
  pre({ children, ...props }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codeChild = children as any;
    const text = extractTextFromNode(codeChild?.props?.children);
    // ReactMarkdown tags the inner <code> with ``className="language-<x>"``
    // when the fence declared one. Parse that out so we know which
    // previewer (if any) to route the Open button into.
    const className: string = codeChild?.props?.className ?? "";
    const match = /language-(\S+)/.exec(className);
    const rawLang = match?.[1] ?? "";
    // Phase 2.3 — render ` ```mermaid ` fences as diagrams instead of
    // a raw code block. The component falls back to source while the
    // reply is still streaming (incomplete / unparseable).
    if (rawLang === "mermaid") {
      return <MermaidDiagram code={text} />;
    }
    return (
      <div className="group relative">
        <pre {...props}>{children}</pre>
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <OpenInPanelButton source={text} rawLanguage={rawLang} />
          <CopyButton text={text} />
        </div>
      </div>
    );
  },
  a({ children, href, ...props }) {
    // ``promptly-mention:<id>`` is the synthetic protocol we use
    // to represent ``@[title](id)`` tokens after preprocessing.
    // Rewriting them to chips here means the AI's echoed mentions
    // render the same as the user's own.
    if (typeof href === "string" && href.startsWith("promptly-mention:")) {
      const convId = href.slice("promptly-mention:".length);
      // ``children`` is the ``[@<title>]`` text; strip the ``@`` +
      // zero-width-space prefix so the chip renders cleanly.
      const raw = String(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (children as any)?.[0] ?? children ?? ""
      );
      const title = raw.replace(/^@\u200B?/, "");
      return <MentionChip title={title} conversationId={convId} />;
    }
    if (typeof href === "string" && href.startsWith("promptly-file:")) {
      const raw = String(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (children as any)?.[0] ?? children ?? ""
      );
      const title = raw.replace(/^@\u200B?/, "");
      return <FileMentionChip title={title} />;
    }
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
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

/** Flatten Markdown into something pleasant for ``speechSynthesis`` to
 *  read aloud (Phase 2.4). Drops code blocks, link/image syntax,
 *  heading/emphasis markers and table pipes so the narration doesn't
 *  spell out backticks, asterisks and URLs. */
function markdownToSpeech(markdown: string): string {
  if (!markdown) return "";
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#]/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/** Apply the "show failures only when nothing else worked" rule to
 *  the live list of tool invocations before rendering.
 *
 *  Per tool name:
 *    - Pending invocations always render (in-flight UX).
 *    - If at least one ``ok`` invocation exists, every ``error`` entry
 *      for that tool is dropped. Most failed chips in practice come
 *      from the per-turn cap kicking in after several successful
 *      searches — the user has already got useful results, so the red
 *      X-chips are pure noise and look like a duplicate bug.
 *    - If *every* invocation of that tool errored, keep exactly one
 *      chip (the most recent failure) so the user still sees that the
 *      tool couldn't do its job. That preserves the "complete failure
 *      surfaces clearly" guarantee.
 *
 *  Order is preserved within each retained group; the final array is
 *  rebuilt in the same order tools were started so the chip strip
 *  matches the model's actual call sequence.
 */
export function consolidateToolInvocations(
  invocations: ToolInvocation[] | null | undefined,
): ToolInvocation[] {
  if (!invocations || invocations.length === 0) return [];
  const byName = new Map<string, ToolInvocation[]>();
  for (const inv of invocations) {
    const bucket = byName.get(inv.name);
    if (bucket) bucket.push(inv);
    else byName.set(inv.name, [inv]);
  }
  const keep = new Set<string>();
  for (const group of byName.values()) {
    const hasSuccess = group.some((t) => t.status === "ok");
    let lastErrorId: string | null = null;
    for (const t of group) {
      if (t.status === "pending" || t.status === "ok") {
        keep.add(t.id);
      } else if (t.status === "error") {
        lastErrorId = t.id;
      }
    }
    if (!hasSuccess && lastErrorId !== null) {
      keep.add(lastErrorId);
    }
  }
  return invocations.filter((t) => keep.has(t.id));
}

function MessageBubbleImpl({
  role,
  content,
  streaming,
  sources,
  attachments,
  toolInvocations,
  visionRelayInvocations,
  promptTokens,
  completionTokens,
  ttftMs,
  totalMs,
  costUsd,
  truncated,
  messageId,
  authorUserId,
  authorLookup,
  currentUserId,
  onEdit,
  editedAt,
  onBranch,
  onRegenerate,
  onDelete,
  feedback,
  feedbackReason,
  onFeedback,
  onOpenExercise,
  exerciseReviewed,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const hasSources = !isUser && sources && sources.length > 0;
  // Phase A1: assistant rows can carry attachments too (artefacts
  // produced by tool calls). The chip UI is identical across roles.
  const hasAttachments = !!attachments && attachments.length > 0;
  const displayedToolInvocations = useMemo(
    () => consolidateToolInvocations(toolInvocations),
    [toolInvocations],
  );
  const hasToolInvocations = displayedToolInvocations.length > 0;
  // Preprocess the markdown once per content change rather than on
  // every render. During streaming ``content`` changes ~60×/sec (post
  // batching), so keeping these string passes out of the hot render
  // path matters. Only the assistant prose path uses it.
  const processedMarkdown = useMemo(
    () => rewriteMentionsForMarkdown(stripInlineCitations(content || "")),
    [content],
  );
  // Memoise the rendered markdown *element* on [content, streaming].
  // ``MessageBubble``'s ``memo`` is routinely defeated by the inline
  // ``onEdit`` / ``onBranch`` / ``onRegenerate`` closures the parent
  // recreates every render, so persisted bubbles re-render whenever
  // the streaming bubble updates. Holding the ReactMarkdown subtree by
  // reference means React bails out of reconciling it when the content
  // hasn't changed — so the expensive remark/rehype/highlight parse
  // only runs when *this* message's text actually changes, not on
  // every sibling token. The streaming bubble still recomputes (its
  // content changes), but with highlight disabled that pass is cheap.
  const markdownEl = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={
          streaming ? REHYPE_PLUGINS_NONE : REHYPE_PLUGINS_WITH_HIGHLIGHT
        }
        components={markdownComponents}
      >
        {processedMarkdown}
      </ReactMarkdown>
    ),
    [processedMarkdown, streaming],
  );
  const hasVisionRelayInvocations =
    !!visionRelayInvocations && visionRelayInvocations.length > 0;
  const hasStats =
    !isUser &&
    !streaming &&
    (promptTokens != null ||
      completionTokens != null ||
      ttftMs != null ||
      totalMs != null ||
      (costUsd != null && costUsd > 0));
  // Edit affordance is shown for both user and assistant rows so the
  // owner can either rewrite-and-resend (user turn) or hand-correct
  // the AI's output in place (assistant turn). The parent decides
  // which messages are editable by passing / withholding ``onEdit``;
  // we never gate on role here. Streaming rows are still excluded
  // because mutating an in-flight reply would race the SSE pipeline.
  const canEdit = !!onEdit && !streaming;
  // Copy action shows on every persisted message with text (both
  // roles). Skipped only while streaming, since the content is still
  // changing.
  const canCopy = !streaming && !!content && content.trim().length > 0;

  const [editing, setEditing] = useState(false);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [copyClicked, setCopyClicked] = useState(false);

  const handleCopyMessage = async () => {
    if (!content) return;
    try {
      // Copy what the user actually sees. Assistant replies get the
      // bracketed [1]/[2] inline citation markers stripped (we hide
      // them from the rendered prose); user messages copy verbatim.
      await navigator.clipboard.writeText(
        isUser ? content : stripInlineCitations(content),
      );
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

  // Phase 2.4 — read-aloud (TTS). Assistant replies only; hidden when
  // the browser has no SpeechSynthesis. Toggles play/stop.
  const canReadAloud =
    !isUser &&
    !streaming &&
    !!content &&
    content.trim().length > 0 &&
    typeof window !== "undefined" &&
    "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);
  // Stop narration if this bubble unmounts mid-utterance.
  useEffect(
    () => () => {
      if (
        speakingRef.current &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );
  const handleReadAloud = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    if (speakingRef.current) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const plain = markdownToSpeech(stripInlineCitations(content || ""));
    if (!plain) return;
    // Cancel anything another bubble might be reading so only one
    // narration plays at a time.
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  };

  // Phase 2.5 — thumbs feedback. Assistant replies only.
  const canFeedback = !isUser && !streaming && !!onFeedback;
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  const handleThumb = (rating: "up" | "down") => {
    if (!onFeedback) return;
    if (feedback === rating) {
      // Clicking the active thumb again clears the rating.
      setReasonOpen(false);
      void onFeedback(null);
      return;
    }
    if (rating === "up") {
      setReasonOpen(false);
      void onFeedback("up");
      return;
    }
    // Thumbs-down: persist the rating immediately, then offer an
    // optional reason note via a small popover.
    void onFeedback("down");
    setReasonDraft(feedbackReason ?? "");
    setReasonOpen(true);
  };
  const submitReason = () => {
    if (!onFeedback) return;
    void onFeedback("down", reasonDraft.trim() || undefined);
    setReasonOpen(false);
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
          {editedAt && !streaming && (
            <span
              className={cn(
                "rounded px-1.5 py-px text-[10px] font-medium",
                "bg-black/[0.05] text-[var(--text-muted)]",
                "dark:bg-white/[0.06]"
              )}
              title={`Edited ${new Date(editedAt).toLocaleString()}`}
            >
              edited
            </span>
          )}
        </div>
        {editing && canEdit ? (
          <UserMessageEditor
            initialText={content}
            variant={isUser ? "user" : "assistant"}
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
              renderMentionText(content)
            ) : (
              <>
                {markdownEl}
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
        {!isUser && !streaming && truncated && (
          <div
            className={cn(
              "mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
              "border border-amber-500/30 bg-amber-500/10 text-amber-700",
              "dark:text-amber-300"
            )}
          >
            <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This reply was cut off because it hit the model's output
              limit.{onRegenerate ? " Regenerate to continue it." : ""}
            </span>
          </div>
        )}
        {hasVisionRelayInvocations && (
          <div className="mt-2 flex flex-col gap-1.5">
            {visionRelayInvocations!.map((v) => (
              <VisionRelayChip key={v.id} invocation={v} />
            ))}
          </div>
        )}
        {hasToolInvocations && (
          <div className="mt-2 flex flex-col gap-1.5">
            {displayedToolInvocations.map((t) => (
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
          (onRegenerate && !streaming) ||
          (onDelete && !streaming) ||
          canCopy ||
          canReadAloud ||
          canFeedback ||
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
                title={
                  copyClicked
                    ? "Copied"
                    : isUser
                      ? "Copy message to clipboard"
                      : "Copy reply to clipboard"
                }
                aria-label={
                  copyClicked
                    ? "Copied"
                    : isUser
                      ? "Copy message"
                      : "Copy reply"
                }
              >
                {copyClicked ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copyClicked ? "Copied" : "Copy"}</span>
              </button>
            )}
            {canReadAloud && (
              <button
                type="button"
                onClick={handleReadAloud}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
                  "text-[var(--text-muted)] transition",
                  "hover:bg-black/[0.04] hover:text-[var(--text)]",
                  "dark:hover:bg-white/[0.06]",
                  speaking && "text-[var(--accent)]"
                )}
                title={speaking ? "Stop reading" : "Read this reply aloud"}
                aria-label={speaking ? "Stop reading" : "Read aloud"}
                aria-pressed={speaking}
              >
                {speaking ? (
                  <Square className="h-3 w-3 fill-current" />
                ) : (
                  <Volume2 className="h-3 w-3" />
                )}
                <span>{speaking ? "Stop" : "Listen"}</span>
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
                title={
                  isUser
                    ? "Edit and resend"
                    : "Edit this reply (no re-stream)"
                }
                aria-label={
                  isUser ? "Edit and resend" : "Edit reply in place"
                }
              >
                <Pencil className="h-3 w-3" />
                <span>Edit</span>
              </button>
            )}
            {onRegenerate && !streaming && (
              <RegenerateControl onRegenerate={onRegenerate} />
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
            {onDelete && !streaming && (
              <button
                type="button"
                onClick={() => void onDelete()}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
                  "text-[var(--text-muted)] transition",
                  "hover:bg-rose-500/10 hover:text-rose-500"
                )}
                title="Delete this message"
                aria-label="Delete message"
              >
                <Trash2 className="h-3 w-3" />
                <span>Delete</span>
              </button>
            )}
            {canFeedback && (
              <>
                <button
                  type="button"
                  onClick={() => handleThumb("up")}
                  className={cn(
                    "inline-flex items-center rounded-md px-1.5 py-1 text-xs transition",
                    feedback === "up"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
                  )}
                  title="Good response"
                  aria-label="Good response"
                  aria-pressed={feedback === "up"}
                >
                  <ThumbsUp
                    className={cn(
                      "h-3 w-3",
                      feedback === "up" && "fill-current"
                    )}
                  />
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => handleThumb("down")}
                    className={cn(
                      "inline-flex items-center rounded-md px-1.5 py-1 text-xs transition",
                      feedback === "down"
                        ? "text-rose-500"
                        : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
                    )}
                    title="Bad response"
                    aria-label="Bad response"
                    aria-pressed={feedback === "down"}
                  >
                    <ThumbsDown
                      className={cn(
                        "h-3 w-3",
                        feedback === "down" && "fill-current"
                      )}
                    />
                  </button>
                  {reasonOpen && (
                    <div
                      className={cn(
                        "absolute left-0 top-full z-20 mt-1 w-64 rounded-card border p-2 shadow-lg",
                        "border-[var(--border)] bg-[var(--surface)]"
                      )}
                    >
                      <label className="mb-1 block text-[11px] font-medium text-[var(--text-muted)]">
                        What went wrong? (optional)
                      </label>
                      <textarea
                        value={reasonDraft}
                        onChange={(e) => setReasonDraft(e.target.value)}
                        rows={3}
                        autoFocus
                        placeholder="e.g. inaccurate, ignored my question…"
                        className={cn(
                          "w-full resize-none rounded-md border bg-[var(--bg)] px-2 py-1 text-xs",
                          "border-[var(--border)] text-[var(--text)]",
                          "outline-none focus:border-[var(--accent)]"
                        )}
                      />
                      <div className="mt-1.5 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setReasonOpen(false)}
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
                        >
                          Skip
                        </button>
                        <button
                          type="button"
                          onClick={submitReason}
                          className="rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
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
  /** ``"user"`` keeps the accent-tinted bubble + "Save & resend"
   *  copy; ``"assistant"`` paints a neutral surface and labels the
   *  primary action just "Save" — the patch happens in place
   *  without re-streaming, which makes "resend" misleading. */
  variant?: "user" | "assistant";
}

function UserMessageEditor({
  initialText,
  onSave,
  onCancel,
  variant = "user",
}: UserMessageEditorProps) {
  const isMobile = useIsMobile();
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
    // Desktop only: Enter (without Shift) submits, matching the main
    // InputBar. On mobile Enter inserts a newline so the phone keyboard's
    // return key doesn't silently fire edits.
    if (isMobile) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const isAssistant = variant === "assistant";
  return (
    <div
      className={cn(
        "w-full max-w-full px-3 py-2",
        isAssistant
          ? cn(
              "rounded-xl",
              "border border-black/10 dark:border-white/10",
              "bg-black/[0.03] dark:bg-white/[0.04]"
            )
          : cn(
              "rounded-2xl rounded-tr-md",
              "border border-[var(--accent)]/40",
              "bg-[var(--accent)]/10 dark:bg-[var(--accent)]/15",
              "shadow-sm"
            )
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
          "disabled:opacity-60",
          isAssistant && "font-mono leading-relaxed"
        )}
        placeholder={
          isAssistant ? "Edit the AI's reply..." : "Edit your message..."
        }
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
          {submitting
            ? isAssistant
              ? "Saving..."
              : "Sending..."
            : isAssistant
              ? "Save"
              : "Save & resend"}
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
        // ``items-start`` is critical when the same row mixes
        // image tiles (~200 px tall thumbnails) with PDF/file
        // chips (~28 px pills). Without it, flex's default
        // ``align-items: stretch`` blows up the small chips to
        // match the image's height — the bug that produced the
        // giant oval PDF pill next to a generated image.
        "mt-2 flex flex-wrap items-start gap-2",
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

/** Split-button regenerate control.
 *
 *  Left half: primary click → re-run the reply with whatever model is
 *    currently selected in the global picker. This is the 90% path —
 *    most regenerations are "same model, try harder".
 *  Right half (chevron): opens a popover listing every available model
 *    so the user can re-run against a different provider/model
 *    combination without first touching the top-nav model selector.
 *
 *  The popover flips to align above the button when there's more
 *  room above than below — matters on the long conversations where
 *  the last assistant turn is near the bottom of the viewport and
 *  the popover would otherwise clip under the input bar.
 */
function RegenerateControl({
  onRegenerate,
}: {
  onRegenerate: (override: RegenerateOverride | null) => Promise<void> | void;
}) {
  const available = useModelStore((s) => s.available);
  const selectedProviderId = useModelStore((s) => s.selectedProviderId);
  const selectedModelId = useModelStore((s) => s.selectedModelId);
  const setSelection = useModelStore((s) => s.setSelection);

  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chevronRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Decide flip direction based on viewport geometry *at open time*.
  // Done once per open rather than reactively on scroll; the popover
  // is short-lived so we don't need to re-measure.
  useEffect(() => {
    if (!open) return;
    const anchor = chevronRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setFlipUp(spaceBelow < 240 && spaceAbove > spaceBelow);
  }, [open]);

  const doRegenerate = async (override: RegenerateOverride | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRegenerate(override);
    } finally {
      setBusy(false);
    }
  };

  const hasChoices = available.length > 1;

  return (
    <div ref={wrapRef} className="relative inline-flex items-stretch">
      <button
        type="button"
        onClick={() => void doRegenerate(null)}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
          "text-[var(--text-muted)] transition",
          "hover:bg-black/[0.04] hover:text-[var(--text)]",
          "dark:hover:bg-white/[0.06]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Fuse visually with the chevron when it's present: square
          // off the right edge so the two buttons read as one pill.
          hasChoices && "rounded-r-none pr-1"
        )}
        title="Regenerate this reply with the current model"
        aria-label="Regenerate reply"
      >
        <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
        <span>Regenerate</span>
      </button>
      {hasChoices && (
        <button
          ref={chevronRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={busy}
          className={cn(
            "inline-flex items-center rounded-md rounded-l-none border-l border-transparent px-1 py-1 text-xs",
            "text-[var(--text-muted)] transition",
            "hover:bg-black/[0.04] hover:text-[var(--text)]",
            "dark:hover:bg-white/[0.06]",
            open && "bg-black/[0.05] text-[var(--text)] dark:bg-white/[0.08]",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          aria-label="Regenerate with a different model"
          aria-expanded={open}
          title="Regenerate with a different model"
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              open && !flipUp && "rotate-180",
              open && flipUp && "-rotate-180"
            )}
          />
        </button>
      )}
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute left-0 z-20 min-w-[240px] max-w-[320px] overflow-hidden rounded-md border shadow-lg",
            "border-[var(--border)] bg-[var(--surface)] py-1",
            flipUp ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          <div
            className={cn(
              "px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide",
              "text-[var(--text-muted)]"
            )}
          >
            Try a different model
          </div>
          <ul className="max-h-60 overflow-y-auto">
            {available.map((m) => {
              const isCurrent =
                m.provider_id === selectedProviderId &&
                m.model_id === selectedModelId;
              return (
                <li key={`${m.provider_id}:${m.model_id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      // Also update the global model selector so the
                      // conversation's "active model" readout matches
                      // the reply the user just forced — less confusing
                      // than silently diverging.
                      setSelection(m.provider_id, m.model_id);
                      setOpen(false);
                      void doRegenerate({
                        provider_id: m.provider_id,
                        model_id: m.model_id,
                      });
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs",
                      "text-[var(--text)] transition",
                      "hover:bg-[var(--accent)]/[0.08]"
                    )}
                    role="menuitem"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {m.display_name}
                      </span>
                      <span className="truncate text-[10px] text-[var(--text-muted)]">
                        {m.provider_name}
                      </span>
                    </span>
                    {isCurrent && (
                      <Check className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
