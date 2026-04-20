import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, BookOpen, Plus } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { NewStudyWizard } from "@/components/study/NewStudyWizard";
import { StudyTopicCard } from "@/components/study/StudyTopicCard";
import { TopNav } from "@/components/layout/TopNav";
import {
  useArchiveStudyProject,
  useDeleteStudyProject,
  useStudyProjectsQuery,
  useUnarchiveStudyProject,
} from "@/hooks/useStudy";
import type { StudyProjectSummary } from "@/api/types";
import { cn } from "@/utils/cn";

type Tab = "active" | "archived";

export function StudyPage() {
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("active");

  const { data: activeProjects, isLoading: activeLoading } =
    useStudyProjectsQuery({});
  const { data: archivedProjects, isLoading: archivedLoading } =
    useStudyProjectsQuery({ status: "archived" });

  const [deleteTarget, setDeleteTarget] = useState<StudyProjectSummary | null>(
    null
  );
  const [archiveTarget, setArchiveTarget] = useState<
    StudyProjectSummary | null
  >(null);

  const deleteMutation = useDeleteStudyProject();
  const archiveMutation = useArchiveStudyProject();
  const unarchiveMutation = useUnarchiveStudyProject();

  const projects =
    tab === "active" ? activeProjects ?? [] : archivedProjects ?? [];
  const isLoading = tab === "active" ? activeLoading : archivedLoading;

  const handleOpenProject = (projectId: string) => {
    navigate(`/study/topics/${projectId}`);
  };

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
        title="Study"
        subtitle="Structured AI-powered study topics built from your goals"
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setWizardOpen(true)}
          >
            New topic
          </Button>
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
              Loading study topics...
            </div>
          ) : projects.length === 0 ? (
            <EmptyState tab={tab} onNewTopic={() => setWizardOpen(true)} />
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <StudyTopicCard
                  key={p.id}
                  project={p}
                  onOpen={() => handleOpenProject(p.id)}
                  onDelete={() => setDeleteTarget(p)}
                  onArchive={
                    p.status !== "archived"
                      ? () => setArchiveTarget(p)
                      : undefined
                  }
                  onUnarchive={
                    p.status === "archived"
                      ? () => unarchiveMutation.mutate(p.id)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <NewStudyWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
      />

      <ConfirmDoubleModal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        destructive
        pending={deleteMutation.isPending}
        firstTitle="Delete this study topic?"
        firstDescription={
          deleteTarget
            ? `"${deleteTarget.title}" and everything inside it — units, chat history, exams — will be permanently deleted. This cannot be undone.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Delete permanently"
        secondDescription={
          deleteTarget
            ? `Type the topic title to confirm permanent deletion of "${deleteTarget.title}".`
            : ""
        }
        typeToConfirm={deleteTarget?.title}
        secondConfirmLabel="Delete topic"
      />

      <ConfirmDoubleModal
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        onConfirm={handleArchive}
        pending={archiveMutation.isPending}
        firstTitle="Archive this topic?"
        firstDescription={
          archiveTarget
            ? `"${archiveTarget.title}" will move to your archive. It stays readable there and you can unarchive it any time — but you won't be able to chat with the tutor or take the exam until you do.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Confirm archive"
        secondDescription={
          archiveTarget
            ? `Archive "${archiveTarget.title}" now?`
            : ""
        }
        secondConfirmLabel="Archive topic"
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
        icon={<BookOpen className="h-3.5 w-3.5" />}
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
  onNewTopic,
}: {
  tab: Tab;
  onNewTopic: () => void;
}) {
  if (tab === "archived") {
    return (
      <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <Archive className="h-5 w-5 text-[var(--accent)]" />
        </div>
        <h2 className="text-lg font-semibold">Archive is empty</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
          Topics you finish end up here. You can archive a completed topic
          from its detail page.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
        <BookOpen className="h-5 w-5 text-[var(--accent)]" />
      </div>
      <h2 className="text-lg font-semibold">Start your first study topic</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
        Tell Promptly what you want to learn. An AI tutor will design a plan
        of focused units, teach you one at a time, check your understanding,
        and finish with a timed final exam.
      </p>
      <div className="mt-6">
        <Button
          variant="primary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={onNewTopic}
        >
          New topic
        </Button>
      </div>
    </div>
  );
}
