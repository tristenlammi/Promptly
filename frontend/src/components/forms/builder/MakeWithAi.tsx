import { Check, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useState } from "react";

import { editorAiApi } from "@/api/editorAi";
import type { FormItem } from "@/api/forms";
import { Button } from "@/components/shared/Button";
import { Sheet } from "@/items/ui/Sheet";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { KIND_META, isQuestion, newId } from "../model";
import { fieldCls } from "./ui";

/**
 * Make with AI (Forms WP-F1.7): describe the form, and the AI suggests
 * questions — shown greyed as a preview with Add all / Add / Skip, the same
 * accept-first way as Sheets AI. Nothing goes into the form until you add
 * it, and what you add is an ordinary change (Undo works).
 */

const EXAMPLES = [
  "A sign-up form for the BBQ: dishes people will bring, how many are coming, dietary needs",
  "Feedback after the school fete: what people enjoyed, what could be better, a 1–5 rating",
  "Book club RSVP with a choice of three dates",
];

interface Suggestion {
  title: string | null;
  description: string | null;
  items: FormItem[];
}

/** Fresh ids, so a suggestion can be added twice without clashing. */
function reId(items: FormItem[]): FormItem[] {
  const sections = new Map<string, string>();
  for (const it of items) if (it.kind === "section") sections.set(it.id, newId("s"));
  return items.map((it) => {
    const copy: FormItem = JSON.parse(JSON.stringify(it));
    copy.id = sections.get(it.id) ?? newId("q");
    const cfg = copy.config as { options?: { id: string; go_to?: string | null }[]; after?: string };
    const renamed = new Map<string, string>();
    if (cfg.options) for (const o of cfg.options) {
      const id = newId("o");
      renamed.set(o.id, id);
      o.id = id;
      if (o.go_to && sections.has(o.go_to)) o.go_to = sections.get(o.go_to)!;
      else if (o.go_to && o.go_to !== "submit") o.go_to = null;
    }
    // A suggested quiz answer follows its option to the new id.
    if (copy.quiz?.key?.options) copy.quiz.key.options = copy.quiz.key.options.map((o) => renamed.get(o) ?? o);
    if (cfg.after && sections.has(cfg.after)) cfg.after = sections.get(cfg.after)!;
    return copy;
  });
}

/** The right answer an AI draft suggested, in words. */
function suggestedAnswer(it: FormItem): string {
  const key = it.quiz?.key;
  if (!key) return "";
  if (key.accept?.length) return key.accept.join(" / ");
  const opts = (it.config as { options?: { id: string; label: string }[] }).options ?? [];
  return opts.filter((o) => key.options?.includes(o.id)).map((o) => o.label).join(", ");
}

export function MakeWithAi({
  fileId,
  open,
  onClose,
  untitled,
  onAdd,
  onTitle,
}: {
  fileId: string;
  open: boolean;
  onClose: () => void;
  /** The form still has no title of its own (the suggestion's can be used). */
  untitled: boolean;
  onAdd: (items: FormItem[]) => boolean;
  onTitle: (title: string, description: string) => void;
}) {
  const { providerId, modelId } = useEditorModel();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [got, setGot] = useState<Suggestion | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const run = async () => {
    if (!providerId || !modelId) {
      setError(NO_MODEL_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await editorAiApi.form(fileId, { provider_id: providerId, model_id: modelId, mode: "draft", prompt: prompt.trim() });
      setGot({ title: r.title, description: r.description, items: r.items as FormItem[] });
      setDone(new Set());
    } catch (e) {
      setError(apiErrorMessage(e, "No suggestions came back. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const left = got ? got.items.filter((i) => !done.has(i.id)) : [];
  const take = (items: FormItem[]) => {
    if (!items.length) return;
    if (!onAdd(reId(items))) return;
    setDone((d) => new Set([...d, ...items.map((i) => i.id)]));
  };
  const skip = (id: string) => setDone((d) => new Set([...d, id]));
  const addAll = () => {
    if (got && untitled && got.title) onTitle(got.title, got.description ?? "");
    take(left);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Make with AI" size="lg">
      <div className="flex flex-col gap-3 px-4 pb-5 pt-1 sm:px-5" data-form-ai>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
          Describe your form
          <textarea
            className={cn(fieldCls, "h-auto min-h-[5.5rem] py-2 text-sm font-normal")}
            maxLength={4000}
            value={prompt}
            placeholder={EXAMPLES[0]}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && !busy) void run();
            }}
          />
        </label>
        {!got && (
          <div className="flex flex-wrap gap-1.5" aria-label="Examples">
            {EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setPrompt(x)}
                className="rounded-full border border-[var(--border)] px-3 py-1.5 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                {x}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" loading={busy} disabled={!prompt.trim()} onClick={() => void run()}>
            <Sparkles className="h-4 w-4" aria-hidden="true" /> {got ? "Suggest again" : "Suggest questions"}
          </Button>
          <span className="text-xs text-[var(--text-muted)]">You check each one before it&apos;s added.</span>
        </div>
        {error && (
          <p role="alert" className="text-sm text-[var(--danger,#b91c1c)]">
            {error}
          </p>
        )}
        {busy && (
          <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Thinking up questions…
          </p>
        )}
        {got && !busy && (
          <section aria-label="Suggested questions" className="flex flex-col gap-2">
            {got.title && (
              <p className="text-sm text-[var(--text)]">
                <span className="font-semibold">{got.title}</span>
                {untitled && <span className="text-[var(--text-muted)]"> · Add all also uses this title</span>}
              </p>
            )}
            {left.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-sm text-[var(--text-muted)]">
                That's all of them. Describe something else, or close this.
              </p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="ai-suggestions">
                {left.map((it) => (
                  <li key={it.id} className="flex items-start gap-3 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-3 opacity-80">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium text-[var(--text)]">
                        {it.title || (it.kind === "section" ? "New section" : "Untitled")}
                        {it.required && <span className="text-[var(--danger,#b91c1c)]"> *</span>}
                      </p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {KIND_META[it.kind]?.label ?? it.kind}
                        {isQuestion(it) && (it.config as { options?: { label: string }[] }).options?.length
                          ? ` · ${(it.config as { options: { label: string }[] }).options.map((o) => o.label).join(", ")}`
                          : ""}
                      </p>
                      {it.quiz?.suggested && suggestedAnswer(it) && (
                        <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          Answer: {suggestedAnswer(it)} · AI suggested this answer — check it
                        </p>
                      )}
                    </div>
                    <span className="flex shrink-0 gap-1">
                      <Button size="sm" variant="secondary" onClick={() => take([it])} aria-label={`Add “${it.title || "this"}”`}>
                        <Plus className="h-4 w-4" aria-hidden="true" /> Add
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => skip(it.id)} aria-label={`Skip “${it.title || "this"}”`}>
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {left.length > 0 && (
              <Button variant="primary" size="sm" className="self-start" onClick={addAll}>
                <Check className="h-4 w-4" aria-hidden="true" /> Add all {left.length}
              </Button>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}
