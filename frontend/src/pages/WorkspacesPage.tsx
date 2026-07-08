import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArrowUpDown,
  LayoutGrid,
  Plus,
  Search,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { useIsMobile } from "@/hooks/useIsMobile";
import { WorkspaceCard } from "@/components/workspaces/WorkspaceCard";
import { WorkspaceMobileGate } from "@/components/workspaces/WorkspaceMobileGate";
import { NewWorkspaceModal } from "@/components/workspaces/NewWorkspaceModal";
import { TopNav } from "@/components/layout/TopNav";
import {
  useArchiveWorkspace,
  useWorkspaces,
  useDeleteWorkspace,
  useUnarchiveWorkspace,
} from "@/hooks/useWorkspaces";
import type { WorkspaceSummary } from "@/api/workspaces";
import { cn } from "@/utils/cn";

type Tab = "active" | "archived";
type SortKey = "updated" | "created" | "title" | "content";

const SORT_LABELS: Record<SortKey, string> = {
  updated: "Recently updated",
  created: "Recently created",
  title: "Title A–Z",
  content: "Most content",
};

/** Workspaces home — tabbed (Active / Archive), mirrors the Study page
 * layout so users don't need to relearn the pattern. */
export function WorkspacesPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("active");

  const { data: activeWorkspaces, isLoading: activeLoading } = useWorkspaces({
    archived: false,
  });
  const { data: archivedWorkspaces, isLoading: archivedLoading } = useWorkspaces(
    { archived: true }
  );

  const [deleteTarget, setDeleteTarget] =
    useState<WorkspaceSummary | null>(null);
  const [archiveTarget, setArchiveTarget] =
    useState<WorkspaceSummary | null>(null);

  const deleteMutation = useDeleteWorkspace();
  const archiveMutation = useArchiveWorkspace();
  const unarchiveMutation = useUnarchiveWorkspace();

  const workspaces =
    tab === "active" ? activeWorkspaces ?? [] : archivedWorkspaces ?? [];
  const isLoading = tab === "active" ? activeLoading : archivedLoading;

  // Hub sort + filter (7.5). Client-side: the payload is already the
  // full list, so there's nothing to gain from a round-trip.
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const shown = useMemo(() => {
    let list = workspaces;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (w) =>
          w.title.toLowerCase().includes(q) ||
          (w.description ?? "").toLowerCase().includes(q) ||
          (w.member_names ?? []).some((n) => n.toLowerCase().includes(q))
      );
    }
    const contentOf = (w: WorkspaceSummary) =>
      Object.values(w.item_counts ?? {}).reduce((a, b) => a + b, 0) +
      w.conversation_count;
    return [...list].sort((a, b) => {
      switch (sort) {
        case "title":
          return a.title.localeCompare(b.title);
        case "created":
          return +new Date(b.created_at) - +new Date(a.created_at);
        case "content":
          return contentOf(b) - contentOf(a);
        default:
          return +new Date(b.updated_at) - +new Date(a.updated_at);
      }
    });
  }, [workspaces, query, sort]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteMutation.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    await archiveMutation.mutateAsync(archiveTarget.id);
    setArchiveTarget(null);
  };

  // Desktop-only surface by design — direct links on a phone get a
  // friendly explanation instead of a broken layout.
  if (isMobile) return <WorkspaceMobileGate />;

  return (
    <>
      <TopNav
        title="Workspaces"
        subtitle="Project spaces — notes, boards, sheets, canvases, chats, and automations, with an AI that knows all of it"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setWizardOpen(true)}
            >
              New workspace
            </Button>
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]">
            <Tabs
              tab={tab}
              onChange={setTab}
              activeCount={activeWorkspaces?.length ?? 0}
              archivedCount={archivedWorkspaces?.length ?? 0}
            />
            <div className="flex items-center gap-2 pb-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter workspaces…"
                  className="w-44 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-7 pr-2 text-xs text-[var(--text)] outline-none transition focus:border-[var(--accent)]"
                />
              </div>
              <div className="relative">
                <ArrowUpDown className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  title="Sort workspaces"
                  className="appearance-none rounded-md border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-7 pr-6 text-xs text-[var(--text)] outline-none transition focus:border-[var(--accent)]"
                >
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <option key={k} value={k}>
                      {SORT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="mt-10 text-sm text-[var(--text-muted)]">
              Loading workspaces...
            </div>
          ) : workspaces.length === 0 ? (
            <EmptyState tab={tab} onNewWorkspace={() => setWizardOpen(true)} />
          ) : shown.length === 0 ? (
            <div className="mt-10 text-center text-sm text-[var(--text-muted)]">
              No workspace matches “{query}”.
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((p) => (
                <WorkspaceCard
                  key={p.id}
                  workspace={p}
                  onOpen={() => navigate(`/workspaces/${p.id}`)}
                  onDelete={() => setDeleteTarget(p)}
                  onArchive={
                    !p.archived_at ? () => setArchiveTarget(p) : undefined
                  }
                  onUnarchive={
                    p.archived_at
                      ? () => unarchiveMutation.mutate(p.id)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <NewWorkspaceModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(id) => navigate(`/workspaces/${id}`)}
      />

      <ConfirmDoubleModal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        destructive
        pending={deleteMutation.isPending}
        firstTitle="Delete this workspace?"
        firstDescription={
          deleteTarget
            ? `"${deleteTarget.title}" will be deleted. Conversations inside it are preserved — they'll move back to your top-level chat list. Pinned files stay in your library. This cannot be undone.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Delete permanently"
        secondDescription={
          deleteTarget
            ? `Type the workspace title to confirm permanent deletion of "${deleteTarget.title}".`
            : ""
        }
        typeToConfirm={deleteTarget?.title}
        secondConfirmLabel="Delete workspace"
      />

      <ConfirmDoubleModal
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        onConfirm={handleArchive}
        pending={archiveMutation.isPending}
        firstTitle="Archive this workspace?"
        firstDescription={
          archiveTarget
            ? `"${archiveTarget.title}" will move to your archive. Conversations inside it stay readable; you can unarchive the workspace any time.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Confirm archive"
        secondDescription={
          archiveTarget ? `Archive "${archiveTarget.title}" now?` : ""
        }
        secondConfirmLabel="Archive workspace"
      />
    </>
  );
}

function Tabs({
  tab,
  onChange,
  activeCount,
  archivedCount,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  activeCount: number;
  archivedCount: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <TabButton
        active={tab === "active"}
        onClick={() => onChange("active")}
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        label="Active"
        count={activeCount}
      />
      <TabButton
        active={tab === "archived"}
        onClick={() => onChange("archived")}
        icon={<Archive className="h-3.5 w-3.5" />}
        label="Archive"
        count={archivedCount}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative -mb-px inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition",
        active
          ? "border-b-2 border-[var(--accent)] text-[var(--text)]"
          : "border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {icon}
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px]",
          active
            ? "bg-[var(--accent)]/15 text-[var(--accent)]"
            : "bg-[var(--border)]/40 text-[var(--text-muted)]"
        )}
      >
        {count}
      </span>
    </button>
  );
}

function EmptyState({
  tab,
  onNewWorkspace,
}: {
  tab: Tab;
  onNewWorkspace: () => void;
}) {
  if (tab === "archived") {
    return (
      <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <Archive className="h-5 w-5 text-[var(--accent)]" />
        </div>
        <h2 className="text-lg font-semibold">Archive is empty</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
          Workspaces you archive end up here. Archive one from its detail page or
          the card action bar.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
        <LayoutGrid className="h-5 w-5 text-[var(--accent)]" />
      </div>
      <h2 className="text-lg font-semibold">Create your first workspace</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
        A workspace is a project home: notes, boards, sheets, canvases, files,
        chats, and automations in one place — and every chat inside it
        understands the whole project.
      </p>
      <div className="mt-6">
        <Button
          variant="primary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={onNewWorkspace}
        >
          New workspace
        </Button>
      </div>
    </div>
  );
}
