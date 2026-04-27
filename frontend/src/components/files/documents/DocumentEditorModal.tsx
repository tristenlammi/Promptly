import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";

import { filesApi, type FileItem } from "@/api/files";
import { documentsApi } from "@/api/documents";
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
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-2 py-1 text-sm font-semibold outline-none focus:bg-black/5 dark:focus:bg-white/5"
          aria-label="Document title"
        />

        <SaveIndicator status={saveStatus} error={error} />

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
          disabled={!editor || Boolean(error)}
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
}: {
  status: SaveStatus;
  error: string | null;
}) {
  if (error) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-500">
        <AlertTriangle className="h-3.5 w-3.5" /> Error
      </span>
    );
  }

  const styles =
    status === "offline"
      ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-300"
      : status === "syncing"
        ? "text-[var(--muted)]"
        : status === "saved"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-[var(--muted)]";
  return (
    <span
      className={cn(
        "hidden items-center gap-1 rounded-md px-2 py-1 text-xs sm:inline-flex",
        styles
      )}
      aria-live="polite"
    >
      {status === "syncing" || status === "idle" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : status === "saved" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      {status === "offline"
        ? "Offline"
        : status === "syncing"
          ? "Syncing…"
          : status === "saved"
            ? "All changes saved"
            : "Ready"}
    </span>
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
