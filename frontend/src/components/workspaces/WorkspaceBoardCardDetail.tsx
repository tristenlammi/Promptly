import { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  FileText,
  Layers,
  LayoutGrid,
  Link2,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Square,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { filesApi } from "@/api/files";
import type {
  BoardColumn,
  BoardLabel,
  BoardMember,
  Subtask,
  TaskAttachment,
  TaskLink,
  TaskPriority,
  WorkspaceItemNode,
  WorkspaceTask,
  WorkspaceTaskUpdatePayload,
} from "@/api/workspaces";
import {
  useAddTaskAttachment,
  useAddTaskComment,
  useDeleteTaskAttachment,
  useDeleteTaskComment,
  useSetTaskAttachmentCover,
  useTaskComments,
} from "@/hooks/useWorkspaces";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";
import { WorkspaceFileImage } from "./WorkspaceFileImage";

/** Preset palette for board labels (hex; rendered via inline style). */
export const LABEL_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
];

const genLabelId = () => "l_" + Math.random().toString(36).slice(2, 9);

/**
 * Card detail panel for a Kanban task — the full editor behind a board card.
 * Title, status (column), priority, due date, a markdown description, and a
 * subtask checklist. Every edit calls ``onUpdate`` with a partial payload;
 * the board's react-query invalidation refreshes the columns.
 */

const PRIORITY_OPTS: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

const genId = () => Math.random().toString(36).slice(2, 10);

export function WorkspaceBoardCardDetail({
  task,
  workspaceId,
  canEdit,
  labels,
  onLabelsChange,
  members,
  columns,
  linkables,
  onOpenItem,
  autoFocusTitle,
  onClose,
  onUpdate,
  onDelete,
}: {
  task: WorkspaceTask;
  workspaceId: string;
  canEdit: boolean;
  labels: BoardLabel[];
  onLabelsChange: (labels: BoardLabel[]) => void;
  members: BoardMember[];
  columns: BoardColumn[];
  /** Navigator items this card can link to (notes / canvases / chats /
   *  boards). Empty when the tree hasn't loaded. */
  linkables: WorkspaceItemNode[];
  /** Open a linked item inline (closes this modal first). */
  onOpenItem?: (node: WorkspaceItemNode) => void;
  /** Focus + select the title on mount — set when the card was just created
   *  via the column "+" so the placeholder title is ready to overwrite. */
  autoFocusTitle?: boolean;
  onClose: () => void;
  onUpdate: (payload: WorkspaceTaskUpdatePayload) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocusTitle) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
    // Run once on mount for a freshly-created card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [description, setDescription] = useState(task.description ?? "");
  const subtasks: Subtask[] = task.subtasks ?? [];
  const [newSub, setNewSub] = useState("");
  const assigned = task.labels ?? [];

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) onUpdate({ title: next });
    else setTitle(task.title);
  };
  const commitDescription = () => {
    if ((description ?? "") !== (task.description ?? ""))
      onUpdate({ description: description.trim() || null });
  };
  // Edits already auto-save on blur; Save flushes any field still focused
  // (title / description) and closes the panel.
  const handleSave = () => {
    commitTitle();
    commitDescription();
    onClose();
  };
  const setSubtasks = (next: Subtask[]) =>
    onUpdate({ subtasks: next.length ? next : null });
  const toggleLabel = (id: string) =>
    onUpdate({
      labels: assigned.includes(id)
        ? assigned.filter((x) => x !== id)
        : [...assigned, id],
    });

  const doneCount = subtasks.filter((s) => s.done).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="mt-4 w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-2 border-b border-[var(--border)] p-4">
          <input
            ref={titleRef}
            value={title}
            disabled={!canEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* Status / priority / due */}
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Column
              <select
                disabled={!canEdit}
                value={
                  columns.some((c) => c.id === task.status)
                    ? task.status
                    : columns[0]?.id
                }
                onChange={(e) => onUpdate({ status: e.target.value })}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
              >
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Priority
              <select
                disabled={!canEdit}
                value={task.priority}
                onChange={(e) =>
                  onUpdate({ priority: e.target.value as TaskPriority })
                }
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
              >
                {PRIORITY_OPTS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Due
              <input
                type="datetime-local"
                disabled={!canEdit}
                defaultValue={task.due_at ? toLocalInput(task.due_at) : ""}
                onChange={(e) =>
                  onUpdate({
                    due_at: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
              />
            </label>
            {members.length > 0 && (
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                Assignee
                <select
                  disabled={!canEdit}
                  value={task.assignee_user_id ?? ""}
                  onChange={(e) =>
                    onUpdate({ assignee_user_id: e.target.value || null })
                  }
                  className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
                >
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.username}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Description */}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Description
            </div>
            <textarea
              value={description}
              disabled={!canEdit}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              rows={4}
              placeholder="Add more detail…"
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </div>

          {/* Labels */}
          <LabelsSection
            labels={labels}
            assigned={assigned}
            canEdit={canEdit}
            onToggle={toggleLabel}
            onLabelsChange={onLabelsChange}
          />

          {/* Linked items */}
          <LinksSection
            links={task.links ?? []}
            canEdit={canEdit}
            linkables={linkables}
            onChange={(next) => onUpdate({ links: next.length ? next : null })}
            onOpen={(node) => {
              onClose();
              onOpenItem?.(node);
            }}
          />

          {/* Attachments + cover */}
          <AttachmentsSection
            workspaceId={workspaceId}
            taskId={task.id}
            canEdit={canEdit}
            attachments={task.attachments ?? []}
          />

          {/* Subtasks */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              <span>Checklist</span>
              {subtasks.length > 0 && (
                <span>
                  {doneCount}/{subtasks.length}
                </span>
              )}
            </div>
            <div className="space-y-1">
              {subtasks.map((s) => (
                <div key={s.id} className="group flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() =>
                      setSubtasks(
                        subtasks.map((x) =>
                          x.id === s.id ? { ...x, done: !x.done } : x
                        )
                      )
                    }
                    className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    {s.done ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <input
                    value={s.text}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setSubtasks(
                        subtasks.map((x) =>
                          x.id === s.id ? { ...x, text: e.target.value } : x
                        )
                      )
                    }
                    className={cn(
                      "min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none focus:border-[var(--accent)]",
                      s.done
                        ? "text-[var(--text-muted)] line-through"
                        : "text-[var(--text)]"
                    )}
                  />
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() =>
                        setSubtasks(subtasks.filter((x) => x.id !== s.id))
                      }
                      className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="mt-1 flex items-center gap-2">
                <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <input
                  value={newSub}
                  onChange={(e) => setNewSub(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newSub.trim()) {
                      e.preventDefault();
                      setSubtasks([
                        ...subtasks,
                        { id: genId(), text: newSub.trim(), done: false },
                      ]);
                      setNewSub("");
                    }
                  }}
                  placeholder="Add a checklist item…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
                />
              </div>
            )}
          </div>

          {/* Comments + activity */}
          <ActivitySection
            workspaceId={workspaceId}
            taskId={task.id}
            canEdit={canEdit}
          />
        </div>

        {/* Footer */}
        {canEdit && (
          <div className="flex items-center justify-between border-t border-[var(--border)] p-3">
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" />
              Delete task
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={{ backgroundColor: "var(--success)" }}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium text-white transition hover:opacity-90"
            >
              <Check className="h-4 w-4" />
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LabelsSection({
  labels,
  assigned,
  canEdit,
  onToggle,
  onLabelsChange,
}: {
  labels: BoardLabel[];
  assigned: string[];
  canEdit: boolean;
  onToggle: (id: string) => void;
  onLabelsChange: (labels: BoardLabel[]) => void;
}) {
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_COLORS[5]);

  const update = (id: string, patch: Partial<BoardLabel>) =>
    onLabelsChange(labels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const remove = (id: string) =>
    onLabelsChange(labels.filter((l) => l.id !== id));
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onLabelsChange([
      ...labels,
      { id: genLabelId(), name, color: newColor },
    ]);
    setNewName("");
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <Tag className="h-3 w-3" /> Labels
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={() => setManaging((m) => !m)}
            className="inline-flex items-center gap-1 normal-case text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <Pencil className="h-3 w-3" />
            {managing ? "Done" : "Edit"}
          </button>
        )}
      </div>

      {!managing ? (
        <div className="flex flex-wrap gap-1.5">
          {labels.length === 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              No labels yet{canEdit ? " — click Edit to add some." : "."}
            </span>
          )}
          {labels.map((l) => {
            const on = assigned.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                disabled={!canEdit}
                onClick={() => onToggle(l.id)}
                style={
                  on
                    ? { backgroundColor: l.color, borderColor: l.color }
                    : { borderColor: l.color, color: l.color }
                }
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  on ? "text-white" : "bg-transparent"
                )}
              >
                {l.name}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {labels.map((l) => (
            <div key={l.id} className="flex items-center gap-2">
              <input
                value={l.name}
                onChange={(e) => update(l.id, { name: e.target.value })}
                className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
              />
              <ColorDots
                value={l.color}
                onChange={(c) => update(l.id, { color: c })}
              />
              <button
                type="button"
                onClick={() => remove(l.id)}
                className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="New label name…"
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
            />
            <ColorDots value={newColor} onChange={setNewColor} />
            <button
              type="button"
              onClick={add}
              className="shrink-0 rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact relative-time string ("just now", "5m", "3h", "2d", "Mar 4"). */
function rel(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function Initials({ name }: { name: string }) {
  const txt = (name || "?").trim().slice(0, 2).toUpperCase();
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-semibold text-white">
      {txt}
    </span>
  );
}

/**
 * Comments + activity thread for a task. Renders a chronological feed where
 * ``activity`` rows (status moves, due-date changes, assignment) are muted
 * one-liners and ``comment`` rows show an author avatar, name, relative time
 * and the message. A composer at the bottom posts new comments.
 */
function ActivitySection({
  workspaceId,
  taskId,
  canEdit,
}: {
  workspaceId: string;
  taskId: string;
  canEdit: boolean;
}) {
  const me = useAuthStore((s) => s.user);
  const { data: entries, isLoading } = useTaskComments(workspaceId, taskId);
  const add = useAddTaskComment(workspaceId, taskId);
  const del = useDeleteTaskComment(workspaceId, taskId);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text || add.isPending) return;
    add.mutate(text, { onSuccess: () => setDraft("") });
  };

  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Activity
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="space-y-2.5">
          {(entries ?? []).map((e) =>
            e.kind === "activity" ? (
              <div
                key={e.id}
                className="flex items-center gap-1.5 text-xs italic text-[var(--text-muted)]"
              >
                <span className="font-medium not-italic">
                  {e.author_username ?? "Someone"}
                </span>
                <span>{e.text}</span>
                <span aria-hidden>·</span>
                <span>{rel(e.created_at)}</span>
              </div>
            ) : (
              <div key={e.id} className="group flex items-start gap-2">
                <Initials name={e.author_username ?? "?"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="font-medium text-[var(--text)]">
                      {e.author_username ?? "Someone"}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {rel(e.created_at)}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">
                    {e.text}
                  </div>
                </div>
                {me?.id === e.author_user_id && (
                  <button
                    type="button"
                    onClick={() => del.mutate(e.id)}
                    className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                    title="Delete comment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          )}
          {(entries ?? []).length === 0 && (
            <div className="text-xs text-[var(--text-muted)]">
              No activity yet.
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Write a comment…"
            className="min-w-0 flex-1 resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || add.isPending}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/** Icon + readable label for a linkable item kind. */
function kindMeta(kind: string): { Icon: typeof FileText; label: string } {
  switch (kind) {
    case "note":
      return { Icon: FileText, label: "Note" };
    case "canvas":
      return { Icon: Layers, label: "Canvas" };
    case "chat":
      return { Icon: MessageSquare, label: "Chat" };
    case "board":
      return { Icon: LayoutGrid, label: "Board" };
    default:
      return { Icon: FileText, label: "Item" };
  }
}

/** Reconstruct a navigator node from a stored link so click-through works
 *  even if the live tree hasn't loaded (mirrors the note wiki-link fallback). */
function linkToNode(link: TaskLink): WorkspaceItemNode {
  return {
    id: link.item_id,
    kind: link.kind as WorkspaceItemNode["kind"],
    ref_id: link.ref_id,
    title: link.title,
    icon: null,
    position: 0,
    indexing_status: null,
    children: [],
  };
}

/**
 * "Linked items" section — references from this card to notes, canvases,
 * chats or boards elsewhere in the workspace. Each chip opens its target
 * inline; the add-picker lists tree items not already linked.
 */
function LinksSection({
  links,
  canEdit,
  linkables,
  onChange,
  onOpen,
}: {
  links: TaskLink[];
  canEdit: boolean;
  linkables: WorkspaceItemNode[];
  onChange: (links: TaskLink[]) => void;
  onOpen: (node: WorkspaceItemNode) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");

  const linkedIds = new Set(links.map((l) => l.item_id));
  const q = query.trim().toLowerCase();
  const options = linkables
    .filter((n) => !linkedIds.has(n.id))
    .filter((n) => !q || (n.title || "").toLowerCase().includes(q))
    .slice(0, 8);

  const add = (node: WorkspaceItemNode) => {
    onChange([
      ...links,
      {
        item_id: node.id,
        kind: node.kind,
        ref_id: node.ref_id,
        title: node.title,
      },
    ]);
    setQuery("");
    setAdding(false);
  };
  const remove = (itemId: string) =>
    onChange(links.filter((l) => l.item_id !== itemId));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <Link2 className="h-3 w-3" /> Links
        </span>
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 normal-case text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        )}
      </div>

      {links.length === 0 && !adding && (
        <span className="text-xs text-[var(--text-muted)]">
          No links yet{canEdit ? " — link a note, chat, canvas or board." : "."}
        </span>
      )}

      <div className="flex flex-col gap-1">
        {links.map((l) => {
          const { Icon } = kindMeta(l.kind);
          const fresh = linkables.find((n) => n.id === l.item_id);
          const title = fresh?.title || l.title || "Untitled";
          return (
            <div key={l.item_id} className="group flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpen(fresh ?? linkToNode(l))}
                title={`Open ${title}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-left text-sm text-[var(--text)] transition hover:border-[var(--accent)]"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{title}</span>
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(l.item_id)}
                  title="Remove link"
                  className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {adding && canEdit && (
        <div className="mt-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1.5">
          <div className="mb-1 flex items-center gap-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Search items to link…"
              className="min-w-0 flex-1 bg-transparent px-1 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
            />
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setQuery("");
              }}
              className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-1 py-1.5 text-xs text-[var(--text-muted)]">
                {linkables.length === 0
                  ? "Nothing to link yet."
                  : "No matches."}
              </p>
            ) : (
              options.map((n) => {
                const { Icon, label } = kindMeta(n.kind);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => add(n)}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                    <span className="min-w-0 flex-1 truncate">
                      {n.title || "Untitled"}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                      {label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage = (mime: string) => (mime || "").toLowerCase().startsWith("image/");

/**
 * File attachments on a card. Upload drops the file into the user's Drive
 * (Chat Uploads), attaches it, and kicks off RAG indexing server-side.
 * Image attachments can be starred as the card's cover; each row downloads
 * or detaches. Detaching keeps the underlying Drive file.
 */
function AttachmentsSection({
  workspaceId,
  taskId,
  canEdit,
  attachments,
}: {
  workspaceId: string;
  taskId: string;
  canEdit: boolean;
  attachments: TaskAttachment[];
}) {
  const add = useAddTaskAttachment(workspaceId, taskId);
  const setCover = useSetTaskAttachmentCover(workspaceId, taskId);
  const remove = useDeleteTaskAttachment(workspaceId, taskId);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await filesApi.upload("mine", file, null, "chat");
        await add.mutateAsync(uploaded.id);
      }
    } catch {
      setError("Upload failed — try a smaller file.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <Paperclip className="h-3 w-3" /> Attachments
        </span>
        {canEdit && (
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1 normal-case text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Add file
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => void onPick(e.target.files)}
      />

      {error && <p className="mb-1 text-xs text-red-500">{error}</p>}

      {attachments.length === 0 && !uploading ? (
        <span className="text-xs text-[var(--text-muted)]">
          No attachments{canEdit ? " — add files for reference + context." : "."}
        </span>
      ) : (
        <div className="flex flex-col gap-1.5">
          {attachments.map((a) => {
            const image = isImage(a.mime_type);
            return (
              <div
                key={a.file_id}
                className="group flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1.5"
              >
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded">
                  {image ? (
                    <WorkspaceFileImage
                      fileId={a.file_id}
                      className="h-9 w-9 object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 items-center justify-center bg-[var(--hover)]">
                      <FileText className="h-4 w-4 text-[var(--text-muted)]" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-[var(--text)]">
                      {a.filename || "File"}
                    </span>
                    {a.is_cover && (
                      <span className="shrink-0 rounded bg-[var(--accent)]/15 px-1 text-[10px] font-medium text-[var(--accent)]">
                        Cover
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {fmtBytes(a.size_bytes)}
                  </span>
                </div>

                {/* Cover toggle (images only) */}
                {canEdit && image && (
                  <button
                    type="button"
                    title={a.is_cover ? "Remove cover" : "Set as cover"}
                    onClick={() =>
                      setCover.mutate({
                        fileId: a.file_id,
                        cover: !a.is_cover,
                      })
                    }
                    className={cn(
                      "shrink-0 rounded p-1 transition",
                      a.is_cover
                        ? "text-[var(--accent)]"
                        : "text-[var(--text-muted)] opacity-0 hover:text-[var(--text)] group-hover:opacity-100"
                    )}
                  >
                    <Star
                      className="h-3.5 w-3.5"
                      fill={a.is_cover ? "currentColor" : "none"}
                    />
                  </button>
                )}

                <a
                  href={filesApi.downloadUrl(a.file_id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Download"
                  className="shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition hover:text-[var(--text)] group-hover:opacity-100"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>

                {canEdit && (
                  <button
                    type="button"
                    title="Remove attachment"
                    onClick={() => remove.mutate(a.file_id)}
                    className="shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ColorDots({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{ backgroundColor: c }}
          className={cn(
            "h-4 w-4 rounded-full",
            value === c && "ring-2 ring-[var(--text)] ring-offset-1"
          )}
        />
      ))}
    </div>
  );
}
