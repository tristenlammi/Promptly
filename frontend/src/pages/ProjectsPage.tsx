import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, FolderKanban, Plus, Upload } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { ChatProjectCard } from "@/components/projects/ChatProjectCard";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { NewChatProjectModal } from "@/components/projects/NewChatProjectModal";
import { TopNav } from "@/components/layout/TopNav";
import {
  useArchiveChatProject,
  useChatProjects,
  useDeleteChatProject,
  useUnarchiveChatProject,
} from "@/hooks/useChatProjects";
import type { ChatProjectSummary } from "@/api/chatProjects";
import { cn } from "@/utils/cn";

type Tab = "active" | "archived";

/** Projects home — tabbed (Active / Archive), mirrors the Study page
 * layout so users don't need to relearn the pattern. */
export function ProjectsPage() {
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("active");

  const { data: activeProjects, isLoading: activeLoading } = useChatProjects({
    archived: false,
  });
  const { data: archivedProjects, isLoading: archivedLoading } = useChatProjects(
    { archived: true }
  );

  const [deleteTarget, setDeleteTarget] =
    useState<ChatProjectSummary | null>(null);
  const [archiveTarget, setArchiveTarget] =
    useState<ChatProjectSummary | null>(null);

  const deleteMutation = useDeleteChatProject();
  const archiveMutation = useArchiveChatProject();
  const unarchiveMutation = useUnarchiveChatProject();

  const projects =
    tab === "active" ? activeProjects ?? [] : archivedProjects ?? [];
  const isLoading = tab === "active" ? activeLoading : archivedLoading;

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

  return (
    <>
      <TopNav
        title="Projects"
        subtitle="Group conversations with shared instructions and files"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={() => setImportOpen(true)}
            >
              Import
            </Button>
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setWizardOpen(true)}
            >
              New project
            </Button>
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          <Tabs
            tab={tab}
            onChange={setTab}
            activeCount={activeProjects?.length ?? 0}
            archivedCount={archivedProjects?.length ?? 0}
          />

          {isLoading ? (
            <div className="mt-10 text-sm text-[var(--text-muted)]">
              Loading projects...
            </div>
          ) : projects.length === 0 ? (
            <EmptyState tab={tab} onNewProject={() => setWizardOpen(true)} />
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <ChatProjectCard
                  key={p.id}
                  project={p}
                  onOpen={() => navigate(`/projects/${p.id}`)}
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

      <NewChatProjectModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(id) => navigate(`/projects/${id}`)}
      />

      <ImportConversationsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />

      <ConfirmDoubleModal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        destructive
        pending={deleteMutation.isPending}
        firstTitle="Delete this project?"
        firstDescription={
          deleteTarget
            ? `"${deleteTarget.title}" will be deleted. Conversations inside it are preserved — they'll move back to your top-level chat list. Pinned files stay in your library. This cannot be undone.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Delete permanently"
        secondDescription={
          deleteTarget
            ? `Type the project title to confirm permanent deletion of "${deleteTarget.title}".`
            : ""
        }
        typeToConfirm={deleteTarget?.title}
        secondConfirmLabel="Delete project"
      />

      <ConfirmDoubleModal
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        onConfirm={handleArchive}
        pending={archiveMutation.isPending}
        firstTitle="Archive this project?"
        firstDescription={
          archiveTarget
            ? `"${archiveTarget.title}" will move to your archive. Conversations inside it stay readable; you can unarchive the project any time.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Confirm archive"
        secondDescription={
          archiveTarget ? `Archive "${archiveTarget.title}" now?` : ""
        }
        secondConfirmLabel="Archive project"
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
    <div className="flex items-center gap-1 border-b border-[var(--border)]">
      <TabButton
        active={tab === "active"}
        onClick={() => onChange("active")}
        icon={<FolderKanban className="h-3.5 w-3.5" />}
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
  onNewProject,
}: {
  tab: Tab;
  onNewProject: () => void;
}) {
  if (tab === "archived") {
    return (
      <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <Archive className="h-5 w-5 text-[var(--accent)]" />
        </div>
        <h2 className="text-lg font-semibold">Archive is empty</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
          Projects you archive end up here. Archive one from its detail page or
          the card action bar.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
        <FolderKanban className="h-5 w-5 text-[var(--accent)]" />
      </div>
      <h2 className="text-lg font-semibold">Create your first project</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
        A project gathers related chats under one roof with a shared system
        prompt, pinned reference files, and a default model.
      </p>
      <div className="mt-6">
        <Button
          variant="primary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={onNewProject}
        >
          New project
        </Button>
      </div>
    </div>
  );
}
