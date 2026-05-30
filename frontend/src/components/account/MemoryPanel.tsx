import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { authApi } from "@/api/auth";
import { memoryApi, type Memory } from "@/api/memory";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

type MemoryMode = "off" | "auto" | "manual";

const MODE_OPTIONS: { value: MemoryMode; label: string; title: string }[] = [
  { value: "off", label: "Off", title: "Don't capture or use any memories" },
  {
    value: "auto",
    label: "Auto",
    title: "Capture durable facts automatically and use them everywhere",
  },
  {
    value: "manual",
    label: "Self-managed",
    title: "Only you add memories — Promptly never captures on its own",
  },
];

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

  // Resolve the three-way mode, falling back to the legacy boolean for
  // accounts that predate it (enabled → auto, disabled → off).
  const mode: MemoryMode =
    user?.settings?.memory_mode ??
    (user?.settings?.memory_enabled === false ? "off" : "auto");
  const enabled = mode !== "off";
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
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

  const setMode = async (next: MemoryMode) => {
    if (next === mode) return;
    setToggleError(null);
    setToggleBusy(true);
    // Keep the legacy boolean in sync so older code paths still read a
    // sensible value.
    const patch = { memory_mode: next, memory_enabled: next !== "off" };
    patchSettings(patch);
    try {
      const fresh = await authApi.updatePreferences(patch);
      setUser(fresh);
    } catch (err) {
      patchSettings({ memory_mode: mode, memory_enabled: mode !== "off" });
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

  const filterText = filter.trim().toLowerCase();
  const filteredMemories = filterText
    ? memories.filter((m) => m.content.toLowerCase().includes(filterText))
    : memories;

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <Brain className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Memory</h3>
        </div>
        <ModeSelector
          value={mode}
          onChange={(v) => void setMode(v)}
          disabled={toggleBusy}
        />
      </header>

      <div className="space-y-4 px-4 py-4">
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          {mode === "off"
            ? "Memory is off. Promptly won't capture new facts or use saved ones — nothing is deleted, so you can turn it back on anytime."
            : mode === "manual"
              ? "Self-managed: Promptly uses the facts you add below across all your chats, but never captures anything on its own. You have full control over what it remembers about you."
              : "Automatic: Promptly remembers durable facts you share (your name, role, tools, how you like answers) and applies them across all your chats. Say “remember that…” to save one on purpose, or add your own below."}
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
                {mode === "manual"
                  ? "Nothing saved yet. Add a fact above and Promptly will use it everywhere."
                  : "Nothing saved yet. Memories appear here as you chat."}
              </p>
            ) : (
              <div className="space-y-2">
                {/* Count + filter — keeps the panel usable with hundreds
                    of memories instead of an endless inline wall. */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    {memories.length}{" "}
                    {memories.length === 1 ? "memory" : "memories"}
                  </span>
                  {memories.length > 6 && (
                    <input
                      type="search"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter…"
                      className={cn(
                        "h-7 w-36 rounded-input border border-[var(--border)] bg-[var(--bg)] px-2.5 text-xs",
                        "text-[var(--text)] placeholder:text-[var(--text-muted)]",
                        "focus:border-[var(--accent)] focus:outline-none"
                      )}
                    />
                  )}
                </div>
                {filteredMemories.length === 0 ? (
                  <p className="py-2 text-xs text-[var(--text-muted)]">
                    No memories match “{filter.trim()}”.
                  </p>
                ) : (
                  <ul className="promptly-scroll max-h-80 divide-y divide-[var(--border)] overflow-y-auto rounded-input border border-[var(--border)]">
                    {filteredMemories.map((m) => (
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
                          className="mt-0.5 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
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
                            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete"
                            disabled={deleteMut.isPending}
                            onClick={() => deleteMut.mutate(m.id)}
                            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
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
              </div>
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
      className="flex items-start gap-2 rounded-input border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]"
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-0.5 hover:bg-[var(--danger-bg)]"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function ModeSelector({
  value,
  onChange,
  disabled,
}: {
  value: MemoryMode;
  onChange: (v: MemoryMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Memory mode"
      className="inline-flex rounded-input border border-[var(--border)] p-0.5"
    >
      {MODE_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-[1.25rem] px-2.5 py-1 text-xs font-medium transition",
              "disabled:cursor-not-allowed disabled:opacity-60",
              active
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
