import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Pencil,
  Pin,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { authApi } from "@/api/auth";
import {
  memoryApi,
  type Memory,
  type MemoryConsolidateResult,
  type MemoryImportResult,
  MEMORY_CATEGORIES,
} from "@/api/memory";
import { useToastStore } from "@/store/toastStore";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { formatRelativeTime } from "@/components/files/helpers";
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

type SortMode = "recent" | "pinned" | "category";

const CATEGORY_LABELS: Record<string, string> = {
  identity: "Identity",
  preferences: "Preferences",
  projects: "Projects",
  context: "Context",
};

const CATEGORY_ORDER = ["identity", "preferences", "projects", "context"];

/** A fact looks stale when it hasn't been applied to any chat in ~3 months
 *  (or was never used and is past that age). Purely advisory — the badge
 *  nudges a review, nothing is auto-deleted. */
const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

function isStale(m: Memory): boolean {
  const lastActivity = m.last_used_at ?? m.created_at;
  if (!lastActivity) return false;
  return Date.now() - new Date(lastActivity).getTime() > STALE_AFTER_MS;
}

/** Sort + group memories by the chosen mode. */
function groupMemories(
  memories: Memory[],
  sortMode: SortMode
): { label: string | null; items: Memory[] }[] {
  if (sortMode === "pinned") {
    const pinned = memories.filter((m) => m.pinned);
    const rest = memories.filter((m) => !m.pinned);
    const groups: { label: string | null; items: Memory[] }[] = [];
    if (pinned.length) groups.push({ label: "Pinned", items: pinned });
    if (rest.length) groups.push({ label: null, items: rest });
    return groups;
  }
  if (sortMode === "category") {
    const byCategory = new Map<string, Memory[]>();
    for (const m of memories) {
      const key = m.category && CATEGORY_LABELS[m.category] ? m.category : "__other__";
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key)!.push(m);
    }
    const ordered = [
      ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
      ...(byCategory.has("__other__") ? ["__other__"] : []),
    ];
    return ordered.map((key) => ({
      label: key === "__other__" ? "Other" : CATEGORY_LABELS[key],
      items: byCategory.get(key)!,
    }));
  }
  // recent — flat, no grouping label
  return [{ label: null, items: [...memories].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )}];
}

/** Cross-chat memory management (Phase 6 + Phase 2 overhaul).
 *
 * Lets the user see, edit, and delete the durable facts the assistant
 * has remembered about them across conversations, add their own, and
 * toggle the whole feature off. Memories are grouped by category, can be
 * pinned so they always inject, and include provenance (source + timestamp).
 */
export function MemoryPanel() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);
  const pushToast = useToastStore((s) => s.push);
  const importFileRef = useRef<HTMLInputElement>(null);

  const mode: MemoryMode =
    user?.settings?.memory_mode ??
    (user?.settings?.memory_enabled === false ? "off" : "auto");
  const enabled = mode !== "off";

  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Add-new form
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<string>("");
  const [draftPinned, setDraftPinned] = useState(false);

  // Inline-edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState<string>("");

  // List controls
  const [filter, setFilter] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [sortOpen, setSortOpen] = useState(false);

  // Bulk select
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);

  const { data: memories = [], isLoading } = useQuery({
    queryKey: ["memories"],
    queryFn: memoryApi.list,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["memories"] });

  const createMut = useMutation({
    mutationFn: () =>
      memoryApi.create(draft.trim(), {
        category: draftCategory || null,
        pinned: draftPinned,
      }),
    onSuccess: () => {
      setDraft("");
      setDraftCategory("");
      setDraftPinned(false);
      setActionError(null);
      void invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof memoryApi.update>[1] }) =>
      memoryApi.update(id, patch),
    onSuccess: () => {
      setEditingId(null);
      setEditText("");
      setEditCategory("");
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

  const bulkDeleteMut = useMutation({
    mutationFn: (ids: string[]) => memoryApi.bulkRemove(ids),
    onSuccess: () => {
      setSelected(new Set());
      setSelectMode(false);
      void invalidate();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const pinMut = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      memoryApi.update(id, { pinned }),
    onSuccess: () => void invalidate(),
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const consolidateMut = useMutation({
    mutationFn: () => memoryApi.consolidate(),
    onSuccess: (result: MemoryConsolidateResult) => {
      void invalidate();
      pushToast({
        message: result.merged_groups
          ? `Tidied up: merged ${result.merged_groups} ${
              result.merged_groups === 1 ? "group" : "groups"
            } of overlapping facts (${result.removed} removed).`
          : "Nothing to tidy — no overlapping facts found.",
        type: "success",
      });
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const importMut = useMutation({
    mutationFn: (items: unknown[]) => memoryApi.import(items),
    onSuccess: (result: MemoryImportResult) => {
      void invalidate();
      pushToast({
        message: `Imported ${result.imported} ${result.imported === 1 ? "memory" : "memories"}` +
          (result.skipped ? ` · ${result.skipped} skipped` : "") +
          (result.errors ? ` · ${result.errors} errors` : ""),
        type: result.errors > 0 ? "warning" : "success",
      });
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : String(err)),
  });

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        setActionError("Import file must be a JSON array.");
        return;
      }
      importMut.mutate(parsed);
    } catch {
      setActionError("Could not parse the import file. Make sure it's a valid Promptly memory export.");
    }
  };

  const setMode = async (next: MemoryMode) => {
    if (next === mode) return;
    setToggleError(null);
    setToggleBusy(true);
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
    setEditCategory(m.category ?? "");
    setActionError(null);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filterText = filter.trim().toLowerCase();
  const filtered = filterText
    ? memories.filter((m) => m.content.toLowerCase().includes(filterText))
    : memories;

  const groups = groupMemories(filtered, sortMode);

  const SORT_LABELS: Record<SortMode, string> = {
    recent: "Recent",
    pinned: "Pinned first",
    category: "Category",
  };

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
            {/* ── Add new ───────────────────────────────────────────────── */}
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) createMut.mutate();
              }}
            >
              <div className="flex items-start gap-2">
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
              </div>
              {/* Category + pin for new fact */}
              <div className="flex items-center gap-3">
                <select
                  value={draftCategory}
                  onChange={(e) => setDraftCategory(e.target.value)}
                  className={cn(
                    "h-7 rounded-input border border-[var(--border)] bg-[var(--bg)] px-2 text-xs",
                    "text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
                  )}
                >
                  <option value="">No category</option>
                  {MEMORY_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  <input
                    type="checkbox"
                    checked={draftPinned}
                    onChange={(e) => setDraftPinned(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <Pin className="h-3 w-3" />
                  Always inject
                </label>
              </div>
            </form>

            {actionError && (
              <ErrorBox
                message={actionError}
                onDismiss={() => setActionError(null)}
              />
            )}

            {/* ── Memory list ───────────────────────────────────────────── */}
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
                {/* Toolbar */}
                {selectMode && selected.size > 0 ? (
                  <div className="flex items-center justify-between gap-2 rounded-input border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
                    <span className="text-xs font-medium text-[var(--text)]">
                      {selected.size} selected
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelected(new Set());
                          setSelectMode(false);
                        }}
                        className="text-[var(--text-muted)]"
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={bulkDeleteMut.isPending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Delete ${selected.size} ${selected.size === 1 ? "memory" : "memories"}?`,
                            message: "This can't be undone.",
                            confirmLabel: "Delete",
                            danger: true,
                          });
                          if (ok) bulkDeleteMut.mutate([...selected]);
                        }}
                        className="text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                      >
                        {bulkDeleteMut.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Delete
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                        {memories.length}{" "}
                        {memories.length === 1 ? "memory" : "memories"}
                      </span>
                      {/* Sort dropdown */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setSortOpen((o) => !o)}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-input border border-[var(--border)] bg-[var(--bg)] px-2",
                            "text-[10px] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                          )}
                        >
                          {SORT_LABELS[sortMode]}
                          <ChevronDown className="h-3 w-3" />
                        </button>
                        {sortOpen && (
                          <div
                            className="absolute left-0 top-full z-20 mt-1 min-w-[130px] rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
                            onMouseLeave={() => setSortOpen(false)}
                          >
                            {(["recent", "pinned", "category"] as SortMode[]).map(
                              (s) => (
                                <button
                                  key={s}
                                  type="button"
                                  onClick={() => {
                                    setSortMode(s);
                                    setSortOpen(false);
                                  }}
                                  className={cn(
                                    "flex w-full items-center gap-2 px-3 py-1.5 text-xs",
                                    "hover:bg-[var(--hover)]",
                                    s === sortMode
                                      ? "text-[var(--accent)]"
                                      : "text-[var(--text)]"
                                  )}
                                >
                                  {s === sortMode && <Check className="h-3 w-3" />}
                                  {SORT_LABELS[s]}
                                </button>
                              )
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {memories.length > 6 && (
                        <input
                          type="search"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                          placeholder="Filter…"
                          className={cn(
                            "h-7 w-28 rounded-input border border-[var(--border)] bg-[var(--bg)] px-2.5 text-xs",
                            "text-[var(--text)] placeholder:text-[var(--text-muted)]",
                            "focus:border-[var(--accent)] focus:outline-none"
                          )}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectMode((s) => !s);
                          setSelected(new Set());
                        }}
                        className={cn(
                          "h-7 rounded-input border px-2.5 text-xs",
                          selectMode
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                            : "border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                        )}
                      >
                        Select
                      </button>
                    </div>
                  </div>
                )}

                {filtered.length === 0 ? (
                  <p className="py-2 text-xs text-[var(--text-muted)]">
                    No memories match "{filter.trim()}".
                  </p>
                ) : (
                  <div className="promptly-scroll max-h-[28rem] space-y-3 overflow-y-auto">
                    {groups.map((group, gi) => (
                      <div key={gi}>
                        {group.label && (
                          <div className="mb-1 flex items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                              {group.label}
                            </span>
                            <div className="h-px flex-1 bg-[var(--border)]" />
                          </div>
                        )}
                        <ul className="divide-y divide-[var(--border)] rounded-input border border-[var(--border)]">
                          {group.items.map((m) => (
                            <MemoryRow
                              key={m.id}
                              memory={m}
                              editingId={editingId}
                              editText={editText}
                              editCategory={editCategory}
                              onEditTextChange={setEditText}
                              onEditCategoryChange={setEditCategory}
                              onStartEdit={startEdit}
                              onSaveEdit={() =>
                                updateMut.mutate({
                                  id: m.id,
                                  patch: {
                                    content: editText.trim(),
                                    category: editCategory || null,
                                  },
                                })
                              }
                              onCancelEdit={() => {
                                setEditingId(null);
                                setEditText("");
                                setEditCategory("");
                              }}
                              onDelete={() => deleteMut.mutate(m.id)}
                              onPin={() =>
                                pinMut.mutate({ id: m.id, pinned: !m.pinned })
                              }
                              updatePending={updateMut.isPending}
                              deletePending={deleteMut.isPending}
                              pinPending={pinMut.isPending}
                              selectMode={selectMode}
                              selected={selected.has(m.id)}
                              onToggleSelect={() => toggleSelect(m.id)}
                            />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Footer: Export / Import / Forget ─────────────────────── */}
            {!selectMode && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Tidy up + Export + Import */}
                <div className="flex items-center gap-1.5">
                  {memories.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={consolidateMut.isPending}
                      title="One AI pass that merges overlapping or duplicate facts. Nothing is deleted except facts absorbed into a merge."
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Tidy up memories?",
                          message:
                            "An AI pass will look over your saved facts and merge ones that say the same thing. Facts are only combined, never dropped or rewritten beyond the merge.",
                          confirmLabel: "Tidy up",
                        });
                        if (ok) consolidateMut.mutate();
                      }}
                      className="border border-[var(--border)] text-[var(--text-muted)]"
                    >
                      {consolidateMut.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      Tidy up
                    </Button>
                  )}
                  <a
                    href={memoryApi.exportUrl()}
                    download="promptly-memories.json"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs",
                      "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]",
                      "hover:bg-[var(--hover)] hover:text-[var(--text)]",
                      memories.length === 0 && "pointer-events-none opacity-40"
                    )}
                    aria-disabled={memories.length === 0}
                  >
                    <Download className="h-3 w-3" />
                    Export
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={importMut.isPending}
                    onClick={() => importFileRef.current?.click()}
                    className="border border-[var(--border)] text-[var(--text-muted)]"
                  >
                    {importMut.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    Import
                  </Button>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => void handleImportFile(e)}
                  />
                </div>

                {/* Forget everything */}
                {memories.length > 0 && (
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
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────

interface MemoryRowProps {
  memory: Memory;
  editingId: string | null;
  editText: string;
  editCategory: string;
  onEditTextChange: (v: string) => void;
  onEditCategoryChange: (v: string) => void;
  onStartEdit: (m: Memory) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  updatePending: boolean;
  deletePending: boolean;
  pinPending: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}

function MemoryRow({
  memory: m,
  editingId,
  editText,
  editCategory,
  onEditTextChange,
  onEditCategoryChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onPin,
  updatePending,
  deletePending,
  pinPending,
  selectMode,
  selected,
  onToggleSelect,
}: MemoryRowProps) {
  const isEditing = editingId === m.id;

  return (
    <li
      className={cn(
        "px-3 py-2.5 transition-colors",
        selected && "bg-[var(--accent)]/5"
      )}
    >
      {isEditing ? (
        /* ── Edit mode ────────────────────────────────────────────── */
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <textarea
              value={editText}
              onChange={(e) => onEditTextChange(e.target.value)}
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
              disabled={!editText.trim() || updatePending}
              onClick={onSaveEdit}
              className="mt-0.5 rounded p-1 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={onCancelEdit}
              className="mt-0.5 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <select
            value={editCategory}
            onChange={(e) => onEditCategoryChange(e.target.value)}
            className={cn(
              "h-7 rounded-input border border-[var(--border)] bg-[var(--bg)] px-2 text-xs",
              "text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            )}
          >
            <option value="">No category</option>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        /* ── View mode ────────────────────────────────────────────── */
        <div className="flex items-start gap-2">
          {/* Select checkbox */}
          {selectMode && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
            />
          )}

          {/* Pin indicator */}
          <button
            type="button"
            aria-label={m.pinned ? "Unpin" : "Pin"}
            disabled={pinPending}
            onClick={onPin}
            title={m.pinned ? "Pinned — always injected. Click to unpin." : "Pin to always inject"}
            className={cn(
              "mt-0.5 shrink-0 rounded p-0.5 transition-colors disabled:opacity-50",
              m.pinned
                ? "text-[var(--accent)]"
                : "text-[var(--border)] hover:text-[var(--text-muted)]"
            )}
          >
            <Pin className="h-3 w-3" fill={m.pinned ? "currentColor" : "none"} />
          </button>

          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--text)]">{m.content}</p>
            {/* Provenance row */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {m.category && CATEGORY_LABELS[m.category] && (
                <span className="inline-flex items-center rounded px-1 py-0 text-[10px] font-medium uppercase tracking-wide text-[var(--accent)] bg-[var(--accent)]/10">
                  {CATEGORY_LABELS[m.category]}
                </span>
              )}
              {m.source === "auto" && (
                <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  Auto
                </span>
              )}
              <span className="text-[10px] text-[var(--text-muted)]">
                {formatRelativeTime(m.created_at)}
              </span>
              {m.times_used > 0 && (
                <span
                  className="text-[10px] text-[var(--text-muted)]"
                  title="How many chat turns this fact has been applied to"
                >
                  · Used {m.times_used}×
                </span>
              )}
              {isStale(m) && (
                <span
                  className="inline-flex items-center rounded px-1 py-0 text-[10px] font-medium uppercase tracking-wide text-amber-700 bg-amber-500/10 dark:text-amber-300"
                  title="Hasn't been applied to a chat in over 3 months — worth a quick check that it's still true"
                >
                  Stale
                </span>
              )}
              {m.source === "auto" && m.source_conversation_id && (
                <a
                  href={`/chat/${m.source_conversation_id}`}
                  title="Open source conversation"
                  target="_self"
                  className="text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)]"
                >
                  <ExternalLink className="inline h-2.5 w-2.5" />
                </a>
              )}
            </div>
          </div>

          {/* Action buttons */}
          {!selectMode && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-label="Edit"
                onClick={() => onStartEdit(m)}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Delete"
                disabled={deletePending}
                onClick={onDelete}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </li>
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
