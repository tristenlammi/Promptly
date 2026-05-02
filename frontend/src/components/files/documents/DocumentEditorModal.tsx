import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FileCode,
  FileDown,
  FileText,
  Loader2,
  Save,
  X,
} from "lucide-react";

import { filesApi, type FileItem } from "@/api/files";
import { documentsApi, type DocumentDownloadFormat } from "@/api/documents";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/utils/cn";

import { buildExtensions } from "./extensions";
import { DocumentToolbar } from "./DocumentToolbar";
import { useCollabProvider } from "./useCollabProvider";

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
}

type SaveStatus = "idle" | "dirty" | "syncing" | "saved" | "offline";

export function DocumentEditorModal({
  file,
  onClose,
  onFileUpdated,
}: DocumentEditorModalProps) {
  const queryClient = useQueryClient();
  const { ydoc, provider, status: collabStatus, user, error } =
    useCollabProvider(file.id);

  const [filename, setFilename] = useState(file.filename);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
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
  const canEdit = !sharedWithMe || (file.sharing?.can_edit ?? false);

  // "Saved" ticks back to "idle" on a short timer — pure UX
  // cosmetics so the user sees the confirmation breath before it
  // fades.
  const savedTimerRef = useRef<number | null>(null);

  const extensions = useMemo(
    () =>
      buildExtensions({
        ydoc,
        provider,
        user,
        placeholder: "Start typing, or hit / for commands…",
      }),
    [ydoc, provider, user]
  );

  // ``editor`` from useEditor is the source of truth, but the
  // ProseMirror handlers we register on ``editorProps`` run from a
  // closure that's captured BEFORE useEditor returns. We bounce
  // through a ref so paste / drop handlers can still access the
  // live editor at call time without re-creating it on every render.
  const editorRef = useRef<Editor | null>(null);

  // Track outstanding pasted/dropped uploads so the SaveIndicator
  // can show "Uploading…" without each paste needing its own toast.
  const [pasteUploading, setPasteUploading] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

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
        const msg = e instanceof Error ? e.message : "Image upload failed";
        setPasteError(msg);
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
      autofocus: "end",
      // Read-only grantees can't type; TipTap honours this by
      // disabling input + visually muting toolbar buttons through
      // the ``editor.isEditable`` getter the toolbar reads. The
      // collab token is *also* minted as ``perm=read`` for them so
      // even a hand-modified client can't smuggle writes through.
      editable: canEdit,
      editorProps: {
        attributes: {
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
  // Offline fallback — seed the editor from the saved HTML blob
  // ------------------------------------------------------------------
  // When the collab WebSocket fails (typical prod symptom: a
  // Cloudflare tunnel that hasn't been told to upgrade WS, a stopped
  // collab container, or an aggressively-buffering reverse proxy)
  // the Y.Doc never receives the previously-saved state. The editor
  // stays empty, the user can't see what they wrote earlier, and a
  // manual Save would clobber the on-disk blob with the empty
  // editor content.
  //
  // To make the offline path actually usable we fetch the HTML blob
  // a couple of seconds after we determine the WS isn't coming up
  // and apply it via ``editor.commands.setContent``. y-prosemirror
  // mirrors that into the local Y.Doc, so subsequent edits + manual
  // saves persist correctly. Guards:
  //
  //   * Only seed once per modal lifetime (``seededRef``) so we
  //     can't fight a slow-but-eventually-successful WS.
  //   * Only seed when the editor is empty — if the WS DID briefly
  //     deliver content before going down, we leave that alone.
  //   * Soft-fail on fetch errors. The user can still type from
  //     scratch; the manual save endpoint doesn't depend on this.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!editor) return;
    if (collabStatus === "connected") return;
    // Fire once we hit a *terminal* disconnect — "connecting" is
    // the WS's normal state during the first handshake, so a 2s
    // timer there would seed too eagerly. Hocuspocus reports
    // "disconnected" after each failed connect attempt, which is
    // the cue we want.
    if (collabStatus !== "disconnected") return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled || seededRef.current) return;
      try {
        const { blob } = await documentsApi.download(file.id, "html");
        const html = (await blob.text()).trim();
        if (cancelled || seededRef.current) return;
        // Editor may have raced ahead with user keystrokes by now;
        // never overwrite local edits.
        if (!editor.isEmpty) return;
        if (!html) return;
        // ``setContent(..., false)`` doesn't emit a transaction-meta
        // ``addToHistory`` flag, which keeps the seed out of the
        // user-visible undo stack — backspace shouldn't undo "open
        // the document".
        editor.commands.setContent(html, false);
        seededRef.current = true;
      } catch (err) {
        // Soft-fail; an empty editor is still usable.
        console.warn("[doc] offline seed failed", err);
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [collabStatus, editor, file.id]);

  // Collab-status → save-indicator mapping.
  useEffect(() => {
    if (collabStatus === "disconnected") {
      setSaveStatus("offline");
    } else if (collabStatus === "connecting") {
      setSaveStatus("syncing");
    } else {
      setSaveStatus("saved");
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => {
        setSaveStatus("idle");
      }, 1800);
    }
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, [collabStatus]);

  // Listen to the Y.Doc for local changes so we can flip
  // "saved" → "syncing" while Hocuspocus batches the update and
  // "syncing" → "saved" once the server debounce fires. The
  // debounce is server-side only, so here we just watch for a
  // short quiet period after each change.
  useEffect(() => {
    if (!ydoc) return;
    let settleTimer: number | null = null;
    const onUpdate = () => {
      setSaveStatus("syncing");
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        setSaveStatus("saved");
      }, 3500);
    };
    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
      if (settleTimer) window.clearTimeout(settleTimer);
    };
  }, [ydoc]);

  // Body scroll lock while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape closes the modal (matching the preview modal's UX).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".ProseMirror-menubar")) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Collaborator awareness — the CollaborationCursor extension
  // publishes each client's user object into the provider's
  // awareness state. We subscribe here to render little avatars.
  const [collaborators, setCollaborators] = useState<
    { clientId: number; name: string; color: string }[]
  >([]);
  useEffect(() => {
    if (!provider) return;
    const awareness = provider.awareness;
    if (!awareness) return;
    const update = () => {
      const states = Array.from(awareness.getStates().entries()) as [
        number,
        { user?: { name?: string; color?: string } }
      ][];
      const list = states
        .filter(([id]) => id !== awareness.clientID)
        .map(([id, state]) => ({
          clientId: id,
          name: state.user?.name ?? "Anonymous",
          color: state.user?.color ?? "#D97757",
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
    const next = filename.trim();
    if (!next || next === file.filename) {
      setFilename(file.filename);
      return;
    }
    setRenameError(null);
    try {
      const updated = await filesApi.renameFile(file.id, next);
      onFileUpdated?.(updated);
      // Keep Drive listings in sync.
      await queryClient.invalidateQueries({ queryKey: ["drive"] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Rename failed";
      setRenameError(msg);
      setFilename(file.filename);
    }
  }, [filename, file.filename, file.id, onFileUpdated, queryClient]);

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
      const updated = await documentsApi.manualSave(file.id, html);
      onFileUpdated?.(updated);
      await queryClient.invalidateQueries({ queryKey: ["drive"] });
      // The timestamp drives a *durable* "Saved Xs ago" chip even
      // when the collab WS is down. Without it, the SaveIndicator
      // would re-render straight back to "Offline — Save manually"
      // and the user would reasonably think the click did nothing.
      setLastSavedAt(new Date());
      // Flash the green tick briefly too so the click feels
      // responsive — the relative-time chip takes over once the
      // tick fades.
      setSaveStatus("saved");
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => {
        setSaveStatus("idle");
      }, 1800);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      setManualSaveError(msg);
      window.setTimeout(() => setManualSaveError(null), 5000);
    } finally {
      setManualSaving(false);
    }
  }, [canEdit, file.id, manualSaving, onFileUpdated, queryClient]);

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
        const msg = e instanceof Error ? e.message : "Download failed";
        setDownloadError(msg);
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
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  const content = (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm",
        // On md+ screens we inset the card so the backdrop is
        // visible on all four sides — reinforces the "this is a
        // modal" affordance. On mobile we keep it edge-to-edge so
        // we don't waste precious viewport to chrome.
        "md:p-6"
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-editor-title"
      onMouseDown={handleBackdropClick}
    >
      {/* Card */}
      <div
        className={cn(
          "flex flex-1 flex-col overflow-hidden bg-[var(--bg)]",
          // Rounded corners + shadow kick in on tablet+ where the
          // backdrop inset is visible. On phones the card fills
          // the viewport so the extra chrome would just eat space.
          "md:mx-auto md:w-full md:max-w-6xl md:rounded-2xl md:border md:border-[var(--border)] md:shadow-2xl"
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
      {/* Header */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2",
          // Respect the notch on both sides + top of the sheet so
          // the close button never ends up under the status bar on
          // iOS PWA installs.
          "pl-[max(env(safe-area-inset-left,0),0.75rem)]",
          "pr-[max(env(safe-area-inset-right,0),0.75rem)]",
          "pt-[max(env(safe-area-inset-top,0),0.5rem)] md:px-4",
          // Round the top corners to match the card radius.
          "md:rounded-t-2xl md:pt-2"
        )}
      >
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
          readOnly={sharedWithMe}
          className={cn(
            "min-w-0 flex-1 truncate rounded-md bg-transparent px-2 py-1 text-sm font-semibold outline-none",
            sharedWithMe
              ? "cursor-default"
              : "focus:bg-black/5 dark:focus:bg-white/5"
          )}
          aria-label="Document title"
        />

        <SaveIndicator
          status={saveStatus}
          error={error}
          collabOffline={collabStatus === "disconnected"}
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
                icon={<FileCode className="h-4 w-4" />}
                label="HTML (.html)"
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
            </div>
          )}
        </div>

        <Collaborators avatars={collaborators} self={user} />

        <button
          type="button"
          onClick={onClose}
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
      {collabStatus === "disconnected" && !error && (
        <div className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <strong className="font-semibold">Live sync offline.</strong>{" "}
            Loaded the last saved version. Autosave is paused —
            press{" "}
            <kbd className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px]">
              ⌘/Ctrl
            </kbd>{" "}
            +{" "}
            <kbd className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px]">
              S
            </kbd>{" "}
            (or the Save button) to persist your changes.
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="relative">
        <DocumentToolbar
          editor={editor}
          documentId={file.id}
          // Only disable on hard collab errors. y-prosemirror queues
          // local edits while the websocket is reconnecting, so there's
          // no reason to freeze the toolbar during a transient
          // "connecting" state — doing so makes the editor feel broken
          // on every cold open.
          disabled={!editor || Boolean(error) || !canEdit}
        />
      </div>

      {/* Editor area */}
      <div
        className={cn(
          "flex-1 overflow-y-auto",
          // Horizontal + bottom safe-areas so content doesn't hide
          // behind the iOS home indicator / rounded corners.
          "pl-[env(safe-area-inset-left,0)]",
          "pr-[env(safe-area-inset-right,0)]",
          "pb-[max(env(safe-area-inset-bottom,0),1.5rem)]"
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
          <div className="mx-auto max-w-3xl px-0 md:px-4">
            <EditorContent editor={editor} />
          </div>
        )}
      </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

function SaveIndicator({
  status,
  error,
  collabOffline,
  lastSavedAt,
}: {
  status: SaveStatus;
  error: string | null;
  collabOffline: boolean;
  /** Wall-clock timestamp of the last successful manual save, or
   *  ``null`` if the user hasn't manually saved this session.
   *  Drives the persistent "Saved Xs ago" chip so a click on the
   *  Save button has visible feedback even when the collab WS is
   *  offline (which would otherwise pin the indicator to
   *  "Offline — Save manually" forever). */
  lastSavedAt: Date | null;
}) {
  if (error) {
    return (
      <span
        title={error}
        className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500"
      >
        <AlertTriangle className="h-3.5 w-3.5" /> Error
      </span>
    );
  }

  // The freshly-saved tick + the persistent "Saved Xs ago" chip
  // both override the offline-collab signal — pressing Save needs
  // visible feedback regardless of whether the WS is healthy. Only
  // when neither is active do we fall back to the offline chip /
  // raw status.
  const showFreshTick = status === "saved";
  const effective: SaveStatus =
    showFreshTick || lastSavedAt
      ? "saved"
      : collabOffline
        ? "offline"
        : status;

  const styles =
    effective === "offline"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : effective === "syncing"
        ? "text-[var(--muted)]"
        : effective === "saved"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-[var(--muted)]";

  // Pick the visible label.
  let label: string;
  if (effective === "offline") {
    label = "Offline — Save manually";
  } else if (effective === "syncing") {
    label = "Syncing…";
  } else if (effective === "saved") {
    label = showFreshTick
      ? "All changes saved"
      : `Saved ${formatRelative(lastSavedAt!)}`;
  } else {
    label = "Ready";
  }

  return (
    <span
      className={cn(
        "hidden items-center gap-1 rounded-md px-2 py-1 text-xs sm:inline-flex",
        styles
      )}
      aria-live="polite"
      title={
        effective === "offline"
          ? "Live collaboration offline — autosave paused. Use the Save button."
          : effective === "saved" && lastSavedAt
            ? `Last saved at ${lastSavedAt.toLocaleTimeString()}`
            : undefined
      }
    >
      {effective === "syncing" || effective === "idle" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : effective === "saved" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      {label}
    </span>
  );
}

/** Loose relative-time formatter for the "Saved Xs ago" chip.
 *  Caps at 24h — past that we'd rather render the absolute time so
 *  a stale tab doesn't quietly read "Saved 17h ago" forever. */
function formatRelative(when: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - when.getTime()) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `at ${when.toLocaleTimeString()}`;
}

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
  avatars: { clientId: number; name: string; color: string }[];
  self: { name: string; color: string } | null;
}) {
  if (!self && avatars.length === 0) return null;
  const all = self
    ? [
        ...avatars,
        { clientId: -1, name: `${self.name} (you)`, color: self.color },
      ]
    : avatars;
  return (
    <div className="hidden items-center -space-x-2 sm:flex">
      {all.slice(0, 4).map((a) => (
        <span
          key={a.clientId}
          title={a.name}
          style={{ backgroundColor: a.color }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--surface)] text-[11px] font-semibold text-white"
        >
          {a.name.charAt(0).toUpperCase()}
        </span>
      ))}
      {all.length > 4 && (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--surface)] bg-neutral-500 text-[10px] font-semibold text-white">
          +{all.length - 4}
        </span>
      )}
    </div>
  );
}
