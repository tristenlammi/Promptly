import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Loader2 } from "lucide-react";
import { useState } from "react";

import { formsApi, type FormItem } from "@/api/forms";
import { Sheet } from "@/items/ui/Sheet";
import { cn } from "@/utils/cn";

import { KIND_META, isQuestion, newId } from "../model";

/**
 * "Import questions": pick another of your forms, tick the questions you
 * want, and they're copied in (with new ids). Pictures belong to their own
 * form, so they aren't copied; nor is branching, which pointed at that
 * form's sections.
 */
export function ImportQuestions({
  fileId,
  onClose,
  onImport,
}: {
  fileId: string;
  onClose: () => void;
  onImport: (items: FormItem[]) => void;
}) {
  const [from, setFrom] = useState<{ id: string; title: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const forms = useQuery({ queryKey: ["forms-home", "mine"], queryFn: () => formsApi.list("mine"), staleTime: 30_000 });
  const source = useQuery({
    queryKey: ["form-import-source", from?.id],
    queryFn: () => formsApi.get(from!.id),
    enabled: !!from,
  });
  const questions = (source.data?.form.definition.items ?? []).filter((i) => !i.deleted && isQuestion(i));
  const others = (forms.data ?? []).filter((f) => f.file_id !== fileId);

  const doImport = () => {
    const items = questions
      .filter((q) => picked.has(q.id))
      .map((q) => {
        const copy: FormItem = JSON.parse(JSON.stringify(q));
        copy.id = newId("q");
        copy.image_asset_id = null;
        const cfg = copy.config as { options?: { id: string; go_to: string | null; image_asset_id: string | null }[]; branching?: boolean };
        if (cfg.options)
          for (const o of cfg.options) {
            o.id = newId("o");
            o.go_to = null;
            o.image_asset_id = null;
          }
        if (cfg.branching !== undefined) cfg.branching = false;
        return copy;
      });
    if (items.length) onImport(items);
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={from ? `Questions in “${from.title}”` : "Import questions"}
      size="lg"
      footer={
        from ? (
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-3 text-sm hover:bg-[var(--hover)]"
              onClick={() => {
                setFrom(null);
                setPicked(new Set());
              }}
            >
              <ArrowLeft className="h-4 w-4" /> Other forms
            </button>
            <button
              type="button"
              disabled={picked.size === 0}
              onClick={doImport}
              className="inline-flex min-h-[40px] items-center rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              Import {picked.size || ""} question{picked.size === 1 ? "" : "s"}
            </button>
          </div>
        ) : undefined
      }
    >
      {!from ? (
        forms.isLoading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your forms…
          </p>
        ) : others.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">You don&apos;t have any other forms to import from yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
            {others.map((f) => (
              <li key={f.file_id}>
                <button
                  type="button"
                  onClick={() => setFrom({ id: f.file_id, title: f.title })}
                  className="flex min-h-[52px] w-full items-center gap-3 px-3 text-left text-sm hover:bg-[var(--hover)]"
                >
                  <ClipboardList className="h-4 w-4 shrink-0 text-purple-600" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-medium">{f.title}</span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {f.questions} question{f.questions === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : source.isLoading ? (
        <p className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : questions.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">That form has no questions.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="self-start text-sm font-medium text-[var(--accent-text)] hover:underline"
            onClick={() => setPicked(picked.size === questions.length ? new Set() : new Set(questions.map((q) => q.id)))}
          >
            {picked.size === questions.length ? "Untick all" : "Tick all"}
          </button>
          <ul className="flex flex-col gap-1.5">
            {questions.map((q) => {
              const Icon = KIND_META[q.kind].icon;
              const on = picked.has(q.id);
              return (
                <li key={q.id}>
                  <label className={cn("flex min-h-[48px] cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm", on ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)] hover:bg-[var(--hover)]")}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={on}
                      onChange={() => {
                        const next = new Set(picked);
                        if (on) next.delete(q.id);
                        else next.add(q.id);
                        setPicked(next);
                      }}
                    />
                    <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{q.title || "Untitled question"}</span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">{KIND_META[q.kind].label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-[var(--text-muted)]">Pictures and section jumps aren&apos;t copied.</p>
        </div>
      )}
    </Sheet>
  );
}
