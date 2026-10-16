import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FileCode,
  FileDown,
  FileText,
  GripVertical,
  History,
  Loader2,
  MessageSquare,
  MoveHorizontal,
  Printer,
  Save,
  Settings2,
  X,
} from "lucide-react";

import { filesApi, type FileItem } from "@/api/files";
import { documentsApi, type DocumentDownloadFormat } from "@/api/documents";
import { useQueryClient } from "@tanstack/react-query";
import { VersionHistoryPanel } from "@/components/files/VersionHistoryPanel";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";
import { saveChip, type SaveChip } from "@/lib/editorSync";
import { confirm } from "@/components/shared/ConfirmDialog";
import { UserAvatar } from "@/components/shared/UserAvatar";
import {
  NOTE_WIDTH_CLASS,
  NOTE_WIDTH_LABEL,
  useNoteWidthStore,
} from "@/store/noteWidthStore";

import { buildExtensions } from "./extensions";
import type { WikiTarget } from "./WikiLinkExtension";
import { DocumentToolbar } from "./DocumentToolbar";
import { CommentBubbleMenu, EditorBubbleMenu } from "./EditorBubbleMenu";
import { CommentsPanel, type CommentDraft } from "./CommentsPanel";
import { anchorFromSelection, OPEN_COMMENT_EVENT } from "./CommentsExtension";
import { useDocComments } from "./useDocComments";
import { useIsPhone, useKeyboardInset } from "./useKeyboardInset";
import { toast } from "@/store/toastStore";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { useRegisterEditorAi } from "@/lib/editorAiBridge";
import { EditorContextBar } from "./EditorContextBar";
import { FindBar } from "./FindBar";
import { SuggestionBubble } from "./SuggestionControls";
import { EditorAiEnhance } from "./EditorAiEnhance";
import { LinkHoverPreview } from "./LinkHoverPreview";
import { DocumentOutline, WordCountPill } from "./EditorExtras";
import { useCollabProvider } from "./useCollabProvider";
import { usePageSetup } from "./usePageSetup";
import { PageSetupDialog } from "./PageSetupDialog";
import { PrintPreviewModal } from "./PrintPreviewModal";
import * as Y from "yjs";
import {
  spellCheckPluginKey,
  SPELLCHECK_WORD_EVENT,
  type SpellCheckWordClick,
} from "./SpellCheckExtension";
import { SpellCheckPopover } from "./SpellCheckPopover";
import { loadSpell } from "./spellDictionaries";
import { useSpellcheckPrefs } from "./useSpellcheckPrefs";

/**
 * Full-screen Document editor.
 *
 * Mounted on top of everything else in the app (same z-layer as
 * ``FilePreviewModal``) when the user clicks "New file" or hits
 * the Edit button on a Document preview. Responsibilities:
 *
 *  1. Establish the collab session (see ``useCollabProvider``) and
 *     wire the TipTap editor to the resulting Y.Doc.
 *  2. Render the toolbar + editor area + collaborator awareness
 *     strip (tiny user avatars with live cursors).
 *  3. Handle filename rename (PATCH /api/files/:id) on blur.
 *  4. Surface save status — "Connected / Syncing…" — driven by
 *     provider + document change events. The actual HTML snapshot
 *     writes happen server-side (Hocuspocus → snapshot endpoint);
 *     the UI just reports connectivity.
 *  5. Intercept Esc + backdrop clicks to close cleanly.
 */
interface DocumentEditorModalProps {
  file: FileItem;
  onClose: () => void;
  /** Called whenever we mutate the underlying file (rename, etc.)
   *  so the caller can refresh any listing it renders. */
  onFileUpdated?: (file: FileItem) => void;
  /** Render the editor *inline* (filling its parent) instead of as a
   *  full-screen portal modal — used by the Workspace navigator so a
   *  note opens in the main pane with the rail + nav still visible.
   *  Skips the backdrop, portal, body scroll-lock, and Esc-to-close. */
  inline?: boolean;
  /** Workspace-note-only: enables the ``[[`` wiki-link autocomplete and
   *  passes the items fetcher straight through to ``buildExtensions``.
   *  Omitted for normal Drive documents so their editor is unchanged. */
  wikiLink?: {
    items: (query: string) => Promise<WikiTarget[]>;
    /** ``@`` menu: people + items + dates (R-232). */
    mentions?: (query: string) => Promise<WikiTarget[]>;
    /** A person was mentioned — the host notifies them (R-232). */
    onMention?: (userId: string) => void;
  };
  /** Inline-only: a leading glyph rendered before the title (the note
   *  kind-icon), so the note bar's left cluster matches the shared
   *  ``ItemPaneHeader`` canvas/sheet/board use. */
  titleIcon?: React.ReactNode;
  /** Inline-only: a control rendered right after the title — the
   *  workspace ``⚡`` context toggle, mirroring ``ItemPaneHeader``. */
  titleAdornment?: React.ReactNode;
  /** Rename some other way than Drive's — a workspace note is renamed
   *  through its workspace item (Drive refuses to rename workspace files).
   *  When set, anyone who can edit the content can edit the title. */
  onRenameTitle?: (title: string) => Promise<void>;
  /** Open with the find bar on this text — where a chat citation points
   *  (WP-5.2). The longest leading run of its words that the document
   *  actually contains is searched for. */
  initialFind?: string;
}

/** The longest leading run of ``phrase``'s words found inside one block of
 *  the document (find matches within a paragraph), or ``null``. */
const md = new MarkdownIt({ html: false, linkify: true });

/** An Ask answer (Markdown) as HTML the editor turns into its own blocks. */
function markdownToHtml(markdown: string): string {
  return md.render(markdown);
}

function findablePrefix(editor: Editor, phrase: string): string | null {
  const blocks: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) {
      blocks.push(node.textContent.replace(/\s+/g, " ").toLowerCase());
      return false;
    }
    return true;
  });
  const words = phrase.split(/\s+/).filter(Boolean);
  for (let n = words.length; n >= 2; n--) {
    const cand = words.slice(0, n).join(" ");
    if (blocks.some((b) => b.includes(cand.toLowerCase()))) return cand;
  }
  return null;
}

/** Documents are stored as ``<name>.html`` / ``.md`` Drive files, but the
 *  editor title should read like a document name, not a filename — split so
 *  the extension survives a rename without ever being shown or typed. */
function splitDocExt(filename: string): { base: string; ext: string } {
  const m = filename.match(/\.(html?|md)$/i);
  return m
    ? { base: filename.slice(0, -m[0].length), ext: m[0] }
    : { base: filename, ext: "" };
}

export function DocumentEditorModal({
  file,
  onClose,
  onFileUpdated,
  inline = false,
  wikiLink,
  titleIcon,
  titleAdornment,
  onRenameTitle,
  initialFind,
}: DocumentEditorModalProps) {
  const queryClient = useQueryClient();
  const {
    ydoc,
    provider,
    status: collabStatus,
    user,
    error,
    warning: collabWarning,
    canEdit: serverCanEdit,
    synced,
    unsynced,
    epoch: collabEpoch,
  } = useCollabProvider(file.id);

  // Per-user editor width (shared with standalone Drive documents).
  const noteWidth = useNoteWidthStore((s) => s.width);
  const cycleNoteWidth = useNoteWidthStore((s) => s.cycle);

  const [filename, setFilename] = useState(() => splitDocExt(file.filename).base);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpenRef = useRef(false);
  historyOpenRef.current = historyOpen;
  const [renameError, setRenameError] = useState<string | null>(null);
  // Wall-clock timestamp of the last successful manual save. Drives
  // the persistent "Saved Xs ago" chip so a user on a broken-WS
  // production deployment gets durable feedback that their click
  // worked — without this they'd just see the same "Offline" chip
  // before and after the click and reasonably conclude the button
  // did nothing.
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  // Re-render the "Xs ago" chip on a slow tick so the relative
  // time stays current without making React part of every keystroke.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!lastSavedAt) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  // True when the caller is a grantee viewing a doc owned by
  // someone else. Drives the rename-input chrome (filename is
  // owner-only metadata even for editor-grantees).
  const sharedWithMe = file.sharing?.role === "grantee";
  // True when the caller may write to the document body — owner
  // outright, or a grantee whose grant carries ``can_edit=true``.
  // Drives the editor's ``editable`` prop, the manual-save button,
  // image-paste/drop uploads, and the Cmd/Ctrl+S keybind. When
  // false the toolbar quietly disables typing through TipTap's
  // built-in read-only mode and the collab token endpoint mints a
  // ``perm=read`` JWT so the Hocuspocus server rejects updates
  // even if a malicious client tried to flip ``editable`` on.
  //
  // The server decides (owner, ``can_edit`` grant, or a workspace
  // owner/admin/editor role) and says so with the collab token. Guessing
  // from Drive grants here used to give every workspace member — viewers
  // included — an editable editor whose edits the server then dropped
  // (roadmap R-218). Unknown (token not loaded yet) means read-only.
  // Nor before the server's copy has arrived: the local Y.Doc is empty
  // until then, and anything typed would merge in beside the real text.
  const canEdit = (serverCanEdit ?? false) && synced;
  // Paper, margins, header/footer, page numbers — in the Y.Doc (WP-6.4).
  const [pageSetup, applyPageSetup] = usePageSetup(ydoc);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  // The title: a Drive document is renamed by its owner only (it's the
  // file's name); a workspace note by anyone who can edit it (R-218).
  const titleEditable = onRenameTitle ? serverCanEdit === true : !sharedWithMe && serverCanEdit !== false;
  // Save / rename answer with a bare file row — keep the sharing summary
  // or an editor-grantee's UI flips to owner mode afterwards (R-218).
  const updateFile = useCallback(
    (updated: FileItem) => onFileUpdated?.({ ...updated, sharing: updated.sharing ?? file.sharing }),
    [onFileUpdated, file.sharing]
  );


  // The suggestion lists read through a ref, so items and members added
  // while the note is open show up without rebuilding the editor (R-232).
  const wikiRef = useRef(wikiLink);
  wikiRef.current = wikiLink;
  const hasWiki = Boolean(wikiLink);
  const stableWiki = useMemo(
    () =>
      hasWiki
        ? {
            items: (q: string) => wikiRef.current?.items(q) ?? Promise.resolve([]),
            mentions: (q: string) =>
              (wikiRef.current?.mentions ?? wikiRef.current?.items)?.(q) ?? Promise.resolve([]),
            onMention: (userId: string) => {
              wikiRef.current?.onMention?.(userId);
              // Tell the person (best effort; the backend checks they can
              // open this document and doesn't repeat itself).
              void documentsApi.notifyMention(file.id, userId).catch(() => undefined);
            },
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasWiki, file.id]
  );
  const extensions = useMemo(
    () =>
      buildExtensions({
        ydoc,
        provider,
        user,
        placeholder: "Start typing, or hit / for commands…",
        wikiLink: stableWiki,
      }),
    [ydoc, provider, user, stableWiki]
  );

  // ``editor`` from useEditor is the source of truth, but the
  // ProseMirror handlers we register on ``editorProps`` run from a
  // closure that's captured BEFORE useEditor returns. We bounce
  // through a ref so paste / drop handlers can still access the
  // live editor at call time without re-creating it on every render.
  const editorRef = useRef<Editor | null>(null);
  // Scope for the link hover-preview's delegated listener.
  const editorAreaRef = useRef<HTMLDivElement | null>(null);

  // Track outstanding pasted/dropped uploads so the SaveIndicator
  // can show "Uploading…" without each paste needing its own toast.
  const [pasteUploading, setPasteUploading] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // Find / replace bar (WP-4.5): null = closed. Ctrl/⌘+F opens find,
  // Ctrl/⌘+H opens it with the replace row (editors only).
  const [findMode, setFindMode] = useState<null | { replace: boolean; n: number; term?: string }>(null);

  // Comments (WP-4.5, R-227): the side panel, a draft on the selection,
  // and the thread that's focused (highlighted in the text too).
  const [commentsOpen, setCommentsOpen] = useState(false);
  const commentsOpenRef = useRef(false);
  commentsOpenRef.current = commentsOpen;
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const startCommentRef = useRef<() => void>(() => undefined);

  // ``canEdit`` is captured into the editorProps closure when the
  // editor is created and we deliberately don't rebuild the editor
  // every time the flag flips (would lose cursor position). Read
  // through a ref instead so paste / drop handlers always see the
  // current value.
  const canEditRef = useRef(canEdit);
  useEffect(() => {
    canEditRef.current = canEdit;
  }, [canEdit]);

  // Drains a list of File objects through the assets endpoint and
  // inserts each as an Image node at ``insertPos``. Images upload
  // in parallel but insert sequentially so their order matches the
  // user's selection / clipboard order.
  const uploadAndInsertImages = useCallback(
    async (files: File[], insertPos: number | null) => {
      if (files.length === 0) return;
      setPasteUploading(true);
      setPasteError(null);
      try {
        const assets = await Promise.all(
          files.map((f) => documentsApi.uploadAsset(file.id, f))
        );
        const ed = editorRef.current;
        if (!ed) return;
        // Build a single chained transaction so the snapshot the
        // collab service eventually persists has all the new images
        // in one update — keeps the Y.Doc history clean.
        let chain = ed.chain().focus();
        if (insertPos !== null) {
          chain = chain.setTextSelection(insertPos);
        }
        for (const asset of assets) {
          chain = chain.setImage({ src: asset.url });
        }
        chain.run();
      } catch (e) {
        setPasteError(apiErrorMessage(e, "Image upload failed"));
        // Auto-clear after a few seconds so a stale error doesn't
        // shadow a successful next paste.
        window.setTimeout(() => setPasteError(null), 4000);
      } finally {
        setPasteUploading(false);
      }
    },
    [file.id]
  );

  const editor = useEditor(
    {
      extensions,
      // Not every transaction (R-234): each keystroke, remote edit and
      // remote caret move re-rendered this whole modal. The toolbar, bubble
      // menu and block bar subscribe to what they show
      // (``useEditorFormatState``); outline / word count / comments listen
      // to document updates themselves.
      shouldRerenderOnTransaction: false,
      autofocus: "end",
      // Read-only grantees can't type; TipTap honours this by
      // disabling input + visually muting toolbar buttons through
      // the ``editor.isEditable`` getter the toolbar reads. The
      // collab token is *also* minted as ``perm=read`` for them so
      // even a hand-modified client can't smuggle writes through.
      editable: canEdit,
      editorProps: {
        attributes: {
          // Our own nspell-based checker (SpellCheckExtension) owns spelling
          // now — it draws styled squiggles + a suggestion popover with real
          // language selection. Disable the browser's native check so the two
          // don't double-underline. When the user toggles our checker off,
          // the sync effect below leaves this off too (off means off).
          spellcheck: "false",
          lang: "en",
          // Tell Grammarly / LanguageTool browser extensions to leave the
          // editor alone. They inject nodes into the contenteditable that
          // React doesn't know about, which throws "insertBefore … not a
          // child of this node" on the next render (a classic React +
          // rich-text-editor clash).
          "data-gramm": "false",
          "data-gramm_editor": "false",
          "data-enable-grammarly": "false",
          class: cn(
            // ``promptly-doc`` is our hand-rolled prose stylesheet
            // (see index.css) — Tailwind's preflight strips list
            // bullets, heading sizes, table borders, etc., and we
            // don't pull @tailwindcss/typography because it bundles
            // a lot of opinionated overrides that fight the Claude
            // palette.
            "promptly-doc focus:outline-none",
            "min-h-[60vh] px-6 pb-24 pt-4"
          ),
        },
        // Clicking an external link opens it in a new tab (Link is
        // configured ``openOnClick:false`` so the cursor can land inside
        // links, so we open explicitly here). In-app wiki links (``item=``)
        // are left for the note pane's click handler → item preview modal.
        handleClick: (_view, _pos, event) => {
          const a = (event.target as HTMLElement | null)?.closest(
            "a[href]"
          ) as HTMLAnchorElement | null;
          if (!a) return false;
          const href = a.getAttribute("href") || "";
          if (/^(https?:|mailto:|tel:)/i.test(href) && !href.includes("item=")) {
            window.open(a.href, "_blank", "noopener,noreferrer");
            return true;
          }
          return false;
        },
        // Intercept pasted images before ProseMirror falls back to
        // its default behaviour (which just turns them into
        // base64-encoded data URIs the Image extension rejects). Each
        // image hits the per-document assets bucket and comes back
        // as a signed URL we can embed.
        handlePaste: (_view, event) => {
          // Read-only grantees can't upload assets — the backend
          // 403s and silently dropping the paste here keeps the
          // editor honest about its state.
          if (!canEditRef.current) return false;
          const items = event.clipboardData?.items;
          if (!items || items.length === 0) return false;
          const images: File[] = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const f = item.getAsFile();
              if (f) images.push(f);
            }
          }
          if (images.length === 0) return false;
          event.preventDefault();
          void uploadAndInsertImages(images, null);
          return true;
        },
        handleKeyDown: (_view, event) => {
          const mod = event.ctrlKey || event.metaKey;
          if (!mod || event.altKey) return false;
          const key = event.key.toLowerCase();
          if (key === "f" && !event.shiftKey) {
            event.preventDefault();
            setFindMode((m) => ({ replace: false, n: (m?.n ?? 0) + 1 }));
            return true;
          }
          if (key === "h" && !event.shiftKey) {
            event.preventDefault();
            setFindMode((m) => ({ replace: true, n: (m?.n ?? 0) + 1 }));
            return true;
          }
          return false;
        },
        handleDOMEvents: {
          // Ctrl/⌘+Alt+M — comment on the selection, as in Docs.
          keydown: (_view, event) => {
            if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === "KeyM") {
              event.preventDefault();
              startCommentRef.current();
              return true;
            }
            return false;
          },
        },
        // Drag-and-drop pictures from the desktop / another tab.
        // ``moved=true`` means the user is dragging an existing
        // node inside the editor — leave that to ProseMirror.
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          if (!canEditRef.current) return false;
          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return false;
          const images = Array.from(files).filter((f) =>
            f.type.startsWith("image/")
          );
          if (images.length === 0) return false;
          event.preventDefault();
          const coords = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          void uploadAndInsertImages(images, coords?.pos ?? null);
          return true;
        },
      },
    },
    // Re-create the editor whenever the Y.Doc or provider identity
    // changes. The provider is async (null on first render, instance
    // once the websocket is ready) and the CollaborationCursor
    // extension needs a live awareness channel — without including
    // ``provider`` here the editor would stay mounted without cursor
    // support even after the socket opened. The Y.Doc itself is the
    // same instance across the transition so no keystrokes are lost
    // during the rebuild.
    [ydoc?.guid, Boolean(provider)]
  );

  // Keep the ref pointing at the live editor; consumed by the
  // paste / drop handlers above.
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const comments = useDocComments(file.id, editor, provider);
  const isPhone = useIsPhone();
  const keyboardInset = useKeyboardInset();
  const dockToolbar = isPhone && keyboardInset > 0 && canEdit && !error;
  startCommentRef.current = () => {
    if (!editor) return;
    if (!comments.canComment) {
      toast.info("You can read this document's comments, but not add them.");
      return;
    }
    const draft = anchorFromSelection(editor);
    if (!draft) {
      toast.info("Select some text to comment on.");
      return;
    }
    setCommentDraft(draft);
    setCommentsOpen(true);
  };
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setActiveComment(activeComment);
  }, [editor, activeComment]);
  // Clicking highlighted text opens its thread.
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setCommentsOpen(true);
      setActiveComment(id);
    };
    document.addEventListener(OPEN_COMMENT_EVENT, open);
    return () => document.removeEventListener(OPEN_COMMENT_EVENT, open);
  }, []);
  // A notification link (``?comment=<id>``) opens straight to the thread.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("comment");
    if (id) {
      setCommentsOpen(true);
      setActiveComment(id);
    }
  }, [file.id]);

  // ``useEditor`` captures ``editable`` at create time. If a
  // grantee's permission changes mid-session (e.g. owner promotes
  // them to Editor while the modal is open) we need to flip the
  // live instance too — otherwise the toolbar stays visually
  // disabled until the editor is rebuilt.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable !== canEdit) {
      editor.setEditable(canEdit);
    }
  }, [editor, canEdit]);

  // ------------------------------------------------------------------
  // Spell-check — sync the persisted preference into the editor plugin
  // ------------------------------------------------------------------
  const {
    enabled: spellEnabled,
    autocorrect: spellAutocorrect,
    lang: spellLang,
    personalWords,
    addPersonalWord,
  } = useSpellcheckPrefs();

  // Words ignored just for this note (the popover's "Ignore in this note").
  // Resets when a different file opens.
  const [sessionIgnores, setSessionIgnores] = useState<Set<string>>(
    () => new Set()
  );
  useEffect(() => {
    setSessionIgnores(new Set());
  }, [file.id]);

  // The word the user clicked a squiggle on → drives the suggestion popover.
  const [spellTarget, setSpellTarget] = useState<SpellCheckWordClick | null>(
    null
  );
  useEffect(() => {
    const onWord = (e: Event) => {
      const detail = (e as CustomEvent<SpellCheckWordClick>).detail;
      if (detail) setSpellTarget(detail);
    };
    document.addEventListener(SPELLCHECK_WORD_EVENT, onWord);
    return () => document.removeEventListener(SPELLCHECK_WORD_EVENT, onWord);
  }, []);

  // Push spell-check config into the plugin. Loading a dictionary is async
  // (code-split chunk), so gate the push on the instance resolving. The
  // dictionary is needed if EITHER squiggles or autocorrect is on — they're
  // independent toggles. ``ignored`` = personal dictionary ∪ this-note ignores.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const push = (config: {
      enabled: boolean;
      autocorrect: boolean;
      spell: Awaited<ReturnType<typeof loadSpell>> | null;
      ignored: Set<string>;
    }) => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(
        editor.view.state.tr.setMeta(spellCheckPluginKey, config)
      );
    };
    if (!spellEnabled && !spellAutocorrect) {
      push({
        enabled: false,
        autocorrect: false,
        spell: null,
        ignored: new Set(),
      });
      return;
    }
    let cancelled = false;
    void loadSpell(spellLang).then((spell) => {
      if (cancelled) return;
      const ignored = new Set<string>([
        ...personalWords,
        ...Array.from(sessionIgnores, (w) => w.toLowerCase()),
      ]);
      push({
        enabled: spellEnabled,
        autocorrect: spellAutocorrect,
        spell,
        ignored,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    editor,
    spellEnabled,
    spellAutocorrect,
    spellLang,
    personalWords,
    sessionIgnores,
  ]);

  // ------------------------------------------------------------------
  // Offline fallback — show the last saved version, read-only
  // ------------------------------------------------------------------
  // When live sync can't connect at all (stopped collab container, a
  // tunnel without WebSocket support) the editor never receives the
  // document. This used to load the saved HTML *into* the collaborative
  // editor — which created a second copy of every paragraph that merged
  // with the real one on reconnect, duplicating the whole document for
  // everyone (R-022). Now the saved HTML is shown in a separate read-only
  // view until the live copy arrives; nothing is ever seeded.
  const [offlineHtml, setOfflineHtml] = useState<string | null>(null);
  useEffect(() => {
    if (synced || collabStatus !== "disconnected") return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { blob } = await documentsApi.download(file.id, "html");
        const html = (await blob.text()).trim();
        if (!cancelled) setOfflineHtml(html);
      } catch (err) {
        console.warn("[doc] offline preview failed", err);
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [collabStatus, synced, file.id]);
  const showOfflineCopy = !synced && offlineHtml !== null;

  // The editor page's Ask panel (WP-5.5): what's selected, and inserting
  // an answer (Markdown → the document's own blocks) after the selection.
  useRegisterEditorAi({
    getSelection: () => {
      if (!editor || editor.state.selection.empty) return null;
      const { from, to } = editor.state.selection;
      const text = editor.state.doc.textBetween(from, to, "\n").trim();
      if (!text) return null;
      const words = text.split(/\s+/).length;
      return { label: `${words} word${words === 1 ? "" : "s"} selected`, text: text.slice(0, 8000) };
    },
    insert: (markdown: string) => {
      if (!editor || !canEdit) {
        toast.info("You can't edit this document.");
        return;
      }
      const html = DOMPurify.sanitize(markdownToHtml(markdown));
      editor.chain().focus().insertContentAt(editor.state.selection.to, html).run();
    },
  });

  // A citation link: once the content has arrived, open find on the passage.
  const initialFindDone = useRef(false);
  useEffect(() => {
    if (!initialFind || initialFindDone.current || !synced || !editor) return;
    initialFindDone.current = true;
    const term = findablePrefix(editor, initialFind);
    if (term) setFindMode({ replace: false, n: 1, term });
  }, [initialFind, synced, editor]);

  // The save chip follows the provider: unacknowledged local changes are
  // "Saving…", none is "Saved", and while disconnected it says how much
  // lives only in this tab (R-224). Remote updates don't count as edits.
  const [lastLocalEditAt, setLastLocalEditAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!ydoc) return;
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (provider && origin === provider) return;
      setLastLocalEditAt(new Date());
    };
    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
    };
  }, [ydoc, provider]);
  const chip = saveChip({
    fatal: error,
    synced,
    status: collabStatus,
    unsynced,
    savedManuallyAt: lastSavedAt,
    lastLocalEditAt,
  });

  // Leaving with edits only this tab has: ask first, and let the browser
  // warn on reload / tab close (R-225).
  const unsyncedRef = useRef(0);
  unsyncedRef.current = collabStatus === "connected" ? 0 : unsynced;
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsyncedRef.current > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  const requestClose = useCallback(async () => {
    if (unsyncedRef.current > 0) {
      const ok = await confirm({
        title: "Close with unsynced changes?",
        message:
          "Live editing is offline, and some of your edits are only in this tab. Press Save first to keep them, or close and lose them.",
        confirmLabel: "Close anyway",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }, [onClose]);

  // Body scroll lock while the modal is open. (Inline mode lives inside
  // the normal page flow, so it must not touch body scroll.)
  useEffect(() => {
    if (inline) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [inline]);

  // Escape closes the modal (matching the preview modal's UX). Skipped
  // inline — Esc shouldn't yank the user out of a note in the pane.
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Decide after every other handler has had this key: the slash menu
      // (handled inside ProseMirror), the emoji picker, the spellcheck
      // popover and the download menu all close on Esc, and used to take
      // the whole document with them.
      window.setTimeout(() => {
        if (e.defaultPrevented) return;
        if (document.querySelector(ESC_LAYERS)) return;
        if (historyOpenRef.current) {
          setHistoryOpen(false);
          return;
        }
        if (commentsOpenRef.current) {
          setCommentsOpen(false);
          return;
        }
        void requestClose();
      }, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, inline]);

  // Collaborator awareness — the CollaborationCursor extension
  // publishes each client's user object into the provider's
  // awareness state. We subscribe here to render little avatars.
  const [collaborators, setCollaborators] = useState<
    { clientId: number; name: string; color: string; avatar: string | null }[]
  >([]);
  useEffect(() => {
    if (!provider) return;
    const awareness = provider.awareness;
    if (!awareness) return;
    const update = () => {
      const states = Array.from(awareness.getStates().entries()) as [
        number,
        {
          user?: { name?: string; color?: string; avatar?: string | null };
        }
      ][];
      const list = states
        .filter(([id]) => id !== awareness.clientID)
        .map(([id, state]) => ({
          clientId: id,
          name: state.user?.name ?? "Anonymous",
          color: state.user?.color ?? "#D97757",
          avatar: state.user?.avatar ?? null,
        }));
      setCollaborators(list);
    };
    awareness.on("update", update);
    update();
    return () => {
      awareness.off("update", update);
    };
  }, [provider]);

  const handleFilenameBlur = useCallback(async () => {
    const { base, ext } = splitDocExt(file.filename);
    // Re-attach the hidden storage extension; tolerate a user typing it.
    const typed = filename.trim();
    const next = typed && ext && typed.toLowerCase().endsWith(ext.toLowerCase())
      ? typed
      : typed + ext;
    if (!typed || next === file.filename) {
      setFilename(base);
      return;
    }
    setRenameError(null);
    try {
      if (onRenameTitle) {
        await onRenameTitle(typed.replace(/\.(html?|md)$/i, ""));
        updateFile({ ...file, filename: next });
      } else {
        const updated = await filesApi.renameFile(file.id, next);
        setFilename(splitDocExt(updated.filename).base);
        updateFile(updated);
      }
      // Keep Drive listings in sync.
      await queryClient.invalidateQueries({ queryKey: ["drive"] });
    } catch (e) {
      setRenameError(apiErrorMessage(e, "Rename failed"));
      setFilename(base);
    }
  }, [filename, file, onRenameTitle, updateFile, queryClient]);

  // Owner-only manual save. Bypasses the Hocuspocus snapshot path
  // entirely — captures whatever the editor currently renders and
  // ships it straight to the backend. Crucial as a fallback when
  // the WS pipeline is misbehaving (Cloudflare tunnel, stopped
  // collab container, proxy buffering): on prod those manifest as
  // the file silently staying at 0 bytes because no snapshot ever
  // fires. The button is also generally useful as an explicit
  // "I'm done" affordance.
  const [manualSaving, setManualSaving] = useState(false);
  const [manualSaveError, setManualSaveError] = useState<string | null>(null);
  const handleManualSave = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || manualSaving) return;
    if (!canEdit) return;  // read-only grantee shortcut
    setManualSaving(true);
    setManualSaveError(null);
    try {
      const html = ed.getHTML();
      // The CRDT state rides along so the server merges these edits into
      // the document itself — a Save while live sync is down used to
      // write only the HTML, which the next live edit overwrote (R-022).
      const updated = await documentsApi.manualSave(file.id, html, {
        yjsState: ydoc ? encodeState(ydoc) : undefined,
        epoch: collabEpoch,
      });
      updateFile(updated);
      await queryClient.invalidateQueries({ queryKey: ["drive"] });
      // The timestamp drives a *durable* "Saved Xs ago" chip even
      // when the collab WS is down. Without it, the SaveIndicator
      // would re-render straight back to "Offline — Save manually"
      // and the user would reasonably think the click did nothing.
      setLastSavedAt(new Date());
    } catch (e) {
      setManualSaveError(apiErrorMessage(e, "Save failed"));
      window.setTimeout(() => setManualSaveError(null), 5000);
    } finally {
      setManualSaving(false);
    }
  }, [canEdit, file.id, manualSaving, updateFile, queryClient, ydoc, collabEpoch]);

  // Download in the requested format. ``html`` returns the on-disk
  // blob verbatim, ``md`` runs it through markdownify on the
  // server, ``pdf`` renders via xhtml2pdf. We do the file-save dance
  // client-side via a temporary blob URL so the browser's native
  // "Save as" picker fires for every format consistently.
  const [downloading, setDownloading] = useState<DocumentDownloadFormat | null>(
    null
  );
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const handleDownload = useCallback(
    async (format: DocumentDownloadFormat) => {
      if (downloading) return;
      setDownloadMenuOpen(false);
      setDownloading(format);
      setDownloadError(null);
      try {
        const { blob, filename } = await documentsApi.download(
          file.id,
          format
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Defer the revoke so Safari's download path has time to
        // grab the blob before the URL is invalidated.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setDownloadError(apiErrorMessage(e, "Download failed"));
        window.setTimeout(() => setDownloadError(null), 5000);
      } finally {
        setDownloading(null);
      }
    },
    [downloading, file.id]
  );

  // Close the download menu on outside click / Escape so it doesn't
  // hang open when the user moves on.
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!downloadMenuOpen) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        downloadMenuRef.current &&
        !downloadMenuRef.current.contains(target)
      ) {
        setDownloadMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDownloadMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [downloadMenuOpen]);

  // Cmd/Ctrl + S → manual save. Mirrors every desktop editor a
  // user would have muscle memory for and makes the "I want to be
  // sure that's persisted" flow keyboard-driven.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleManualSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleManualSave]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Tap on the backdrop (not a click that bubbled from the card)
      // closes the modal. Same behaviour as the file preview modal
      // so the Drive has a consistent "click-away" feel.
      if (e.target === e.currentTarget) void requestClose();
    },
    [requestClose]
  );

  // Inline mode fills its parent (no modal inset / rounding / shadow);
  // modal mode keeps the centred, rounded, shadowed card on a backdrop.
  const cardClass = inline
    ? "relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg)]"
    : cn(
        "relative flex flex-1 flex-col overflow-hidden bg-[var(--bg)]",
        "md:mx-auto md:w-full md:max-w-6xl md:rounded-2xl md:border md:border-[var(--border)] md:shadow-2xl"
      );

  const card = (
      <div
        className={cardClass}
        onMouseDown={inline ? undefined : (e) => e.stopPropagation()}
      >
      {/* Header — inline (workspace note) matches the shared ItemPaneHeader
          chrome (bg / height, plus a leading kind-icon + ⚡ toggle) so every
          item bar lines up; modal (Drive) keeps its own surface + notch
          padding + rounded top. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-[var(--border)]",
          inline
            ? "bg-[var(--bg)] px-3 py-1.5"
            : cn(
                "bg-[var(--surface)] px-3 py-2",
                // Respect the notch on both sides + top of the sheet so
                // the close button never ends up under the status bar on
                // iOS PWA installs.
                "pl-[max(env(safe-area-inset-left,0),0.75rem)]",
                "pr-[max(env(safe-area-inset-right,0),0.75rem)]",
                "pt-[max(env(safe-area-inset-top,0),0.5rem)] md:px-4",
                // Round the top corners to match the card radius.
                "md:rounded-t-2xl md:pt-2"
              )
        )}
      >
        {inline && titleIcon}
        <input
          id="document-editor-title"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          onBlur={handleFilenameBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          // Grantees can read the doc but not rename it — make the
          // input static so a click doesn't put the user in an edit
          // state that would fail the moment they hit blur.
          readOnly={!titleEditable}
          className={cn(
            "min-w-0 flex-1 truncate rounded-md bg-transparent px-2 py-1 text-sm font-semibold outline-none",
            !titleEditable
              ? "cursor-default"
              : "focus:bg-black/5 dark:focus:bg-white/5"
          )}
          aria-label="Document title"
        />

        {inline && titleAdornment}

        <SaveIndicator
          chip={chip}
          error={error}
          lastSavedAt={lastSavedAt}
        />

        {/* Manual save — visible for owners and editor-grantees.
            Read-only grantees never see it (the manual-save
            endpoint 403s for them and the editor's collab token
            comes back as ``perm=read``), so the affordance would
            be confusing. The collab pipeline still drives the
            autosave dot; this button is the "I'm done" affordance
            + the bulletproof fallback when the WS path is
            misbehaving (typical prod symptom: file silently stays
            at 0 bytes). Cmd/Ctrl + S also fires it. */}
        {canEdit && (
          <button
            type="button"
            onClick={() => void handleManualSave()}
            disabled={manualSaving || Boolean(error)}
            aria-label="Save document now"
            title="Save now (⌘/Ctrl + S)"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm transition",
              "text-[var(--text)] hover:bg-black/5 dark:hover:bg-white/10",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {manualSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Save</span>
          </button>
        )}

        {/* Comments (WP-4.5, R-227) — everyone who can open the document
            reads them; editors add, reply and resolve. */}
        <button
          type="button"
          onClick={() => setCommentsOpen((v) => !v)}
          aria-label={comments.openCount ? `Comments (${comments.openCount} open)` : "Comments"}
          aria-pressed={commentsOpen}
          title="Comments (Ctrl+Alt+M on a selection to add one)"
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm transition",
            commentsOpen ? "bg-black/10 text-[var(--text)] dark:bg-white/15" : "text-[var(--text)] hover:bg-black/5 dark:hover:bg-white/10"
          )}
        >
          <MessageSquare className="h-4 w-4" />
          <span className="hidden lg:inline">Comments</span>
          {comments.openCount > 0 && (
            <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold leading-4 text-white">
              {comments.openCount}
            </span>
          )}
        </button>

        {/* Version history (Phase 9). Available to anyone who can read the
            doc; restore is gated to editors inside the panel. */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          aria-label="Version history"
          title="Version history"
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm transition",
            "text-[var(--text)] hover:bg-black/5 dark:hover:bg-white/10"
          )}
        >
          <History className="h-4 w-4" />
          <span className="hidden lg:inline">History</span>
        </button>

        {/* Format-aware download menu. Three options (HTML / MD /
            PDF) all hit ``GET /api/documents/:id/download`` which
            picks the renderer based on ``?format=``. */}
        <div ref={downloadMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setDownloadMenuOpen((v) => !v)}
            disabled={Boolean(downloading) || Boolean(error)}
            aria-haspopup="menu"
            aria-expanded={downloadMenuOpen}
            aria-label="Download document"
            title="Download as…"
            className={cn(
              "inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm transition",
              "text-[var(--text)] hover:bg-black/5 dark:hover:bg-white/10",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <ChevronDown className="h-3 w-3" />
          </button>
          {downloadMenuOpen && (
            <div
              role="menu"
              className={cn(
                "absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--border)]",
                "bg-[var(--bg)] shadow-lg"
              )}
            >
              <DownloadMenuItem
                icon={<FileText className="h-4 w-4" />}
                label="Word (.docx)"
                onClick={() => {
                  setDownloadMenuOpen(false);
                  // From the live editor, so it has the very latest edits.
                  void import("@/lib/office/wordActions")
                    .then(({ downloadDocx }) => downloadDocx(file, editorRef.current?.getHTML(), pageSetup))
                    .catch((e) => {
                      setDownloadError(apiErrorMessage(e, "Download failed"));
                      window.setTimeout(() => setDownloadError(null), 5000);
                    });
                }}
              />
              <DownloadMenuItem
                icon={<FileCode className="h-4 w-4" />}
                label="Web page (.html)"
                onClick={() => void handleDownload("html")}
              />
              <DownloadMenuItem
                icon={<FileText className="h-4 w-4" />}
                label="Markdown (.md)"
                onClick={() => void handleDownload("md")}
              />
              <DownloadMenuItem
                icon={<FileDown className="h-4 w-4" />}
                label="PDF (.pdf)"
                onClick={() => void handleDownload("pdf")}
              />
              <div role="separator" className="my-1 border-t border-[var(--border)]" />
              <DownloadMenuItem
                icon={<Printer className="h-4 w-4" />}
                label="Print preview…"
                onClick={() => {
                  setDownloadMenuOpen(false);
                  setPrintPreviewOpen(true);
                }}
              />
              <DownloadMenuItem
                icon={<Settings2 className="h-4 w-4" />}
                label="Page setup…"
                onClick={() => {
                  setDownloadMenuOpen(false);
                  setPageSetupOpen(true);
                }}
              />
            </div>
          )}
        </div>

        <Collaborators avatars={collaborators} self={user} />

        <button
          type="button"
          onClick={cycleNoteWidth}
          aria-label={`Editor width: ${NOTE_WIDTH_LABEL[noteWidth]} — click to change`}
          title={`Editor width: ${NOTE_WIDTH_LABEL[noteWidth]} (click to change)`}
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10",
            noteWidth === "default"
              ? "text-[var(--muted)] hover:text-[var(--text)]"
              : "text-[var(--accent-text)]"
          )}
        >
          <MoveHorizontal className="h-5 w-5" />
        </button>

        <button
          type="button"
          onClick={() => void requestClose()}
          aria-label="Close document"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--muted)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {renameError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-500">
          Rename failed: {renameError}
        </div>
      )}

      {pasteError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-500">
          {pasteError}
        </div>
      )}

      {pasteUploading && !pasteError && (
        <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--muted)]">
          Uploading image…
        </div>
      )}

      {manualSaveError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-500">
          Save failed: {manualSaveError}
        </div>
      )}

      {downloadError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-500">
          Download failed: {downloadError}
        </div>
      )}

      {/* Loud collab-down banner — when the WebSocket pipeline
          fails (which on prod tends to be a Cloudflare/proxy WS
          issue, or a stopped collab container), the inline "Offline"
          chip is easy to miss and the user thinks autosave is
          working. Surface it explicitly so they reach for the
          Save button. */}
      {collabWarning && !error && collabStatus !== "disconnected" && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <div>{collabWarning}</div>
        </div>
      )}
      {collabStatus === "disconnected" && !error && (
        <div className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {synced ? (
            <div>
              <strong className="font-semibold">Live sync offline.</strong>{" "}
              Keep editing — your changes are kept in this tab and sync when
              the connection is back. Press Save to store them on the server
              now, in case this tab closes first.
            </div>
          ) : (
            <div>
              <strong className="font-semibold">Can&apos;t reach live editing.</strong>{" "}
              {showOfflineCopy
                ? "Showing the last saved version, read-only. "
                : ""}
              Editing comes back as soon as the connection does.
            </div>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div
        className={cn("relative", serverCanEdit === false && "hidden", dockToolbar && "fixed inset-x-0 z-[60] shadow-[0_-4px_12px_rgba(0,0,0,0.12)]")}
        // On a phone with the keyboard up, the toolbar sits just above it,
        // as in Docs (R-231) — not three rows over the top of the page.
        style={dockToolbar ? { bottom: keyboardInset } : undefined}
      >
        <DocumentToolbar
          editor={editor}
          documentId={file.id}
          // Only disable on hard collab errors. y-prosemirror queues
          // local edits while the websocket is reconnecting, so there's
          // no reason to freeze the toolbar during a transient
          // "connecting" state — doing so makes the editor feel broken
          // on every cold open.
          disabled={!editor || Boolean(error) || !canEdit}
          onFind={() => setFindMode((m) => ({ replace: false, n: (m?.n ?? 0) + 1 }))}
        />
        {canEdit && !error && <EditorContextBar editor={editor} />}
      </div>
      <SuggestionBubble editor={editor} canResolve={canEdit} />
      {editor && !error && findMode && (
        <FindBar
          key={findMode.n}
          editor={editor}
          withReplace={findMode.replace}
          canReplace={canEdit}
          initialTerm={findMode.term}
          onClose={() => {
            setFindMode(null);
            editor.commands.focus();
          }}
        />
      )}

      {/* Editor area — relative wrapper so the outline rail + word-count
          pill float over the scroll region instead of scrolling with it. */}
      <div ref={editorAreaRef} className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex-1 overflow-y-auto",
            // Horizontal + bottom safe-areas so content doesn't hide
            // behind the iOS home indicator / rounded corners.
            "pl-[env(safe-area-inset-left,0)]",
            "pr-[env(safe-area-inset-right,0)]",
            "pb-[max(env(safe-area-inset-bottom,0),1.5rem)]",
            commentsOpen && "sm:pr-80"
          )}
        >
          {error ? (
            <div className="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-600 dark:text-red-300">
              <AlertTriangle className="h-6 w-6" />
              <div>
                <div className="font-semibold">Collaboration unavailable</div>
                <div className="mt-1 text-xs opacity-80">{error}</div>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "document-print-root mx-auto px-0 md:px-4",
                NOTE_WIDTH_CLASS[noteWidth]
              )}
            >
              {/* In-page display title (Batch 10) — the page reads like a
                  document, not a form. Same state + rename flow as the
                  compact header input; prints with the content. */}
              <input
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                onBlur={handleFilenameBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                readOnly={!titleEditable}
                placeholder="Untitled"
                aria-label="Document title"
                className={cn(
                  // px-6 matches the ProseMirror content's 24px padding so
                  // the title's left edge lines up with the body text.
                  "w-full bg-transparent px-6 pb-1 pt-6 text-3xl font-bold tracking-tight text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]/40",
                  !titleEditable && "cursor-default"
                )}
              />
              {showOfflineCopy ? (
                <div
                  className="ProseMirror px-6 py-4"
                  // Sanitised server-side on every save path (the same
                  // allowlist the version-history preview relies on).
                  dangerouslySetInnerHTML={{ __html: offlineHtml ?? "" }}
                />
              ) : (
                <EditorContent editor={editor} />
              )}
            </div>
          )}
        </div>
        {/* Block drag handle (MIT). Guarded on a live editor + no collab
            error. */}
        {editor && !error && canEdit && (
          <DragHandle editor={editor}>
            <span
              className="doc-drag-handle"
              aria-label="Drag to move block"
            >
              <GripVertical className="h-4 w-4" />
            </span>
          </DragHandle>
        )}
        <DocumentOutline editor={editor} />
        <WordCountPill editor={editor} />
        <LinkHoverPreview containerRef={editorAreaRef} />
        {/* AI "Enhance" the selection — rendered LAST (after the Tiptap
            DragHandle) so its mount appends rather than inserting before the
            DragHandle's Tiptap-moved DOM node; its wrapper is always mounted
            (see EditorAiEnhance) to avoid the insertBefore reconciliation
            error entirely. */}
        {editor && !error && canEdit && <EditorAiEnhance editor={editor} fileId={file.id} />}
        {/* Selection formatting bubble (R-226 — it existed but was never
            mounted). Same commands as the toolbar. */}
        {editor && !error && canEdit && (
          <EditorBubbleMenu editor={editor} onComment={() => startCommentRef.current()} />
        )}
        {/* Someone who can comment but not edit (WP-6.6). */}
        {editor && !error && !canEdit && comments.canComment && (
          <CommentBubbleMenu editor={editor} onComment={() => startCommentRef.current()} />
        )}
        {commentsOpen && !error && (
          <CommentsPanel
            documentId={file.id}
            editor={editor}
            threads={comments.threads}
            canComment={comments.canComment}
            loading={comments.loading}
            draft={commentDraft}
            activeId={activeComment}
            onActivate={setActiveComment}
            onDraftDone={() => setCommentDraft(null)}
            onChanged={comments.changed}
            onClose={() => {
              setCommentsOpen(false);
              setCommentDraft(null);
              setActiveComment(null);
            }}
          />
        )}
        {/* Spell-check suggestion popover — opens when a squiggle is clicked
            (the SpellCheckExtension fires a DOM event caught above). */}
        {editor && !error && canEdit && spellTarget && (
          <SpellCheckPopover
            editor={editor}
            target={spellTarget}
            lang={spellLang}
            onAddWord={(w) => addPersonalWord(w)}
            onIgnore={(w) =>
              setSessionIgnores((prev) => new Set(prev).add(w.toLowerCase()))
            }
            onClose={() => setSpellTarget(null)}
          />
        )}
      </div>

      {historyOpen && (
        // One history for documents, sheets and whiteboards (WP-6.2): a
        // restore is done by the server, exactly, and the editor reloads.
        <VersionHistoryPanel fileId={file.id} onClose={() => setHistoryOpen(false)} />
      )}

      <PageSetupDialog
        open={pageSetupOpen}
        value={pageSetup}
        readOnly={!canEdit}
        onClose={() => setPageSetupOpen(false)}
        onApply={applyPageSetup}
      />
      <PrintPreviewModal
        open={printPreviewOpen}
        fileId={file.id}
        title={filename}
        version={JSON.stringify(pageSetup)}
        onClose={() => setPrintPreviewOpen(false)}
        onPageSetup={() => setPageSetupOpen(true)}
      />
      </div>
  );

  if (inline) {
    return <div className="flex h-full min-h-0 flex-col">{card}</div>;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm md:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-editor-title"
      onMouseDown={handleBackdropClick}
    >
      {card}
    </div>,
    document.body
  );
}

function SaveIndicator({
  chip,
  error,
  lastSavedAt,
}: {
  chip: SaveChip;
  error: string | null;
  /** The last manual Save this session (shown in the tooltip). */
  lastSavedAt: Date | null;
}) {
  const styles =
    chip.kind === "error"
      ? "bg-red-500/10 text-red-500"
      : chip.kind === "offline"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : chip.kind === "saved"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-[var(--muted)]";
  const title =
    chip.kind === "error"
      ? (error ?? undefined)
      : chip.kind === "offline"
        ? "Live sync is offline. Changes stay in this tab and sync on reconnect; Save stores them now."
        : lastSavedAt
          ? `Last saved manually at ${lastSavedAt.toLocaleTimeString()}`
          : chip.kind === "saved"
            ? "Every change has reached the server."
            : undefined;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs", styles)}
      aria-live="polite"
      aria-label={chip.label}
      title={title}
    >
      {chip.kind === "saving" || chip.kind === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : chip.kind === "saved" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      {/* A phone shows the icon only (R-224); the label stays readable
          to screen readers through aria-label. */}
      <span className="hidden sm:inline">{chip.label}</span>
    </span>
  );
}

/** Open layers that own Esc — while one is up, Esc closes it, not the
 *  document. */
const ESC_LAYERS = [
  "[data-esc-layer]",
  "[role='menu']",
  "[role='listbox']",
  "[role='dialog'][aria-modal='true']",
  ".tippy-box",
].join(", ");

function DownloadMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
        "text-[var(--text)] transition hover:bg-[var(--accent)]/10"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Collaborators({
  avatars,
  self,
}: {
  avatars: {
    clientId: number;
    name: string;
    color: string;
    avatar?: string | null;
  }[];
  self: { name: string; color: string; avatar?: string | null } | null;
}) {
  if (!self && avatars.length === 0) return null;
  const all = self
    ? [
        ...avatars,
        {
          clientId: -1,
          name: `${self.name} (you)`,
          color: self.color,
          avatar: self.avatar ?? null,
        },
      ]
    : avatars;
  return (
    <div className="hidden items-center -space-x-2 sm:flex">
      {all.slice(0, 4).map((a) => (
        <UserAvatar
          key={a.clientId}
          name={a.name}
          avatarUrl={a.avatar}
          color={a.color}
          size={28}
          className="border-2 border-[var(--surface)]"
        />
      ))}
      {all.length > 4 && (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--surface)] bg-neutral-500 text-[10px] font-semibold text-white">
          +{all.length - 4}
        </span>
      )}
    </div>
  );
}

/** Base64 of the editor's full CRDT state, for a merge-safe manual save. */
function encodeState(ydoc: Y.Doc): string {
  const bytes = Y.encodeStateAsUpdate(ydoc);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
