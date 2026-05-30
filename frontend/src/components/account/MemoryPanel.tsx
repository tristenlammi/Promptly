import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { authApi } from "@/api/auth";
import { memoryApi, type Memory } from "@/api/memory";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

/** Cross-chat memory management (Phase 6).
 *
 * Lets the user see, edit, and delete the durable facts the assistant
 * has remembered about them across conversations, add their own, and
 * toggle the whole feature off. Memory is injected into every chat's
 * system prompt and captured automatically from what the user shares
 * (or explicitly via "remember this"). Persists the on/off switch to
 * ``users.settings.memory_enabled``; the facts themselves live in the
 * dedicated ``/memory`` API.
 */
export function MemoryPanel() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  const enabled = user?.settings?.memory_enabled !== false;
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: memories = [], isLoading } = useQuery({
    queryKey: ["memories"],
    queryFn: memoryApi.list,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["memories"] });

  const createMut = useMutation({
    mutationFn: (content: string) => memoryApi.create(content),
    onSuccess: () => {
      setDraft("");
      setActionError(null);
      void invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      memoryApi.update(id, content),
    onSuccess: () => {
      setEditingId(null);
      setEditText("");
      setActionError(null);
      void invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => memoryApi.remove(id),
    onSuccess: () => void invalidate(),
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const clearMut = useMutation({
    mutationFn: () => memoryApi.clear(),
    onSuccess: () => void invalidate(),
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const toggleEnabled = async (next: boolean) => {
    setToggleError(null);
    setToggleBusy(true);
    patchSettings({ memory_enabled: next });
    try {
      const fresh = await authApi.updatePreferences({ memory_enabled: next });
      setUser(fresh);
    } catch (err) {
      patchSettings({ memory_enabled: !next });
      setToggleError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggleBusy(false);
    }
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditText(m.content);
    setActionError(null);
  };

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <Brain className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Memory</h3>
        </div>
        <Toggle
          checked={enabled}
          onChange={(v) => void toggleEnabled(v)}
          disabled={toggleBusy}
        />
      </header>

      <div className="space-y-4 px-4 py-4">
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Promptly remembers durable facts you share (your name, role, the
          tools you use, how you like answers) and applies them across all
          your chats. Say "remember that…" to save something on purpose, or
          edit the list below. Turning memory off stops new capture and
          stops using saved facts — nothing is deleted.
        </p>

        {toggleError && (
          <ErrorBox
            message={`Couldn't update setting: ${toggleError}`}
            onDismiss={() => setToggleError(null)}
          />
        )}

        {enabled && (
          <>
            {/* Add new */}
            <form
              className="flex items-start gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = draft.trim();
                if (text) createMut.mutate(text);
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add something for Promptly to remember…"
                rows={1}
                maxLength={600}
                className={cn(
                  "min-h-[38px] flex-1 resize-y rounded-input border border-[var(--border)]",
                  "bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]",
                  "placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                )}
              />
              <Button
                type="submit"
                size="sm"
                disabled={!draft.trim() || createMut.isPending}
                className="mt-0.5 shrink-0"
              >
                {createMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Add
              </Button>
            </form>

            {actionError && (
              <ErrorBox
                message={actionError}
                onDismiss={() => setActionError(null)}
              />
            )}

            {/* List */}
            {isLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading memories…
              </div>
            ) : memories.length === 0 ? (
              <p className="py-2 text-xs text-[var(--text-muted)]">
                Nothing saved yet. Memories appear here as you chat.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-input border border-[var(--border)]">
                {memories.map((m) => (
                  <li key={m.id} className="px-3 py-2.5">
                    {editingId === m.id ? (
                      <div className="flex items-start gap-2">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={2}
                          maxLength={600}
                          autoFocus
                          className={cn(
                            "flex-1 resize-y rounded-input border border-[var(--border)]",
                            "bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]",
                            "focus:border-[var(--accent)] focus:outline-none"
                          )}
                        />
                        <button
                          type="button"
                          aria-label="Save"
                          disabled={!editText.trim() || updateMut.isPending}
                          onClick={() =>
                            updateMut.mutate({
                              id: m.id,
                              content: editText.trim(),
                            })
                          }
                          className="mt-0.5 rounded p-1 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-50"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel"
                          onClick={() => {
                            setEditingId(null);
                            setEditText("");
                          }}
                          className="mt-0.5 rounded p-1 text-[var(--text-muted)] hover:bg-black/5 dark:hover:bg-white/5"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-[var(--text)]">
                            {m.content}
                          </p>
                          {m.source === "auto" && (
                            <span className="mt-0.5 inline-block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                              Auto-captured
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            aria-label="Edit"
                            onClick={() => startEdit(m)}
                            className="rounded p-1 text-[var(--text-muted)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/5"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete"
                            disabled={deleteMut.isPending}
                            onClick={() => deleteMut.mutate(m.id)}
                            className="rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {memories.length > 0 && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={clearMut.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Forget everything?",
                      message:
                        "This permanently deletes all saved memories. It can't be undone.",
                      confirmLabel: "Forget all",
                      danger: true,
                    });
                    if (ok) clearMut.mutate();
                  }}
                  className="text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                >
                  {clearMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Forget everything
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ErrorBox({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-input border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-0.5 hover:bg-red-500/20"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition",
        checked ? "bg-[var(--accent)]" : "bg-black/15 dark:bg-white/15",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
