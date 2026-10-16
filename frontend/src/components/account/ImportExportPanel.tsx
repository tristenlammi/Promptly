import { useState } from "react";
import { Download, FolderInput, Upload } from "lucide-react";
import { Link } from "react-router-dom";

import { chatApi } from "@/api/chat";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { Button } from "@/components/shared/Button";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Bring chat history in from ChatGPT / Claude / another Promptly, and take
 *  all of it out in one file. Import used to live only in a desktop
 *  workspace header and export was one chat at a time (R-310). */
export function ImportExportPanel() {
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportAll = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await chatApi.exportAllConversations();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't export your conversations."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <FolderInput className="h-4 w-4" /> Import &amp; export
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Import chats from a ChatGPT or Claude data export (the .zip they email
        you), a Promptly export, or a Markdown transcript. Importing the same
        file again skips chats that are already here. Export downloads every
        conversation you own as one JSON file that Promptly can import.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Upload className="h-3.5 w-3.5" />}
          onClick={() => setImportOpen(true)}
        >
          Import conversations
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={exporting}
          leftIcon={<Download className="h-3.5 w-3.5" />}
          onClick={() => void exportAll()}
        >
          Export all conversations
        </Button>
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        Your files and photos — bringing them in from Google Takeout, a folder or Apple, and taking all of them with you —
        are in{" "}
        <Link to="/files/import" className="text-[var(--accent-text)] hover:underline">
          Files → Import &amp; export
        </Link>
        .
      </p>
      <ImportConversationsModal open={importOpen} onClose={() => setImportOpen(false)} />
    </section>
  );
}
