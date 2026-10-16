import { useState } from "react";
import { FileText, Sparkles, X } from "lucide-react";

import { editorAiApi, type DeckSlide } from "@/api/editorAi";
import { filesApi } from "@/api/files";
import { MyFilesPicker } from "@/components/admin/MyFilesPicker";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** "Generate a deck from these files" (Stage 12): pick the files, say what
 *  the talk is for, and the model drafts the slides — titles, bullets and
 *  what to say, with the files each slide came from in its speaker notes.
 *  The slides are added after the ones already there. */
export function GenerateDeckDialog({
  fileId,
  onClose,
  onDone,
}: {
  /** The presentation. */
  fileId: string;
  onClose: () => void;
  onDone: (slides: DeckSlide[]) => Promise<void> | void;
}) {
  const { providerId, modelId } = useEditorModel();
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState(8);
  const [busy, setBusy] = useState(false);

  const add = async (ids: string[]) => {
    setPicking(false);
    const fresh = ids.filter((id) => !sources.some((s) => s.id === id));
    const named = await Promise.all(
      fresh.map(async (id) => ({ id, name: (await filesApi.getFile(id).catch(() => null))?.filename ?? "A file" })),
    );
    setSources((s) => [...s, ...named].slice(0, 10));
  };

  const go = async () => {
    if (!providerId || !modelId) {
      toast.error(NO_MODEL_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const out = await editorAiApi.deck(fileId, {
        provider_id: providerId, model_id: modelId, file_ids: sources.map((s) => s.id), brief: brief.trim() || undefined, slides: count,
      });
      if (!out.slides.length) throw new Error("The model didn't make any slides — try again.");
      await onDone(out.slides);
      toast.success(`Added ${out.slides.length} slides${out.truncated ? " — some files were too long to read in full" : ""}.`);
      onClose();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make the slides."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal open onClose={onClose} title="Generate slides from files" widthClass="max-w-lg">
        <div className="space-y-3 text-sm">
          <div>
            <p className="mb-1 text-xs font-medium text-[var(--text-muted)]">From these files</p>
            <ul aria-label="Source files" className="space-y-1">
              {sources.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <button type="button" aria-label={`Remove ${s.name}`} onClick={() => setSources((x) => x.filter((y) => y.id !== s.id))}
                    className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)]">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="secondary" className="mt-1.5" disabled={sources.length >= 10} onClick={() => setPicking(true)}>
              {sources.length ? "Add more files" : "Choose files"}
            </Button>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-[var(--text-muted)]">What's the talk for? (optional)</span>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} maxLength={2000}
              placeholder="A 10-minute update for the family meeting — keep it light."
              className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-muted)]">Slides</span>
            <input type="number" min={3} max={20} value={count} onChange={(e) => setCount(Math.min(20, Math.max(3, Number(e.target.value) || 8)))}
              className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1" aria-label="How many slides" />
          </label>
          <p className="text-xs text-[var(--text-muted)]">Each slide's speaker notes say which files it came from. Check the facts before you present.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" variant="primary" leftIcon={<Sparkles className="h-3.5 w-3.5" />} loading={busy} disabled={!sources.length} onClick={() => void go()}>
              Generate
            </Button>
          </div>
        </div>
      </Modal>
      <MyFilesPicker open={picking} onClose={() => setPicking(false)} onConfirm={(ids) => void add(ids)}
        title="Choose the files" description="The slides are drafted from what's in these." verb="Use"
        excludeIds={new Set(sources.map((s) => s.id))} />
    </>
  );
}
