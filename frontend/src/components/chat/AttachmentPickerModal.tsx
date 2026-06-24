import { useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  ChevronRight,
  File as FileIcon,
  FileText,
  Folder as FolderIcon,
  Home,
  Image as ImageIcon,
  Loader2,
  Upload,
} from "lucide-react";

import type { FileItem, FileScope, FolderItem } from "@/api/files";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useBrowseFiles, useUploadFile } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

/** A file already resolved and ready to send. */
export interface AttachedFile {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onAttach: (files: AttachedFile[]) => void;
  alreadyAttached: AttachedFile[];
}

type Tab = "pick" | "upload";
type MobileView = "home" | "browse";

/** Max files attachable to a single message. Enough for a real batch
 *  (a folder of screenshots, a set of docs) without letting someone
 *  dump hundreds into one turn. */
const MAX_ATTACHMENTS = 10;

export function AttachmentPickerModal({
  open,
  onClose,
  onAttach,
  alreadyAttached,
}: Props) {
  const isMobile = useIsMobile();
  // Desktop: default to the upload flow — users almost always arrive
  // here wanting to attach a fresh file, and the previous "From Files"
  // default was an extra click for the common case.
  const [tab, setTab] = useState<Tab>(isMobile ? "pick" : "upload");
  const [mobileView, setMobileView] = useState<MobileView>("home");
  const [selected, setSelected] = useState<Record<string, AttachedFile>>({});

  const reset = () => {
    setTab(isMobile ? "pick" : "upload");
    setMobileView("home");
    setSelected({});
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleAttach = () => {
    const toAttach = Object.values(selected);
    if (toAttach.length === 0) return;
    onAttach(toAttach);
    reset();
  };

  // Camera capture is a one-shot action — there's nothing to multi-select
  // after snapping a photo, so attach it (alongside anything already
  // picked) and close immediately instead of making the user hunt for the
  // "Attach" button. ``onAttach`` closes the picker via its caller.
  const handleCaptureAttach = (f: FileItem) => {
    const captured: AttachedFile = {
      id: f.id,
      filename: f.filename,
      mime_type: f.mime_type,
      size_bytes: f.size_bytes,
    };
    onAttach([...Object.values(selected), captured]);
    reset();
  };

  const onUploaded = (f: FileItem) => {
    setSelected((prev) => {
      // Respect the per-message cap — an upload past the limit still
      // lands in Drive (not lost), it just isn't auto-attached here.
      if (
        !prev[f.id] &&
        alreadyAttached.length + Object.keys(prev).length >= MAX_ATTACHMENTS
      ) {
        return prev;
      }
      return {
        ...prev,
        [f.id]: {
          id: f.id,
          filename: f.filename,
          mime_type: f.mime_type,
          size_bytes: f.size_bytes,
        },
      };
    });
    // Desktop: flip back to the pick tab so the new upload sits
    // alongside anything already selected. Mobile: stay on the home
    // screen — the selection count in the footer is enough feedback.
    if (!isMobile) setTab("pick");
  };

  const alreadyAttachedIds = new Set(alreadyAttached.map((a) => a.id));
  // Slots left before the per-message cap; passed to the upload paths so
  // a multi-select stops at the limit instead of uploading files it can't
  // attach.
  const remainingSlots = Math.max(
    0,
    MAX_ATTACHMENTS - alreadyAttached.length - Object.keys(selected).length
  );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Attach files"
      widthClass="max-w-xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={handleAttach}
            disabled={Object.keys(selected).length === 0}
          >
            Attach ({Object.keys(selected).length})
          </Button>
        </>
      }
    >
      {isMobile ? (
        <MobileBody
          view={mobileView}
          onViewChange={setMobileView}
          onUploaded={onUploaded}
          onCaptureAttach={handleCaptureAttach}
          alreadyAttachedIds={alreadyAttachedIds}
          selected={selected}
          setSelected={setSelected}
          maxNew={remainingSlots}
        />
      ) : (
        <DesktopBody
          tab={tab}
          onTabChange={setTab}
          onUploaded={onUploaded}
          alreadyAttachedIds={alreadyAttachedIds}
          selected={selected}
          setSelected={setSelected}
          maxNew={remainingSlots}
        />
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------
// Desktop body — two-tab segmented control.
// --------------------------------------------------------------------
function DesktopBody({
  tab,
  onTabChange,
  onUploaded,
  alreadyAttachedIds,
  selected,
  setSelected,
  maxNew,
}: {
  tab: Tab;
  onTabChange: (t: Tab) => void;
  onUploaded: (f: FileItem) => void;
  alreadyAttachedIds: Set<string>;
  selected: Record<string, AttachedFile>;
  setSelected: React.Dispatch<React.SetStateAction<Record<string, AttachedFile>>>;
  maxNew: number;
}) {
  return (
    <>
      {/* Segmented tabs — parent radius is ``rounded-input`` (1.5rem
          pill) so the inner active pill uses ``rounded-full`` to match
          the outer shape cleanly. */}
      <div className="mb-3 flex items-center gap-1 rounded-input border border-[var(--border)] bg-[var(--bg)] p-1">
        <TabButton
          active={tab === "pick"}
          onClick={() => onTabChange("pick")}
          label="From Files"
        />
        <TabButton
          active={tab === "upload"}
          onClick={() => onTabChange("upload")}
          label="Upload new"
        />
      </div>

      {tab === "pick" ? (
        <PickFromFilesTab
          alreadyAttachedIds={alreadyAttachedIds}
          selected={selected}
          setSelected={setSelected}
        />
      ) : (
        <UploadTab onUploaded={onUploaded} maxNew={maxNew} />
      )}
    </>
  );
}

// --------------------------------------------------------------------
// Mobile body — share-sheet-style landing with Camera / Upload / Browse,
// flipping into the file browser on demand. No tab switcher so the UI
// stays thumb-friendly and focused.
// --------------------------------------------------------------------
function MobileBody({
  view,
  onViewChange,
  onUploaded,
  onCaptureAttach,
  alreadyAttachedIds,
  selected,
  setSelected,
  maxNew,
}: {
  view: MobileView;
  onViewChange: (v: MobileView) => void;
  onUploaded: (f: FileItem) => void;
  onCaptureAttach: (f: FileItem) => void;
  alreadyAttachedIds: Set<string>;
  selected: Record<string, AttachedFile>;
  setSelected: React.Dispatch<React.SetStateAction<Record<string, AttachedFile>>>;
  maxNew: number;
}) {
  if (view === "browse") {
    return (
      <div className="space-y-3">
        <button
          onClick={() => onViewChange("home")}
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <PickFromFilesTab
          alreadyAttachedIds={alreadyAttachedIds}
          selected={selected}
          setSelected={setSelected}
        />
      </div>
    );
  }

  return (
    <MobileHomeActions
      onUploaded={onUploaded}
      onCaptureAttach={onCaptureAttach}
      onBrowse={() => onViewChange("browse")}
      maxNew={maxNew}
    />
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        // ``rounded-full`` keeps the active pill's curvature in sync
        // with the outer ``rounded-input`` container so the highlight
        // doesn't look clipped at the edges.
        "inline-flex flex-1 items-center justify-center rounded-full px-3 py-1.5 text-sm transition",
        active
          ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
          : "text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {label}
    </button>
  );
}

// --------------------------------------------------------------------
// "From Files" tab — tiny embedded browser.
// --------------------------------------------------------------------
function PickFromFilesTab({
  alreadyAttachedIds,
  selected,
  setSelected,
}: {
  alreadyAttachedIds: Set<string>;
  selected: Record<string, AttachedFile>;
  setSelected: React.Dispatch<React.SetStateAction<Record<string, AttachedFile>>>;
}) {
  // Drive stage 5 — only owned files can be attached to chats. Files
  // shared with you via grants are deliberately excluded from this
  // picker because the chat snapshot would point at the owner's
  // blob; if they later revoke your grant, the attachment 404s.
  // Recipients with ``can_copy`` should use "Copy to my files" first
  // and then attach their own clone.
  const [folderId, setFolderId] = useState<string | null>(null);

  const toggle = (f: FileItem) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[f.id]) {
        delete next[f.id];
      } else {
        next[f.id] = {
          id: f.id,
          filename: f.filename,
          mime_type: f.mime_type,
          size_bytes: f.size_bytes,
        };
      }
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <EmbeddedBrowser
        scope="mine"
        folderId={folderId}
        onOpenFolder={setFolderId}
        alreadyAttachedIds={alreadyAttachedIds}
        selectedIds={new Set(Object.keys(selected))}
        onToggleFile={toggle}
      />
    </div>
  );
}

function EmbeddedBrowser({
  scope,
  folderId,
  onOpenFolder,
  alreadyAttachedIds,
  selectedIds,
  onToggleFile,
}: {
  scope: FileScope;
  folderId: string | null;
  onOpenFolder: (id: string | null) => void;
  alreadyAttachedIds: Set<string>;
  selectedIds: Set<string>;
  onToggleFile: (f: FileItem) => void;
}) {
  const { data, isLoading, isError } = useBrowseFiles(scope, folderId);

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--bg)]">
      {/* breadcrumbs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
        <button
          onClick={() => onOpenFolder(null)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        >
          <Home className="h-3 w-3" />
          <span className="font-medium">
            {scope === "mine" ? "Drive" : "Shared"}
          </span>
        </button>
        {(data?.breadcrumbs ?? []).map((c, i) => (
          <span key={c.id ?? `c-${i}`} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            {i === (data?.breadcrumbs.length ?? 0) - 1 ? (
              <span className="px-1.5 py-0.5 font-medium text-[var(--text)]">
                {c.name}
              </span>
            ) : (
              <button
                onClick={() => onOpenFolder(c.id)}
                className="rounded px-1.5 py-0.5 hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
              >
                {c.name}
              </button>
            )}
          </span>
        ))}
      </div>

      <div className="max-h-72 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...
          </div>
        )}
        {isError && (
          <div className="px-4 py-3 text-xs text-red-600 dark:text-red-400">
            Failed to load files.
          </div>
        )}
        {data && data.folders.length === 0 && data.files.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
            This folder is empty.
          </div>
        )}
        {data && (
          <ul className="divide-y divide-[var(--border)]">
            {data.folders.map((f) => (
              <FolderRowCompact
                key={f.id}
                folder={f}
                onOpen={() => onOpenFolder(f.id)}
              />
            ))}
            {data.files.map((f) => {
              const selected = selectedIds.has(f.id);
              const disabled = alreadyAttachedIds.has(f.id);
              return (
                <FileRowCompact
                  key={f.id}
                  file={f}
                  selected={selected}
                  disabled={disabled}
                  onToggle={() => !disabled && onToggleFile(f)}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function FolderRowCompact({
  folder,
  onOpen,
}: {
  folder: FolderItem;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-[var(--hover)]"
      >
        <FolderIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
        <span className="flex-1 truncate">{folder.name}</span>
        <ChevronRight className="h-3 w-3 text-[var(--text-muted)]" />
      </button>
    </li>
  );
}

function FileRowCompact({
  file,
  selected,
  disabled,
  onToggle,
}: {
  file: FileItem;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        onClick={onToggle}
        disabled={disabled}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "hover:bg-[var(--hover)]",
          selected && "bg-[var(--accent)]/10"
        )}
      >
        <input
          type="checkbox"
          checked={selected || disabled}
          readOnly
          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
        />
        <FileTypeIconCompact mime={file.mime_type} />
        <div className="min-w-0 flex-1">
          <div className="truncate">{file.filename}</div>
          <div className="text-[11px] text-[var(--text-muted)]">
            {humanSize(file.size_bytes)}
            {disabled ? " · already attached" : ""}
          </div>
        </div>
      </button>
    </li>
  );
}

function FileTypeIconCompact({ mime }: { mime: string }) {
  if (mime.startsWith("image/"))
    return <ImageIcon className="h-4 w-4 shrink-0 text-violet-500" />;
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  )
    return <FileText className="h-4 w-4 shrink-0 text-sky-500" />;
  return <FileIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />;
}

// --------------------------------------------------------------------
// Mobile home — three stacked share-sheet actions.
// --------------------------------------------------------------------
function MobileHomeActions({
  onUploaded,
  onCaptureAttach,
  onBrowse,
  maxNew,
}: {
  onUploaded: (f: FileItem) => void;
  onCaptureAttach: (f: FileItem) => void;
  onBrowse: () => void;
  maxNew: number;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const upload = useUploadFile();
  const [err, setErr] = useState<string | null>(null);

  // Shared upload routine; ``onDone`` decides what happens after each
  // file lands — gallery/file picks add to the multi-select, the camera
  // capture attaches-and-closes in one shot. Uploads up to ``cap`` files
  // sequentially so a multi-select of many photos/docs all attach.
  const uploadAll = async (
    e: React.ChangeEvent<HTMLInputElement>,
    onDone: (f: FileItem) => void,
    cap: number
  ) => {
    const picked = Array.from(e.target.files ?? []);
    // Reset so picking the same file twice in a row still fires change.
    e.target.value = "";
    if (picked.length === 0) return;
    setErr(null);
    const files = picked.slice(0, Math.max(0, cap));
    if (picked.length > files.length) {
      setErr(
        `You can attach up to ${MAX_ATTACHMENTS} files per message — the first ${files.length} were added.`
      );
    }
    for (const file of files) {
      try {
        const result = await upload.mutateAsync({
          scope: "mine",
          file,
          folderId: null,
          route: "chat",
        });
        onDone(result);
      } catch (err) {
        setErr(extractError(err));
      }
    }
  };

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) =>
    uploadAll(e, onUploaded, maxNew);
  // Camera capture is always a single shot → cap of 1.
  const handleCapture = (e: React.ChangeEvent<HTMLInputElement>) =>
    uploadAll(e, onCaptureAttach, 1);

  const busy = upload.isPending;

  return (
    <div className="space-y-2">
      <MobileActionRow
        icon={<Camera className="h-5 w-5" />}
        label="Take photo"
        hint="Use your camera"
        onClick={() => cameraRef.current?.click()}
        disabled={busy}
        busy={busy}
      />
      <MobileActionRow
        icon={<ImageIcon className="h-5 w-5" />}
        label="Choose from gallery"
        hint="Pick a photo from your device"
        onClick={() => galleryRef.current?.click()}
        disabled={busy}
      />
      <MobileActionRow
        icon={<Upload className="h-5 w-5" />}
        label="Upload from device"
        hint="Documents and other files up to 40 MB"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      />
      <MobileActionRow
        icon={<FolderIcon className="h-5 w-5" />}
        label="Choose from Files"
        hint="Browse files saved in your Drive"
        onClick={onBrowse}
        disabled={busy}
      />

      {/* ``capture="environment"`` hints to iOS / Android to open the
          rear camera directly; desktop browsers ignore it and fall
          back to a normal file picker (harmless — this component only
          renders on mobile viewports). */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleCapture}
      />
      {/* Gallery picker — ``accept="image/*"`` without ``capture`` tells
          iOS + Android to open the photo library directly (on Android
          this routes through Google Photos / the system photo picker
          instead of the generic Files/Drive chooser that appears with
          no filter). */}
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handlePick}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={handlePick}
      />

      {err && (
        <p className="pt-1 text-sm text-red-600 dark:text-red-400">{err}</p>
      )}
    </div>
  );
}

function MobileActionRow({
  icon,
  label,
  hint,
  onClick,
  disabled,
  busy,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-card border px-4 py-3 text-left transition",
        "border-[var(--border)] bg-[var(--bg)]",
        "active:bg-black/[0.04] dark:active:bg-white/[0.06]",
        "hover:border-[var(--accent)]/60",
        "disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[var(--text)]">
          {label}
        </span>
        <span className="block truncate text-xs text-[var(--text-muted)]">
          {hint}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
    </button>
  );
}

// --------------------------------------------------------------------
// "Upload new" tab.
// --------------------------------------------------------------------
function UploadTab({
  onUploaded,
  maxNew,
}: {
  onUploaded: (f: FileItem) => void;
  maxNew: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = useUploadFile();
  const [err, setErr] = useState<string | null>(null);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setErr(null);
    const files = picked.slice(0, Math.max(0, maxNew));
    if (picked.length > files.length) {
      setErr(
        `You can attach up to ${MAX_ATTACHMENTS} files per message — the first ${files.length} were added.`
      );
    }
    for (const file of files) {
      try {
        const result = await upload.mutateAsync({
          scope: "mine",
          file,
          folderId: null,
          // Files uploaded from the chat picker always land in the
          // owner's "Chat Uploads" system folder. (Drive stage 5
          // retired the admin-only "save to shared pool" path; sharing
          // is now per-resource via the Shared tab's grant modal.)
          route: "chat",
        });
        onUploaded(result);
      } catch (err) {
        setErr(extractError(err));
      }
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        Files uploaded here are saved to your Files tab so you can reuse them in
        other chats.
      </p>

      <button
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed px-6 py-10 transition",
          "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/5"
        )}
      >
        {upload.isPending ? (
          <Loader2 className="h-6 w-6 animate-spin text-[var(--accent)]" />
        ) : (
          <Upload className="h-6 w-6 text-[var(--text-muted)]" />
        )}
        <span className="text-sm font-medium">
          {upload.isPending ? "Uploading..." : "Choose files to upload"}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          Up to {MAX_ATTACHMENTS} files · 40 MB each
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handlePick}
      />

      {err && (
        <p className="text-sm text-red-600 dark:text-red-400">{err}</p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------
// Utilities (local copies so the modal is self-contained).
// --------------------------------------------------------------------
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
