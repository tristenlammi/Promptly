import {
  FileText,
  FileUp,
  FolderPlus,
  FolderUp,
  LayoutTemplate,
  Plus,
  Presentation,
  Shapes,
  Table2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { filesApi, type FileScope } from "@/api/files";
import { officeApi, type OfficeKind } from "@/api/office";
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

/**
 * The one "+ New" menu (Part C §2.2): Document, Spreadsheet, Whiteboard,
 * From template…, Upload files, Upload folder, New folder — all into
 * ``folderId``. Used by the Files rail, the page toolbar on smaller
 * screens and the phone "+" button.
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
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const createFolder = useCreateFolder();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const wordInputRef = useRef<HTMLInputElement | null>(null);
  const sheetInputRef = useRef<HTMLInputElement | null>(null);
  const startUploads = useUploadStore((s) => s.startUploads);
  const changed = () => onChanged?.();

  const newOffice = async (kind: OfficeKind) => {
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

  const item = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[var(--hover)]"
    >
      <span className="text-[var(--text-muted)]">{icon}</span>
      {label}
    </button>
  );

  return (
    <div ref={menuRef} className={cn("relative", variant === "rail" ? "w-full" : "shrink-0")}>
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
      {variant === "fab" ? (
        <button
          type="button"
          aria-label="New"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="grid h-12 w-12 place-items-center rounded-full bg-[var(--accent)] text-white shadow-lg"
        >
          <Plus className="h-6 w-6" />
        </button>
      ) : variant === "rail" ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[var(--hover)]"
        >
          <Plus className="h-4 w-4 text-[var(--accent-text)]" />
          New
        </button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
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
            "absolute z-40 w-52 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg",
            variant === "rail" ? "left-0 top-12" : variant === "fab" ? "bottom-14 right-0" : "right-0 top-9"
          )}
        >
          {item(<FileText className="h-4 w-4" />, "Document", () => void newOffice("document"))}
          {item(<Table2 className="h-4 w-4" />, "Spreadsheet", () => void newOffice("sheet"))}
          {item(<Shapes className="h-4 w-4" />, "Whiteboard", () => void newOffice("whiteboard"))}
          {item(<Presentation className="h-4 w-4" />, "Presentation", () => void newPresentation())}
          {item(<LayoutTemplate className="h-4 w-4" />, "From template…", () => setTemplatesOpen(true))}
          {item(<FileUp className="h-4 w-4" />, "Import Word document…", () => wordInputRef.current?.click())}
          {item(<FileUp className="h-4 w-4" />, "Import spreadsheet…", () => sheetInputRef.current?.click())}
          <div className="my-1 border-t border-[var(--border)]" />
          {item(<Upload className="h-4 w-4" />, "Upload files", () => fileInputRef.current?.click())}
          {item(<FolderUp className="h-4 w-4" />, "Upload folder", () => folderInputRef.current?.click())}
          {item(<FolderPlus className="h-4 w-4" />, "New folder", () => setShowNewFolder(true))}
        </div>
      )}
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

