import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks,
  CalendarDays,
  Contact,
  FileText,
  Folder,
  FolderOpen,
  Image,
  LayoutGrid,
  ListChecks,
  RotateCcw,
  Search,
  StickyNote,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { toRef, trashApi, type TrashItem } from "@/api/trash";
import { extractError, formatRelativeTime } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { SkeletonRows } from "@/components/shared/Skeleton";

/** Apps in the order their groups appear, with a label and an icon. */
const APPS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "drive", label: "Files", icon: FolderOpen },
  { key: "photos", label: "Photos", icon: Image },
  { key: "workspaces", label: "Workspaces", icon: LayoutGrid },
  { key: "calendar", label: "Calendar", icon: CalendarDays },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "contacts", label: "Contacts", icon: Contact },
  { key: "notes", label: "Notes", icon: StickyNote },
  { key: "apps", label: "Apps", icon: Blocks },
];

function iconFor(it: TrashItem): LucideIcon {
  if (it.kind === "folder" || it.kind === "container") return Folder;
  if (it.kind === "file") return FileText;
  return APPS.find((a) => a.key === it.app)?.icon ?? FileText;
}

function kindLabel(it: TrashItem): string {
  switch (it.kind) {
    case "calendar_event":
      return "Event";
    case "album":
      return "Album";
    case "task":
      return "Task";
    case "contact":
      return "Contact";
    case "note":
      // A workspace "note" is a Page; a Notes note is a Note (N1.7).
      return it.type === "workspace_item" ? "Page" : "Note";
    case "workspace":
      return "Workspace";
    case "container":
      return "Notebook";
    case "item":
      return "App file";
    default:
      return it.kind.charAt(0).toUpperCase() + it.kind.slice(1);
  }
}

function daysLeft(expires: string): number {
  return Math.max(0, Math.ceil((new Date(expires).getTime() - Date.now()) / 86_400_000));
}

/**
 * One trash for every app: Drive files, photos, workspaces and their items,
 * calendar events, albums, tasks and contacts. Same Restore, same "Delete
 * forever", same 30-day rule everywhere. Drive's own Trash (/files/trash)
 * stays as the Files view of the same data.
 */
export function UnifiedTrashPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({ queryKey: ["trash"], queryFn: trashApi.list });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [emptying, setEmptying] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);
  const days = data?.retention_days ?? 30;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => `${it.title} ${it.location} ${kindLabel(it)}`.toLowerCase().includes(q));
  }, [items, query]);
  const groups = useMemo(() => {
    const known = new Set(APPS.map((a) => a.key));
    const out = APPS.map((a) => ({ ...a, items: filtered.filter((it) => it.app === a.key) }));
    const other = filtered.filter((it) => !known.has(it.app));
    if (other.length) out.push({ key: "other", label: "Other", icon: FileText, items: other });
    return out.filter((g) => g.items.length);
  }, [filtered]);

  const refreshEverything = () => {
    // A restore lands back in its app — every view may change.
    void qc.invalidateQueries();
  };

  const mark = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const restore = async (it: TrashItem) => {
    mark(it.id, true);
    try {
      const r = await trashApi.restore([toRef(it)]);
      const res = r.results[0];
      if (res?.ok) toast.success(res.location ? `Restored “${it.title}” to ${res.location}` : `Restored “${it.title}”`);
      else toast.error(res?.error || "Couldn't restore that.");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      mark(it.id, false);
      refreshEverything();
    }
  };

  const deleteForever = async (it: TrashItem) => {
    const more = it.count ? ` and the ${it.count} item${it.count === 1 ? "" : "s"} inside it` : "";
    const ok = await confirm({
      title: "Delete forever?",
      message: `“${it.title}”${more} will be permanently deleted. This can't be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    mark(it.id, true);
    try {
      const r = await trashApi.purge([toRef(it)]);
      const res = r.results[0];
      if (res?.ok) toast.success(`Deleted “${it.title}” for good`);
      else toast.error(res?.error || "Nothing was deleted — it may already be gone.");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      mark(it.id, false);
      refreshEverything();
    }
  };

  const emptyAll = async () => {
    const ok = await confirm({
      title: "Empty trash?",
      message: `All ${items.length} item${items.length === 1 ? "" : "s"} in your trash, from every app, will be permanently deleted. This can't be undone.`,
      confirmLabel: "Empty trash",
      danger: true,
    });
    if (!ok) return;
    setEmptying(true);
    try {
      const r = await trashApi.empty();
      toast.success(r.deleted ? `Deleted ${r.deleted} item${r.deleted === 1 ? "" : "s"} for good` : "Trash emptied");
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setEmptying(false);
      refreshEverything();
    }
  };

  return (
    <>
      <TopNav
        title="Trash"
        subtitle={`Deleted things from every app. They're deleted for good after ${days} days.`}
        actions={
          <Button
            size="sm"
            variant="danger"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => void emptyAll()}
            disabled={!items.length}
            loading={emptying}
          >
            Empty trash
          </Button>
        }
      />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
          {items.length > 0 && (
            <div className="mb-5 flex items-center gap-2 rounded-input border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <Search className="h-4 w-4 text-[var(--text-muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the trash…"
                aria-label="Search the trash"
                className="flex-1 bg-transparent text-sm placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>
          )}

          {isLoading && <SkeletonRows count={3} label="Loading" />}
          {isError && <div className="text-sm text-[var(--danger)]">Couldn't load the trash.</div>}

          {!isLoading && !isError && items.length === 0 && (
            <EmptyState
              icon={<Trash2 className="h-5 w-5" />}
              title="Trash is empty"
              description={`Files, photos, workspace pages, events, albums, tasks, contacts and notes you delete stay here for ${days} days.`}
            />
          )}

          {!isLoading && items.length > 0 && filtered.length === 0 && (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title="No matches"
              description={`Nothing in the trash matches “${query.trim()}”.`}
            />
          )}

          {groups.map((g) => {
            const GroupIcon = g.icon;
            return (
              <section key={g.key} className="mb-6" aria-label={g.label}>
                <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  <GroupIcon className="h-3.5 w-3.5" />
                  {g.label}
                  <span className="font-normal normal-case tracking-normal">· {g.items.length}</span>
                  {g.key === "drive" && (
                    <Link to="/files/trash" className="ml-auto font-normal normal-case tracking-normal text-[var(--accent-text)] hover:underline">
                      Open in Files
                    </Link>
                  )}
                </h2>
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
                  {g.items.map((it) => (
                    <TrashRow
                      key={`${it.type}:${it.id}`}
                      it={it}
                      busy={busy.has(it.id)}
                      onRestore={() => void restore(it)}
                      onDeleteForever={() => void deleteForever(it)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

function TrashRow({
  it,
  busy,
  onRestore,
  onDeleteForever,
}: {
  it: TrashItem;
  busy: boolean;
  onRestore: () => void;
  onDeleteForever: () => void;
}) {
  const Icon = iconFor(it);
  const left = daysLeft(it.expires_at);
  return (
    <li className={cn("flex items-center gap-3 px-3 py-2.5 transition", busy ? "opacity-60" : "hover:bg-[var(--hover)]")}>
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/10 text-[var(--accent-text)]">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--text)]">
          {it.title || "Untitled"}
          {it.count ? <span className="font-normal text-[var(--text-muted)]"> +{it.count}</span> : null}
        </span>
        <span className="block truncate text-xs text-[var(--text-muted)]">
          {kindLabel(it)}
          {it.location ? ` · from ${it.location}` : ""} · deleted {formatRelativeTime(it.deleted_at)} ·{" "}
          {left === 0 ? "goes today" : `${left} day${left === 1 ? "" : "s"} left`}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onRestore}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Restore"
          aria-label={`Restore ${it.title}`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Restore</span>
        </button>
        <button
          type="button"
          onClick={onDeleteForever}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--danger)] transition hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Delete forever"
          aria-label={`Delete ${it.title} forever`}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Delete forever</span>
        </button>
      </div>
    </li>
  );
}
