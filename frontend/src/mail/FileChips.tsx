import { CalendarDays, File as FileIcon, FileArchive, FileSpreadsheet, FileText, Film, Image as ImageIcon, Music, Presentation, type LucideIcon } from "lucide-react";

import { AttachmentViewer, useSavedAttachments } from "./AttachmentViewer";
import type { ListFile } from "./api";
import { chipsFor, fileKind, nameParts, sizeWords, type FileKind } from "./listFiles";

const ICONS: Record<FileKind, LucideIcon> = {
  picture: ImageIcon,
  pdf: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  doc: FileText,
  video: Film,
  audio: Music,
  zip: FileArchive,
  calendar: CalendarDays,
  file: FileIcon,
};
// Quiet colours that tell the common kinds apart at a glance, in light and dark.
const TINTS: Partial<Record<FileKind, string>> = {
  pdf: "text-[#D2553F]",
  sheet: "text-[#3FA66B]",
  slides: "text-[#D98A3D]",
  picture: "text-[#5B8DD9]",
  doc: "text-[#5B8DD9]",
};

/** The names of what's attached, under an email in the list. Each opens that file
 *  without opening the email. They share the one line: when it's too short, the
 *  names give way (each cut in its middle) and the "+N" never does. It sits over the row rather than inside its button,
 *  so a chip is a button of its own: reachable with Tab, and a click on it is
 *  never a click on the row. */
export function FileChips({ files, total, room, onOpen, className = "", style }: {
  files: ListFile[] | undefined;
  total: number | undefined;
  /** How many names before "+N". */
  room: number;
  onOpen: (file: ListFile) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { shown, more } = chipsFor(files, total, room);
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label="Attachments" style={style} className={`pointer-events-none flex min-w-0 items-center gap-1.5 ${className}`}>
      {shown.map((f) => {
        const Icon = ICONS[fileKind(f.name, f.mime)];
        const [start, end] = nameParts(f.name);
        return (
          <button
            key={`${f.message_id}/${f.part}`}
            type="button"
            data-mail-chip
            onClick={(e) => { e.stopPropagation(); onOpen(f); }}
            aria-label={`Open attachment ${f.name}, ${sizeWords(f.size)}`}
            title={`${f.name} · ${sizeWords(f.size)}`}
            className={`pointer-events-auto inline-flex h-8 min-w-0 md:h-6 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] pl-2 pr-2.5 text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] max-w-[15rem]`}
          >
            <Icon aria-hidden className={`h-3.5 w-3.5 shrink-0 ${TINTS[fileKind(f.name, f.mime)] ?? "text-[var(--text-muted)]"}`} />
            {/* Cut in the middle: the start gives way, the end (with what kind of file it is) stays. */}
            <span aria-hidden className="flex min-w-0"><span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{start}</span><span className="shrink-0 whitespace-pre">{end}</span></span>
          </button>
        );
      })}
      {more > 0 && <span title={`${more} more ${more === 1 ? "attachment" : "attachments"}`} className="shrink-0 rounded-full bg-[var(--hover)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">+{more}<span className="sr-only"> more {more === 1 ? "attachment" : "attachments"}</span></span>}
    </div>
  );
}

/** The viewer, opened from the list: the one email's files, starting on the one you chose. */
export function ListFileViewer({ files, start, onClose }: { files: ListFile[]; start: number; onClose: () => void }) {
  const saving = useSavedAttachments(files[0].message_id);
  return <AttachmentViewer messageId={files[0].message_id} attachments={files} start={start} saved={saving.saved} saving={saving.saving} onSave={(part) => void saving.save(part)} onClose={onClose} />;
}
