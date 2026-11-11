import { CheckCircle2, Sparkles } from "lucide-react";

import type { ChoiceGridConfig, FormItem, FormOption, ItemQuiz, QuizKey } from "@/api/forms";
import { cn } from "@/utils/cn";

import { NumberBox, fieldCls } from "./ui";

/**
 * A question's answer key in a quiz (WP-F2.3): which option(s) are right,
 * the accepted answers, or the right cell in each grid row; how many points
 * it's worth; and one line of feedback for a right answer and one for a
 * wrong one. Paragraphs are marked by hand in Responses. Opened from the
 * card's "Answer key" button; the card then says "2 points · key set".
 */

export const MARKABLE: FormItem["kind"][] = ["multiple_choice", "dropdown", "checkboxes", "short_text", "paragraph", "choice_grid", "checkbox_grid"];

export function emptyQuiz(item: FormItem): ItemQuiz {
  return { points: 1, key: emptyKey(item), feedback_right: "", feedback_wrong: "" };
}

function emptyKey(item: FormItem): QuizKey | null {
  switch (item.kind) {
    case "multiple_choice":
    case "dropdown":
    case "checkboxes":
      return { options: [] };
    case "short_text":
      return { accept: [] };
    case "choice_grid":
    case "checkbox_grid":
      return { rows: {} };
    default:
      return null;
  }
}

/** Points a question is worth (a grid: per row in the key). */
export function itemPoints(item: FormItem): number {
  const q = item.quiz;
  if (!q || !MARKABLE.includes(item.kind)) return 0;
  if (item.kind === "choice_grid" || item.kind === "checkbox_grid") return q.points * Object.keys(q.key?.rows ?? {}).length;
  return q.points;
}

export function keySet(item: FormItem): boolean {
  const q = item.quiz;
  if (!q || !q.points) return false;
  if (item.kind === "paragraph") return true;
  const k = q.key;
  return !!(k && ((k.options && k.options.length) || (k.accept && k.accept.length) || (k.rows && Object.keys(k.rows).length)));
}

/** "2 points · key set", "Marked by hand · 3 points" or "No answer key yet". */
export function keyWords(item: FormItem): string {
  const q = item.quiz;
  if (!q || !q.points) return "No answer key yet";
  const pts = itemPoints(item);
  if (item.kind === "paragraph") return `${q.points} ${q.points === 1 ? "point" : "points"} · marked by hand`;
  if (!keySet(item)) return "No answer key yet";
  return `${pts} ${pts === 1 ? "point" : "points"} · key set`;
}

export function AnswerKey({
  item,
  onChange,
  onDone,
}: {
  item: FormItem;
  onChange: (fn: (q: ItemQuiz) => ItemQuiz, coalesce?: string) => void;
  onDone: () => void;
}) {
  const q = item.quiz ?? emptyQuiz(item);
  const set = (patch: Partial<ItemQuiz>, key?: string) => onChange((cur) => ({ ...cur, ...patch, suggested: undefined }), key);
  const setKey = (k: QuizKey) => set({ key: k });
  const grid = item.kind === "choice_grid" || item.kind === "checkbox_grid";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-3" role="group" aria-label="Answer key">
      {q.suggested && (
        <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-sm text-amber-800 dark:text-amber-300">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>AI suggested this answer — check it. Change it below, or tap Looks right.</span>
        </p>
      )}
      {(item.kind === "multiple_choice" || item.kind === "dropdown" || item.kind === "checkboxes") && (
        <OptionsKey item={item} picked={q.key?.options ?? []} onPick={(options) => setKey({ options })} />
      )}
      {item.kind === "short_text" && (
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Accepted answers, one per line (capitals, extra spaces and a full stop at the end don&apos;t matter)
          <textarea
            className={cn(fieldCls, "min-h-[4.5rem] resize-y text-sm")}
            value={(q.key?.accept ?? []).join("\n")}
            onChange={(e) =>
              setKey({ accept: e.target.value.split(/\r?\n/).map((s) => s.slice(0, 300)).slice(0, 20) })
            }
            onBlur={(e) =>
              setKey({ accept: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20) })
            }
          />
        </label>
      )}
      {grid && <GridKey item={item} rows={q.key?.rows ?? {}} onRows={(rows) => setKey({ rows })} />}
      {item.kind === "paragraph" && (
        <p className="text-sm text-[var(--text-muted)]">You mark paragraph answers yourself in Responses, with “Next to mark”.</p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <NumberBox
          className="w-32"
          label={grid ? "Points per row right" : "Points"}
          value={q.points}
          min={0}
          max={100}
          onChange={(n) => set({ points: n === null ? 0 : Math.max(0, Math.min(100, Math.round(n))) }, `${item.id}:points`)}
        />
        {grid && <p className="pb-2 text-xs text-[var(--text-muted)]">Worth {itemPoints({ ...item, quiz: q })} in all.</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Feedback when right (optional)
          <input
            className={fieldCls}
            maxLength={500}
            value={q.feedback_right}
            placeholder="e.g. Well done!"
            onChange={(e) => set({ feedback_right: e.target.value }, `${item.id}:fbr`)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Feedback when wrong (optional)
          <input
            className={fieldCls}
            maxLength={500}
            value={q.feedback_wrong}
            placeholder="e.g. It's Canberra."
            onChange={(e) => set({ feedback_wrong: e.target.value }, `${item.id}:fbw`)}
          />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        {q.suggested && (
          <button type="button" className="min-h-[40px] rounded-md px-3 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]" onClick={() => set({})}>
            <CheckCircle2 className="mr-1 inline h-4 w-4" aria-hidden="true" /> Looks right
          </button>
        )}
        <button type="button" className="min-h-[40px] rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function OptionsKey({ item, picked, onPick }: { item: FormItem; picked: string[]; onPick: (ids: string[]) => void }) {
  const opts = (item.config as { options: FormOption[] }).options;
  const exact = item.kind === "checkboxes";
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs text-[var(--text-muted)]">
        {exact ? "Tick every right option: people must tick exactly these" : "Tap the right answer (tap more than one if any of them is right)"}
      </legend>
      {opts.map((o, i) => {
        const on = picked.includes(o.id);
        return (
          <label
            key={o.id}
            className={cn(
              "flex min-h-[40px] cursor-pointer items-center gap-2 rounded-md border px-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]",
              on ? "border-[var(--accent)] bg-[var(--accent)]/10 font-medium" : "border-[var(--border)] hover:bg-[var(--hover)]"
            )}
          >
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={on}
              onChange={() => onPick(on ? picked.filter((x) => x !== o.id) : [...picked, o.id])}
            />
            <span className="min-w-0 flex-1 truncate">{o.label || `Option ${i + 1}`}</span>
            {on && <span className="shrink-0 text-xs text-[var(--accent-text)]">Right</span>}
          </label>
        );
      })}
      {(item.config as { other?: boolean }).other && (
        <p className="text-xs text-[var(--text-muted)]">“Other” answers are never marked right by themselves; you can mark them by hand.</p>
      )}
    </fieldset>
  );
}

function GridKey({ item, rows, onRows }: { item: FormItem; rows: Record<string, string | string[]>; onRows: (r: Record<string, string | string[]>) => void }) {
  const c = item.config as ChoiceGridConfig;
  const multi = item.kind === "checkbox_grid";
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs text-[var(--text-muted)]">
        {multi ? "Tick the right columns in each row" : "Pick the right column in each row"} (a row left empty isn&apos;t marked)
      </legend>
      {c.rows.map((r, ri) => {
        const rowName = r.label || `Row ${ri + 1}`;
        const cur = rows[r.id];
        return (
          <div key={r.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-sm font-medium sm:w-40 sm:shrink-0 [overflow-wrap:anywhere]">{rowName}</span>
            {multi ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Right columns for ${rowName}`}>
                {c.columns.map((col, ci) => {
                  const on = Array.isArray(cur) && cur.includes(col.id);
                  return (
                    <label key={col.id} className={cn("flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm", on ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)]")}>
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={on}
                        onChange={() => {
                          const list = Array.isArray(cur) ? cur : [];
                          const next = on ? list.filter((x) => x !== col.id) : [...list, col.id];
                          const out = { ...rows };
                          if (next.length) out[r.id] = next;
                          else delete out[r.id];
                          onRows(out);
                        }}
                      />
                      {col.label || `Column ${ci + 1}`}
                    </label>
                  );
                })}
              </div>
            ) : (
              <select
                aria-label={`Right column for ${rowName}`}
                className={cn(fieldCls, "h-10 sm:max-w-xs")}
                value={typeof cur === "string" ? cur : ""}
                onChange={(e) => {
                  const out = { ...rows };
                  if (e.target.value) out[r.id] = e.target.value;
                  else delete out[r.id];
                  onRows(out);
                }}
              >
                <option value="">Not marked</option>
                {c.columns.map((col, ci) => (
                  <option key={col.id} value={col.id}>
                    {col.label || `Column ${ci + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
