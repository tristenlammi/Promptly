import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { notesApi } from "../api";
import { displayTitle, type Note } from "../types";
import { Sheet } from "./Sheet";

/**
 * Copy to a workspace… (N2.6, desktop): the note as a Page in a workspace
 * you can add pages to. A copy, so it says plainly who will see it; the
 * note itself stays as it is, private.
 */
export function CopyToWorkspace({ note, onClose, onDone }: { note: Note; onClose: () => void; onDone?: () => void }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({ queryKey: ["notes-workspace-targets"], queryFn: notesApi.workspaceTargets, staleTime: 30_000 });
  const [ws, setWs] = useState<string>("");
  const [book, setBook] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ws && data?.length) setWs(data[0].id);
  }, [data, ws]);
  const chosen = data?.find((w) => w.id === ws) ?? null;

  const go = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const out = await notesApi.toWorkspace(note.id, chosen.id, book || null);
      toast.success(`Copied to ${out.workspace}`, { action: { label: "Open", onClick: () => navigate(out.href) } });
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't copy the note."));
      setBusy(false);
    }
  };

  const select = "h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";
  return (
    <Sheet
      title="Copy to a workspace"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
            Cancel
          </button>
          <button
            type="button"
            disabled={!chosen || busy}
            onClick={() => void go()}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--accent-strong)] px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Copy
          </button>
        </>
      }
    >
      {isLoading ? (
        <p className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your workspaces…
        </p>
      ) : isError ? (
        <p className="py-4 text-sm text-[var(--text-muted)]">Couldn't load your workspaces. Check your connection and try again.</p>
      ) : !data?.length ? (
        <p className="py-4 text-sm text-[var(--text-muted)]">
          You don't have a workspace you can add pages to. Make one in Workspaces, or ask someone to make you an editor of theirs.
        </p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-[var(--text)]">
            “{displayTitle(note)}” becomes a page, with its pictures.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-[var(--text)]">Workspace</span>
            <select data-autofocus="" className={select} value={ws} onChange={(e) => (setWs(e.target.value), setBook(""))}>
              {data.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </select>
          </label>
          {chosen && chosen.notebooks.length > 0 && (
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[var(--text)]">Notebook</span>
              <select className={select} value={book} onChange={(e) => setBook(e.target.value)}>
                <option value="">None (at the top)</option>
                {chosen.notebooks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {chosen && (
            <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-[var(--text-muted)]">
              People in {chosen.title} will see this copy. Your note stays as it is.
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
