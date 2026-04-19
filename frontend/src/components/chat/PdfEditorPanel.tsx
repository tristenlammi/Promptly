import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import {
  AlertTriangle,
  Bold,
  Code,
  Download,
  ExternalLink,
  FileText,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Quote,
  Redo2,
  Save,
  Strikethrough,
  Undo2,
  X,
} from "lucide-react";

import { apiClient } from "@/api/client";
import { filesApi, type FileSourceContent } from "@/api/files";
import type { MessageAttachmentSnapshot } from "@/api/types";
import { useEditorStore } from "@/store/editorStore";
import { cn } from "@/utils/cn";

/**
 * Slide-in side panel for inspecting (and, where applicable, editing)
 * a PDF attachment from chat. Mounted once at the ChatPage level;
 * visibility is driven by ``useEditorStore.open``.
 *
 * Two modes, decided up-front from the attachment's ``source_kind``:
 *
 * * **Editable** (Phase A3) — the chip is a ``rendered_pdf`` with a
 *   linked ``markdown_source``. We load the source via
 *   ``filesApi.getSource``, hand it to a Tiptap editor, and a save
 *   re-renders the PDF in place. Used for AI-generated documents.
 *
 * * **Preview** (Phase B3) — every other PDF (user uploads, generated
 *   PDFs whose source has been deleted out from under them). We fetch
 *   the PDF bytes via the authenticated ``apiClient``, wrap them in
 *   an object URL, and render in an ``<iframe>``. No editing surface,
 *   no save flow — just the file plus a download button.
 *
 * Mode is decided once when the panel opens; switching attachments
 * remounts the inner component so the wrong toolbar / footer can never
 * leak across.
 */
export function PdfEditorPanel() {
  const open = useEditorStore((s) => s.open);
  const closeEditor = useEditorStore((s) => s.closeEditor);

  if (!open) return null;
  // Generated PDFs with a Markdown source get the full editor; every
  // other PDF (user uploads, source-less artefacts) gets the read-
  // only preview. We key the inner components on the file id so a
  // user clicking a different chip while the panel is open swaps the
  // doc cleanly without any "previous file flicker".
  if (open.source_kind === "rendered_pdf") {
    return (
      <PdfEditorPanelInner
        key={open.id}
        attachment={open}
        onClose={closeEditor}
      />
    );
  }
  return (
    <PdfPreviewPanelInner
      key={open.id}
      attachment={open}
      onClose={closeEditor}
    />
  );
}

interface InnerProps {
  attachment: MessageAttachmentSnapshot;
  onClose: () => void;
}

function PdfEditorPanelInner({ attachment, onClose }: InnerProps) {
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "missing" | "error"
  >("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState<FileSourceContent | null>(null);
  const [savedMarkdown, setSavedMarkdown] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // The editor instance is created once on mount; the doc itself is
  // swapped in via ``setContent`` once the source has loaded.
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Pull the heading levels the assistant actually uses in
        // generated docs. Anything beyond H4 looks the same on screen
        // and just clutters the floating toolbar.
        heading: { levels: [1, 2, 3, 4] },
      }),
      Markdown.configure({
        // The PDF renderer uses GFM tables / fenced code, so accept
        // them on the wire too. Keeping breaks set to "lossy" lets
        // the user split paragraphs with single Enter presses without
        // surprising them with double newlines on save.
        html: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        // Tailwind classes scope the prose styles to the editor body
        // so it visually matches the rest of the app's chat surface.
        class: cn(
          "promptly-prose max-w-none focus:outline-none",
          "min-h-[400px] px-4 py-3 text-sm text-[var(--text)]"
        ),
      },
    },
  });

  // ---- Load the source on first mount / when the attachment changes ----
  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setLoadError(null);
    void (async () => {
      try {
        const data = await filesApi.getSource(attachment.id);
        if (cancelled) return;
        setSource(data);
        setSavedMarkdown(data.content);
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        if (status === 404) {
          setLoadState("missing");
        } else {
          setLoadError(extractError(err));
          setLoadState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);

  // Hydrate the Tiptap doc once both the editor and the source are
  // ready. We swap content via ``setContent`` rather than recreating
  // the editor so the toolbar stays mounted (which helps focus/IME).
  useEffect(() => {
    if (!editor || loadState !== "ready" || source === null) return;
    editor.commands.setContent(source.content || "", false);
    // Auto-focus the editor body once content is in. Place the caret
    // at the end so the user can immediately start typing without
    // first having to click into the panel. Wrapped in a microtask so
    // we don't fight Tiptap's own initial selection.
    queueMicrotask(() => editor.commands.focus("end"));
  }, [editor, loadState, source]);

  // Track dirty state by comparing the current Markdown serialisation
  // against the last-saved baseline. Cheap on every keystroke — Tiptap
  // already emits an event we hook into below.
  const [isDirty, setIsDirty] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const md = serialiseMarkdown(editor);
      setIsDirty(md !== savedMarkdown);
    };
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor, savedMarkdown]);

  const handleSave = useCallback(async () => {
    if (!editor || !source || saving) return;
    const newContent = serialiseMarkdown(editor);
    if (newContent === savedMarkdown) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await filesApi.updateSource(
        source.rendered_file_id,
        newContent
      );
      setSource(updated);
      setSavedMarkdown(updated.content);
      setIsDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(extractError(err));
    } finally {
      setSaving(false);
    }
  }, [editor, source, savedMarkdown, saving]);

  const handleDiscard = useCallback(() => {
    if (!editor || !source) return;
    if (isDirty) {
      const ok = window.confirm(
        "Discard your unsaved changes?"
      );
      if (!ok) return;
    }
    editor.commands.setContent(savedMarkdown, false);
    setIsDirty(false);
  }, [editor, source, isDirty, savedMarkdown]);

  const requestClose = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm(
        "You have unsaved changes. Close anyway?"
      );
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose]);

  // Save on Ctrl/Cmd+S, close on Esc, trap Tab inside the panel.
  // The trap uses the dialog's own focusable list so users cycling
  // with Tab can't accidentally land on a chat-window button while
  // a "modal" panel is open. Shift+Tab wraps backwards.
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        // Reasonable subset — covers our buttons, the select, and the
        // contenteditable editor body. Disabled controls are excluded.
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Only intercept when the focus is currently inside the panel —
      // otherwise let the browser do its normal thing (e.g. the user
      // tabbed in from the page chrome the first time).
      if (active && !panelRef.current.contains(active)) return;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, requestClose]);

  // ``savedAt`` flashes a transient "Saved" pill in the footer.
  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 2400);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close editor"
        onClick={requestClose}
        className="flex-1 cursor-default bg-black/40 backdrop-blur-[1px]"
      />
      <aside
        ref={panelRef}
        className={cn(
          "flex h-full w-full max-w-[36rem] flex-col",
          "border-l border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        )}
      >
        <Header
          attachment={attachment}
          source={source}
          isDirty={isDirty}
          onClose={requestClose}
        />

        {loadState === "loading" && (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading source…
          </div>
        )}

        {loadState === "missing" && (
          <MissingSourceNotice onClose={requestClose} />
        )}

        {loadState === "error" && (
          <ErrorNotice
            message={loadError ?? "Couldn't load the editable source."}
            onRetry={() => {
              setLoadState("loading");
            }}
          />
        )}

        {loadState === "ready" && editor && (
          <>
            <Toolbar editor={editor} />
            <div className="flex-1 overflow-y-auto bg-[var(--surface)]">
              <EditorContent editor={editor} />
            </div>
            <Footer
              isDirty={isDirty}
              saving={saving}
              saveError={saveError}
              savedRecently={savedAt !== null}
              onSave={() => void handleSave()}
              onDiscard={handleDiscard}
            />
          </>
        )}
      </aside>
    </div>
  );
}

// --------------------------------------------------------------------
// Read-only preview panel (Phase B3)
// --------------------------------------------------------------------

/**
 * Side-panel mode for PDFs we can't edit (user uploads, generated
 * PDFs whose Markdown source is gone). Fetches the bytes through the
 * authenticated client so private-storage rules apply, hands them to
 * an ``<iframe>`` via an object URL, and exposes a download button in
 * the header. Esc closes; the backdrop is click-to-close like the
 * editor variant. We deliberately *don't* try to make this
 * interactive — that's what the Markdown editor is for. Anything more
 * (form filling, page deletion, text edit on a baked PDF) is a much
 * bigger lift and not what users are asking for here.
 */
function PdfPreviewPanelInner({
  attachment,
  onClose,
}: InnerProps) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  // Some Chromium-based browsers (notably Vivaldi with its built-in
  // shield, and Chrome with PDF viewer disabled) silently refuse to
  // render PDFs inside an embedded ``<object>`` / ``<iframe>`` that
  // points at a blob: URL. There's no reliable error event for this
  // case, so we wait a short grace period after the blob is ready
  // and, if the embed didn't make it to its own ``onLoad``, swap to
  // the "open in new tab" fallback. The user always has the inline
  // download / open buttons in the header regardless.
  const [embedFailed, setEmbedFailed] = useState(false);
  const embedLoadedRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);

  // Fetch the PDF as a blob. We can't put the file id directly into
  // an embed's src — the API requires a bearer token, and embeds
  // don't carry our axios interceptor. Object URLs sidestep that
  // entirely and stay scoped to the tab.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoadState("loading");
    setLoadError(null);
    setBlobUrl(null);
    setEmbedFailed(false);
    embedLoadedRef.current = false;
    void (async () => {
      try {
        const path = filesApi.downloadUrl(attachment.id).replace(/^\/api/, "");
        const res = await apiClient.get<Blob>(path, { responseType: "blob" });
        if (cancelled) return;
        // Force the application/pdf type on the blob — some servers
        // round-trip ``application/octet-stream`` for binary
        // downloads, which kills the inline-PDF rendering hint in
        // Chrome.
        const typed =
          res.data.type === "application/pdf"
            ? res.data
            : res.data.slice(0, res.data.size, "application/pdf");
        createdUrl = window.URL.createObjectURL(typed);
        setBlobUrl(createdUrl);
        setLoadState("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadError(extractError(err));
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) window.URL.revokeObjectURL(createdUrl);
    };
  }, [attachment.id]);

  // Embed-blocked detector. Once the blob is ready, give the browser
  // a generous window to render the PDF viewer inside our object.
  // If onLoad never fires, we assume something blocked it and show
  // the fallback. 1.5s is well above the time it takes Chromium to
  // hand the blob to its PDF viewer when the viewer is allowed.
  useEffect(() => {
    if (loadState !== "ready" || !blobUrl) return;
    const timer = window.setTimeout(() => {
      if (!embedLoadedRef.current) setEmbedFailed(true);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [loadState, blobUrl]);

  const openInNewTab = useCallback(() => {
    if (!blobUrl) return;
    window.open(blobUrl, "_blank", "noopener,noreferrer");
  }, [blobUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="flex-1 cursor-default bg-black/40 backdrop-blur-[1px]"
      />
      <aside
        ref={panelRef}
        className={cn(
          "flex h-full w-full max-w-[36rem] flex-col",
          "border-l border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        )}
      >
        <PreviewHeader
          attachment={attachment}
          blobUrl={blobUrl}
          onOpenInNewTab={openInNewTab}
          onClose={onClose}
        />
        {loadState === "loading" && (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading preview…
          </div>
        )}
        {loadState === "error" && (
          <ErrorNotice
            message={loadError ?? "Couldn't load the PDF."}
            onRetry={() => setLoadState("loading")}
          />
        )}
        {loadState === "ready" && blobUrl && !embedFailed && (
          <div className="flex-1 overflow-hidden bg-[var(--surface)]">
            <object
              data={blobUrl}
              type="application/pdf"
              className="h-full w-full"
              aria-label={attachment.filename}
              onLoad={() => {
                embedLoadedRef.current = true;
              }}
            >
              <EmbedFallback
                filename={attachment.filename}
                onOpenInNewTab={openInNewTab}
                fileId={attachment.id}
              />
            </object>
          </div>
        )}
        {loadState === "ready" && blobUrl && embedFailed && (
          <EmbedFallback
            filename={attachment.filename}
            onOpenInNewTab={openInNewTab}
            fileId={attachment.id}
          />
        )}
      </aside>
    </div>
  );
}

function PreviewHeader({
  attachment,
  blobUrl,
  onOpenInNewTab,
  onClose,
}: {
  attachment: MessageAttachmentSnapshot;
  blobUrl: string | null;
  onOpenInNewTab: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]",
        "px-4 py-3"
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          "bg-[var(--accent)]/15 text-[var(--accent)]"
        )}
      >
        <FileText className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--text)]">
          {attachment.filename}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          PDF · read-only preview · {humanSize(attachment.size_bytes)}
        </div>
      </div>
      <button
        type="button"
        disabled={!blobUrl}
        onClick={onOpenInNewTab}
        title="Open in a new tab"
        aria-label="Open in a new tab"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs",
          "border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] transition",
          "hover:border-[var(--accent)]/60 hover:text-[var(--text)]",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        <span className="font-medium">Open</span>
      </button>
      <DownloadButton
        fileId={attachment.id}
        filename={attachment.filename}
        label="PDF"
      />
      <button
        type="button"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close preview"
        className={cn(
          "ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md",
          "text-[var(--text-muted)] transition",
          "hover:bg-black/[0.06] hover:text-[var(--text)]",
          "dark:hover:bg-white/[0.08]"
        )}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * Visible inside the ``<object>`` (rendered by browsers that can't
 * embed the PDF) and as a stand-alone panel when our own watchdog
 * times out. Browser PDF blockers vary wildly — Vivaldi's shield,
 * stripped-down Chromium builds, mobile Safari without a viewer
 * extension — so the consistent answer is "always offer a way out".
 */
function EmbedFallback({
  filename,
  onOpenInNewTab,
  fileId,
}: {
  filename: string;
  onOpenInNewTab: () => void;
  fileId: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center">
      <FileText className="h-10 w-10 text-[var(--text-muted)]" />
      <div className="text-sm font-semibold text-[var(--text)]">
        Inline preview unavailable
      </div>
      <div className="max-w-sm text-xs text-[var(--text-muted)]">
        Your browser blocked the embedded PDF viewer (this often happens
        in Vivaldi, Brave, or Chromium with the PDF viewer disabled).
        Open the file in a new tab or download it instead.
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenInNewTab}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white",
            "bg-[var(--accent)] hover:opacity-90"
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open in new tab
        </button>
        <DownloadButton fileId={fileId} filename={filename} label="Download" />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Editor header / chrome (Phase A3)
// --------------------------------------------------------------------

function Header({
  attachment,
  source,
  isDirty,
  onClose,
}: {
  attachment: MessageAttachmentSnapshot;
  source: FileSourceContent | null;
  isDirty: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]",
        "px-4 py-3"
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          "bg-[var(--accent)]/15 text-[var(--accent)]"
        )}
      >
        <FileText className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--text)]">
            {attachment.filename}
          </span>
          {isDirty && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              )}
              title="Unsaved changes"
            >
              Unsaved
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          {source ? (
            <>
              Source: {source.source_filename} ·{" "}
              {humanSize(source.source_size_bytes)}
            </>
          ) : (
            "Markdown source"
          )}
        </div>
      </div>
      {source && (
        <DownloadButton
          fileId={source.rendered_file_id}
          filename={source.rendered_filename}
          label="PDF"
        />
      )}
      {source && (
        <DownloadButton
          fileId={source.source_file_id}
          filename={source.source_filename}
          label="MD"
        />
      )}
      <button
        type="button"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close editor"
        className={cn(
          "ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md",
          "text-[var(--text-muted)] transition",
          "hover:bg-black/[0.06] hover:text-[var(--text)]",
          "dark:hover:bg-white/[0.08]"
        )}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

function DownloadButton({
  fileId,
  filename,
  label,
}: {
  fileId: string;
  filename: string;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadFile(fileId, filename);
        } finally {
          setBusy(false);
        }
      }}
      title={`Download ${filename}`}
      aria-label={`Download ${filename}`}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs",
        "border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] transition",
        "hover:border-[var(--accent)]/60 hover:text-[var(--text)]",
        "disabled:cursor-not-allowed disabled:opacity-50"
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span className="font-medium">{label}</span>
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const btn = (
    active: boolean,
    title: string,
    onClick: () => void,
    icon: React.ReactNode,
    disabled = false
  ) => (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md text-sm transition",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-[var(--accent)]/15 text-[var(--accent)]"
          : "text-[var(--text-muted)] hover:bg-black/[0.05] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
      )}
    >
      {icon}
    </button>
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 border-b border-[var(--border)]",
        "bg-[var(--surface)] px-2 py-1.5"
      )}
    >
      {btn(
        false,
        "Undo (Ctrl+Z)",
        () => editor.chain().focus().undo().run(),
        <Undo2 className="h-4 w-4" />,
        !editor.can().undo()
      )}
      {btn(
        false,
        "Redo (Ctrl+Shift+Z)",
        () => editor.chain().focus().redo().run(),
        <Redo2 className="h-4 w-4" />,
        !editor.can().redo()
      )}
      <Divider />
      <select
        value={
          editor.isActive("heading", { level: 1 })
            ? "h1"
            : editor.isActive("heading", { level: 2 })
              ? "h2"
              : editor.isActive("heading", { level: 3 })
                ? "h3"
                : editor.isActive("heading", { level: 4 })
                  ? "h4"
                  : "p"
        }
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          if (v === "p") chain.setParagraph().run();
          else
            chain
              .toggleHeading({
                level: Number(v.slice(1)) as 1 | 2 | 3 | 4,
              })
              .run();
        }}
        className={cn(
          "h-8 rounded-md border bg-[var(--bg)] px-1.5 text-xs",
          "border-[var(--border)] text-[var(--text-muted)]",
          "hover:text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/40"
        )}
        aria-label="Block format"
      >
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
      </select>
      <Divider />
      {btn(
        editor.isActive("bold"),
        "Bold (Ctrl+B)",
        () => editor.chain().focus().toggleBold().run(),
        <Bold className="h-4 w-4" />
      )}
      {btn(
        editor.isActive("italic"),
        "Italic (Ctrl+I)",
        () => editor.chain().focus().toggleItalic().run(),
        <Italic className="h-4 w-4" />
      )}
      {btn(
        editor.isActive("strike"),
        "Strikethrough",
        () => editor.chain().focus().toggleStrike().run(),
        <Strikethrough className="h-4 w-4" />
      )}
      {btn(
        editor.isActive("code"),
        "Inline code",
        () => editor.chain().focus().toggleCode().run(),
        <Code className="h-4 w-4" />
      )}
      <Divider />
      {btn(
        editor.isActive("bulletList"),
        "Bulleted list",
        () => editor.chain().focus().toggleBulletList().run(),
        <List className="h-4 w-4" />
      )}
      {btn(
        editor.isActive("orderedList"),
        "Numbered list",
        () => editor.chain().focus().toggleOrderedList().run(),
        <ListOrdered className="h-4 w-4" />
      )}
      {btn(
        editor.isActive("blockquote"),
        "Blockquote",
        () => editor.chain().focus().toggleBlockquote().run(),
        <Quote className="h-4 w-4" />
      )}
      {btn(
        editor.isActive("codeBlock"),
        "Code block",
        () => editor.chain().focus().toggleCodeBlock().run(),
        <span className="font-mono text-xs">{"</>"}</span>
      )}
    </div>
  );
}

function Divider() {
  return (
    <span
      className="mx-1 inline-block h-5 w-px bg-[var(--border)]"
      aria-hidden
    />
  );
}

function Footer({
  isDirty,
  saving,
  saveError,
  savedRecently,
  onSave,
  onDiscard,
}: {
  isDirty: boolean;
  saving: boolean;
  saveError: string | null;
  savedRecently: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)]",
        "px-3 py-2"
      )}
    >
      {saveError ? (
        <span
          className={cn(
            "inline-flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs",
            "bg-red-500/10 text-red-600 dark:text-red-400"
          )}
          role="alert"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={saveError}>
            {saveError}
          </span>
        </span>
      ) : savedRecently ? (
        <span
          className={cn(
            "inline-flex flex-1 items-center gap-1.5 text-xs",
            "text-[var(--text-muted)]"
          )}
        >
          <Save className="h-3 w-3" />
          Saved · PDF re-rendered
        </span>
      ) : (
        <span className="flex-1 truncate text-xs text-[var(--text-muted)]">
          Ctrl+S to save · Esc to close
        </span>
      )}
      <button
        type="button"
        onClick={onDiscard}
        disabled={!isDirty || saving}
        className={cn(
          "rounded-md px-2.5 py-1 text-xs",
          "text-[var(--text-muted)] hover:bg-black/[0.05] hover:text-[var(--text)]",
          "dark:hover:bg-white/[0.06]",
          "disabled:cursor-not-allowed disabled:opacity-40"
        )}
      >
        Discard
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!isDirty || saving}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold text-white",
          "bg-[var(--accent)] transition hover:opacity-90",
          "disabled:cursor-not-allowed disabled:opacity-40"
        )}
      >
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="h-3.5 w-3.5" />
        )}
        {saving ? "Saving…" : "Save & re-render"}
      </button>
    </div>
  );
}

function MissingSourceNotice({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500" />
      <div className="text-sm font-semibold text-[var(--text)]">
        This file isn't editable
      </div>
      <div className="max-w-sm text-xs text-[var(--text-muted)]">
        It either wasn't generated from an editable source, or the
        source has since been deleted. You can still download the
        rendered file.
      </div>
      <button
        type="button"
        onClick={onClose}
        className={cn(
          "mt-2 inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold text-white",
          "bg-[var(--accent)] hover:opacity-90"
        )}
      >
        Close
      </button>
    </div>
  );
}

function ErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle className="h-8 w-8 text-red-500" />
      <div className="text-sm font-semibold text-[var(--text)]">
        Couldn't load the source
      </div>
      <div className="max-w-sm text-xs text-[var(--text-muted)]">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "mt-2 inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-semibold",
          "border-[var(--border)] hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
        )}
      >
        Try again
      </button>
    </div>
  );
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

/** Tiptap-markdown attaches a `storage.markdown.getMarkdown()` helper
 *  on the editor. Strongly typed here so the call sites don't need to
 *  reach into Tiptap's `any`-flavoured storage record. */
function serialiseMarkdown(editor: Editor): string {
  const storage = editor.storage as {
    markdown?: { getMarkdown?: () => string };
  };
  const md = storage.markdown?.getMarkdown?.();
  if (typeof md === "string") return md;
  // Should never happen — the Markdown extension is loaded
  // synchronously above. Defensive fallback to the raw text.
  return editor.getText();
}

async function downloadFile(id: string, filename: string): Promise<void> {
  try {
    const path = filesApi.downloadUrl(id).replace(/^\/api/, "");
    const res = await apiClient.get<Blob>(path, { responseType: "blob" });
    const url = window.URL.createObjectURL(res.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  } catch {
    // Best-effort — the panel stays open so the user can retry.
  }
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
