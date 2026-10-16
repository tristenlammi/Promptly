import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, FileText, Loader2, Wand2 } from "lucide-react";

import { editorAiApi } from "@/api/editorAi";
import type { FileItem } from "@/api/files";
import { officeEditorPath } from "@/api/office";
import { invalidateFileQueries } from "@/hooks/useFiles";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { useEditorModel } from "@/lib/editorModel";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Convert with AI (WP-5.5): a photo or PDF of a table → a Sheet; a scanned
 * letter or page → a Doc. Makes a new file beside the original and opens
 * it; the original is never changed. Lives in the file preview's toolbar.
 */
export function ConvertWithAi({ file, onDone }: { file: FileItem; onDone: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { providerId, modelId } = useEditorModel();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "sheet" | "document">(null);
  const ref = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(open, ref, () => setOpen(false));

  const run = async (to: "sheet" | "document") => {
    setOpen(false);
    setBusy(to);
    toast.info(`Reading “${file.filename}”… this can take a minute.`);
    try {
      const res = await editorAiApi.convert({
        source_file_id: file.id,
        to,
        provider_id: providerId,
        model_id: modelId,
      });
      invalidateFileQueries(qc);
      toast.success(
        `Made “${res.file.filename.replace(/\.(sheet|html)$/i, "")}”${res.notes.length ? ` — ${res.notes.join(" ")}` : ""}`
      );
      onDone();
      const path = officeEditorPath(res.file);
      if (path) navigate(path);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't convert that file."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!!busy}
        title="Convert with AI"
        aria-label="Convert with AI"
        aria-expanded={open}
        className={cn(
          "inline-flex h-11 w-11 items-center justify-center rounded-md text-white/80 transition hover:bg-white/10 hover:text-white md:h-8 md:w-8",
          busy && "opacity-70"
        )}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin md:h-4 md:w-4" /> : <Wand2 className="h-5 w-5 md:h-4 md:w-4" />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 text-sm text-[var(--text)] shadow-xl"
        >
          <div className="px-3 py-1.5 text-[11px] text-[var(--text-muted)]">Convert with AI — makes a new file</div>
          <button type="button" role="menuitem" onClick={() => void run("sheet")} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-[var(--hover)]">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            <span>
              <span className="block">To a sheet</span>
              <span className="block text-[11px] text-[var(--text-muted)]">Tables, receipts, price lists</span>
            </span>
          </button>
          <button type="button" role="menuitem" onClick={() => void run("document")} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-[var(--hover)]">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
            <span>
              <span className="block">To a document</span>
              <span className="block text-[11px] text-[var(--text-muted)]">Letters, scanned pages, notes</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
