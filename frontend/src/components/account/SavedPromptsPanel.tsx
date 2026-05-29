import { useState } from "react";
import { Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";

import type { SavedPrompt } from "@/api/savedPrompts";
import { Button } from "@/components/shared/Button";
import {
  useCreateSavedPrompt,
  useDeleteSavedPrompt,
  useSavedPrompts,
  useUpdateSavedPrompt,
} from "@/hooks/useSavedPrompts";
import { cn } from "@/utils/cn";

/** Manage the user's reusable prompt library (Phase 3.1). Prompts
 *  saved here are invokable via ``/`` in the chat composer. */
export function SavedPromptsPanel() {
  const { data: prompts, isLoading } = useSavedPrompts();
  const createMut = useCreateSavedPrompt();
  const updateMut = useUpdateSavedPrompt();
  const deleteMut = useDeleteSavedPrompt();

  // ``null`` = nothing open, ``"new"`` = create form, otherwise the id
  // of the prompt being edited.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const openNew = () => {
    setEditing("new");
    setTitle("");
    setBody("");
    setError(null);
  };

  const openEdit = (p: SavedPrompt) => {
    setEditing(p.id);
    setTitle(p.title);
    setBody(p.body);
    setError(null);
  };

  const cancel = () => {
    setEditing(null);
    setTitle("");
    setBody("");
    setError(null);
  };

  const save = async () => {
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) {
      setError("Both a title and body are required.");
      return;
    }
    setError(null);
    try {
      if (editing === "new") {
        await createMut.mutateAsync({ title: t, body: b });
      } else if (editing) {
        await updateMut.mutateAsync({ id: editing, input: { title: t, body: b } });
      }
      cancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteMut.mutateAsync(id);
      if (editing === id) cancel();
    } catch {
      // Surfaced inline via the list row staying put; no toast system here.
    }
  };

  const saving = createMut.isPending || updateMut.isPending;

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <Sparkles className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Saved prompts</h3>
        </div>
        {editing === null && (
          <Button size="sm" variant="ghost" onClick={openNew}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            New prompt
          </Button>
        )}
      </header>

      <div className="space-y-3 px-4 py-4">
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          Reusable templates you can drop into any chat. Type{" "}
          <span className="font-mono text-[var(--text)]">/</span> at the start
          of the composer to pick one.
        </p>

        {editing !== null && (
          <div className="space-y-2 rounded-card border border-[var(--accent)]/40 bg-[var(--accent)]/[0.04] p-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Title (e.g. Summarize as bullet points)"
              className={cn(
                "w-full rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
                "border-[var(--border)] text-[var(--text)]",
                "focus:border-[var(--accent)] focus:outline-none"
              )}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Prompt body — the text inserted into the composer."
              className={cn(
                "w-full resize-y rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
                "border-[var(--border)] text-[var(--text)]",
                "focus:border-[var(--accent)] focus:outline-none"
              )}
            />
            {error && (
              <p className="text-[11px] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                {editing === "new" ? "Create" : "Save"}
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading prompts…
          </div>
        ) : (prompts?.length ?? 0) === 0 && editing === null ? (
          <div className="rounded-card border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
            No saved prompts yet. Create your first to use it with{" "}
            <span className="font-mono text-[var(--text)]">/</span>.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {prompts?.map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--text)]">
                    {p.title}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">
                    {p.body}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(p)}
                    title="Edit"
                    className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--accent)]/10 hover:text-[var(--text)]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(p.id)}
                    disabled={deleteMut.isPending}
                    title="Delete"
                    className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                  >
                    {deleteMut.isPending &&
                    deleteMut.variables === p.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
