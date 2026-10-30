import {
  FileText,
  FileUp,
  FolderPlus,
  FolderUp,
  LayoutTemplate,
  Loader2,
  Plus,
  Presentation,
  Shapes,
  StickyNote,
  Table2,
  Upload,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { filesApi, type FileScope } from "@/api/files";
import { officeApi, type NewOfficeKind } from "@/api/office";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useCreateFolder } from "@/hooks/useFiles";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { treeFromPicked, uploadTree } from "@/lib/folderUpload";
import { useFilesShellStore } from "@/store/filesShellStore";
import { toast } from "@/store/toastStore";
import { useUploadStore } from "@/store/uploadStore";
import { cn } from "@/utils/cn";

import { extractError, openFile } from "./helpers";
import { openSpreadsheetAsSheet, SPREADSHEET_ACCEPT } from "@/lib/office/sheetActions";
import { openWordAsDocument } from "@/lib/office/wordActions";
import { TemplatePickerModal } from "./TemplatePickerModal";

/** One thing "New" can make or do. ``create`` items make something (and
 *  open it); ``import`` items start from a template or an Office file;
 *  ``upload`` items bring files in. */
export interface NewItemAction {
  key: string;
  label: string;
  icon: ReactNode;
  group: "create" | "import" | "upload";
  onSelect: () => void;
}

/**
 * Everything "New" can do in ``folderId`` — Folder, Document, Note,
 * Spreadsheet, Presentation, Whiteboard, From template…, the two imports
 * and the uploads — plus the hidden inputs and modals they need
 * (``elements``: render it once). The rail / toolbar / phone "+" menu, the
 * right-click menu on empty space and the empty-folder state all use this,
 * so they offer the same things and put them in the same folder.
 */
export function useNewItems({
  folderId,
  scope = "mine",
  onChanged,
}: {
  folderId: string | null;
  scope?: FileScope;
  onChanged?: () => void;
}): { actions: NewItemAction[]; elements: ReactNode; creating: boolean } {
  const navigate = useNavigate();
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const createFolder = useCreateFolder();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const wordInputRef = useRef<HTMLInputElement | null>(null);
  const sheetInputRef = useRef<HTMLInputElement | null>(null);
  const startUploads = useUploadStore((s) => s.startUploads);
  const changed = () => onChanged?.();

  const newOffice = async (kind: NewOfficeKind) => {
    if (creating) return;
    setCreating(true);
    try {
      const file = await officeApi.create({ kind, folder_id: folderId });
      changed();
      openFile(file, navigate);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setCreating(false);
    }
  };

  const newPresentation = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { path } = await officeApi.createPresentation(folderId);
      changed();
      navigate(path);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setCreating(false);
    }
  };

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Materialise before resetting ``value`` — the FileList is live.
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    startUploads({ files, scope, folderId, onConflict: "ask" });
    changed();
  };

  // Upload the .docx (kept as it is), then open an editable copy (WP-4.3).
  const pickWord = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    try {
      const uploaded = await filesApi.upload(scope, picked, folderId);
      changed();
      await openWordAsDocument(uploaded, navigate);
      changed();
    } catch (err) {
      toast.error(extractError(err));
    }
  };

  // Upload the spreadsheet (kept as it is), then open a sheet made from it (WP-4.4).
  const pickSpreadsheet = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    try {
      const uploaded = await filesApi.upload(scope, picked, folderId);
      changed();
      await openSpreadsheetAsSheet(uploaded, navigate);
      changed();
    } catch (err) {
      toast.error(extractError(err));
    }
  };

  const pickFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    try {
      const n = await uploadTree(treeFromPicked(files), folderId, scope, startUploads);
      toast.info(`Uploading ${n} file${n === 1 ? "" : "s"}…`);
    } catch (err) {
      toast.error(extractError(err));
    }
    changed();
  };

  const ic = "h-4 w-4";
  const actions: NewItemAction[] = [
    { key: "folder", group: "create", label: "Folder", icon: <FolderPlus className={ic} />, onSelect: () => setShowNewFolder(true) },
    { key: "document", group: "create", label: "Document", icon: <FileText className={cn(ic, "text-sky-600")} />, onSelect: () => void newOffice("document") },
    { key: "note", group: "create", label: "Note", icon: <StickyNote className={cn(ic, "text-yellow-600")} />, onSelect: () => void newOffice("note") },
    { key: "sheet", group: "create", label: "Spreadsheet", icon: <Table2 className={cn(ic, "text-emerald-600")} />, onSelect: () => void newOffice("sheet") },
    { key: "presentation", group: "create", label: "Presentation", icon: <Presentation className={cn(ic, "text-orange-600")} />, onSelect: () => void newPresentation() },
    { key: "whiteboard", group: "create", label: "Whiteboard", icon: <Shapes className={cn(ic, "text-violet-600")} />, onSelect: () => void newOffice("whiteboard") },
    { key: "template", group: "import", label: "From template…", icon: <LayoutTemplate className={ic} />, onSelect: () => setTemplatesOpen(true) },
    { key: "import-word", group: "import", label: "Import Word document…", icon: <FileUp className={ic} />, onSelect: () => wordInputRef.current?.click() },
    { key: "import-sheet", group: "import", label: "Import spreadsheet…", icon: <FileUp className={ic} />, onSelect: () => sheetInputRef.current?.click() },
    { key: "upload-files", group: "upload", label: "Upload files", icon: <Upload className={ic} />, onSelect: () => fileInputRef.current?.click() },
    { key: "upload-folder", group: "upload", label: "Upload folder", icon: <FolderUp className={ic} />, onSelect: () => folderInputRef.current?.click() },
  ];

  const elements = (
    <>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={pickFiles} />
      <input
        ref={wordInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => void pickWord(e)}
      />
      <input
        ref={sheetInputRef}
        type="file"
        accept={SPREADSHEET_ACCEPT}
        className="hidden"
        onChange={(e) => void pickSpreadsheet(e)}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        // Chromium, Safari and Firefox all support picking a directory.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => void pickFolder(e)}
      />
      <TemplatePickerModal
        open={templatesOpen}
        folderId={folderId}
        onClose={() => setTemplatesOpen(false)}
        onCreated={changed}
      />
      <NewFolderModal
        open={showNewFolder}
        onClose={() => setShowNewFolder(false)}
        onSubmit={async (name) => {
          const made = await createFolder.mutateAsync({ scope, name, parentId: folderId });
          useFilesShellStore.getState().reveal(`folder:${made.id}`);
          changed();
          setShowNewFolder(false);
        }}
      />
    </>
  );

  return { actions, elements, creating };
}

/**
 * The one "+ New" menu (Part C §2.2): Folder, Document, Note, Spreadsheet,
 * Presentation, Whiteboard, From template…, the imports and the uploads —
 * all into ``folderId``. Used by the Files rail, the slim bar below
 * 1024 px and the phone "+" button.
 */
export function NewMenu({
  folderId,
  onChanged,
  variant = "toolbar",
  scope = "mine",
}: {
  folderId: string | null;
  onChanged?: () => void;
  /** "rail": a full-width button at the top of the Files rail. "fab": the
   *  phone's floating round "+". */
  variant?: "toolbar" | "rail" | "fab";
  scope?: FileScope;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const { actions, elements, creating } = useNewItems({ folderId, scope, onChanged });

  const item = (a: NewItemAction) => (
    <button
      key={a.key}
      type="button"
      role="menuitem"
      onClick={() => {
        setMenuOpen(false);
        a.onSelect();
      }}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[var(--hover)]"
    >
      <span className="text-[var(--text-muted)]">{a.icon}</span>
      {a.label}
    </button>
  );
  const group = (g: NewItemAction["group"]) => actions.filter((a) => a.group === g).map(item);

  return (
    <div ref={menuRef} className={cn("relative", variant === "rail" ? "w-full" : "shrink-0")}>
      {elements}
      {variant === "fab" ? (
        <button
          type="button"
          aria-label="New"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="grid h-12 w-12 place-items-center rounded-full bg-[var(--accent)] text-white shadow-lg"
        >
          {creating ? <Loader2 className="h-6 w-6 animate-spin" /> : <Plus className="h-6 w-6" />}
        </button>
      ) : variant === "rail" ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[var(--hover)]"
        >
          {creating ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-text)]" />
          ) : (
            <Plus className="h-4 w-4 text-[var(--accent-text)]" />
          )}
          New
        </button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          loading={creating}
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          New
        </Button>
      )}
      {menuOpen && (
        <div
          role="menu"
          className={cn(
            "promptly-scroll absolute z-40 max-h-[70vh] w-56 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg",
            variant === "rail"
              ? "left-0 top-12"
              : variant === "fab"
                ? "bottom-14 left-1/2 -translate-x-1/2"
                : "right-0 top-9"
          )}
        >
          {group("create")}
          <div className="my-1 border-t border-[var(--border)]" />
          {group("import")}
          <div className="my-1 border-t border-[var(--border)]" />
          {group("upload")}
        </div>
      )}
    </div>
  );
}

export function NewFolderModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(trimmed);
      setName("");
    } catch (e) {
      setErr(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New folder"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={busy} disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--text-muted)]">Folder name</span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            placeholder="Research papers"
          />
        </label>
        {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      </form>
    </Modal>
  );
}
