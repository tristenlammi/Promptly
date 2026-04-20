import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  RotateCcw,
  Target,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { ExamBreakdown } from "@/components/study/ExamBreakdown";
import { FinalExamCard } from "@/components/study/FinalExamCard";
import { PrereqBatchBanner } from "@/components/study/PrereqBatchBanner";
import { TopNav } from "@/components/layout/TopNav";
import { UnitCard } from "@/components/study/UnitCard";
import {
  useArchiveStudyProject,
  useDeleteStudyProject,
  useEnterStudyUnit,
  useRegenerateStudyPlan,
  useStartFinalExam,
  useStudyProjectQuery,
  useUnarchiveStudyProject,
} from "@/hooks/useStudy";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

export function StudyTopicPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const { data: project, isLoading, error, refetch } = useStudyProjectQuery(
    projectId ?? null
  );
  const enterUnit = useEnterStudyUnit();
  const startExam = useStartFinalExam();
  const regenerate = useRegenerateStudyPlan();
  const deleteMutation = useDeleteStudyProject();
  const archiveMutation = useArchiveStudyProject();
  const unarchiveMutation = useUnarchiveStudyProject();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleOpenUnit = useCallback(
    async (unitId: string) => {
      setLocalError(null);
      try {
        const resp = await enterUnit.mutateAsync(unitId);
        navigate(`/study/sessions/${resp.session.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLocalError(msg);
      }
    },
    [enterUnit, navigate]
  );

  const handleStartExam = useCallback(async () => {
    if (!projectId) return;
    setLocalError(null);
    try {
      const resp = await startExam.mutateAsync({ projectId });
      navigate(`/study/sessions/${resp.session.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
    }
  }, [projectId, startExam, navigate]);

  const handleRegenerate = useCallback(async () => {
    if (!projectId) return;
    setLocalError(null);
    try {
      await regenerate.mutateAsync({ id: projectId });
      setRegenerateOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
      setRegenerateOpen(false);
    }
  }, [projectId, regenerate]);

  const handleDelete = useCallback(async () => {
    if (!projectId) return;
    await deleteMutation.mutateAsync(projectId);
    navigate("/study");
  }, [projectId, deleteMutation, navigate]);

  const handleArchive = useCallback(async () => {
    if (!projectId) return;
    await archiveMutation.mutateAsync(projectId);
    setArchiveOpen(false);
  }, [projectId, archiveMutation]);

  const handleUnarchive = useCallback(async () => {
    if (!projectId) return;
    await unarchiveMutation.mutateAsync(projectId);
  }, [projectId, unarchiveMutation]);

  if (!projectId) return null;

  if (isLoading) {
    return (
      <>
        <TopNav title="Loading..." />
        <div className="flex-1 p-6 text-sm text-[var(--text-muted)]">
          Loading topic...
        </div>
      </>
    );
  }

  if (error || !project) {
    return (
      <>
        <TopNav title="Topic not found" />
        <div className="flex-1 p-6">
          <div className="rounded-card border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">
            Couldn't load this study topic.
          </div>
          <Button className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </>
    );
  }

  const isArchived = project.status === "archived";
  const isPlanning = project.status === "planning";
  const completedUnits = project.units.filter((u) => u.status === "completed")
    .length;
  const progressPct =
    project.total_units > 0
      ? Math.round((completedUnits / project.total_units) * 100)
      : 0;

  return (
    <>
      <TopNav
        title={project.title}
        subtitle={
          [
            project.difficulty,
            project.current_level ? levelBadgeLabel(project.current_level) : null,
            `${project.total_units} units`,
          ]
            .filter(Boolean)
            .join(" · ")
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/study")}
              aria-label="Back to Study"
              title="Back to Study"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-input border",
                "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
                "hover:bg-black/[0.03] hover:text-[var(--text)] dark:hover:bg-white/[0.04]",
                isMobile
                  ? "h-9 w-9 justify-center"
                  : "px-2.5 py-1.5 text-xs"
              )}
            >
              <ArrowLeft className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
              {!isMobile && "Back"}
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          {/* Overview */}
          <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {project.goal && (
                  <div className="mb-2 flex items-start gap-2 text-sm text-[var(--text-muted)]">
                    <Target className="mt-0.5 h-4 w-4 flex-none text-[var(--accent)]" />
                    <span className="italic">Goal: {project.goal}</span>
                  </div>
                )}
                {project.learning_request && (
                  <p className="line-clamp-3 text-sm text-[var(--text-muted)]">
                    {project.learning_request}
                  </p>
                )}
                {project.total_units > 0 && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                      <span>
                        Progress · {completedUnits}/{project.total_units}
                      </span>
                      <span>{progressPct}%</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--border)]/40">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          project.status === "completed"
                            ? "bg-emerald-500"
                            : "bg-[var(--accent)]"
                        )}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-none flex-col items-end gap-1.5">
                {!isArchived ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Archive className="h-3.5 w-3.5" />}
                    onClick={() => setArchiveOpen(true)}
                  >
                    Archive
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
                    onClick={handleUnarchive}
                    loading={unarchiveMutation.isPending}
                  >
                    Unarchive
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => setDeleteOpen(true)}
                  className="text-red-600 hover:bg-red-500/10 dark:text-red-400"
                >
                  Delete
                </Button>
              </div>
            </div>
          </section>

          {localError && (
            <div
              role="alert"
              className="mt-4 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
            >
              {localError}
            </div>
          )}

          {project.units.length > 0 && (
            <PrereqBatchBanner projectId={project.id} units={project.units} />
          )}

          {/* Planning / error state */}
          {isPlanning && (
            <div className="mt-6 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center">
              <h3 className="text-sm font-semibold">
                Plan generation didn't finish
              </h3>
              <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-muted)]">
                {project.planning_error ||
                  "The planner couldn't produce a plan. You can try again with the same model, or regenerate later."}
              </p>
              <Button
                variant="primary"
                size="sm"
                className="mt-4"
                leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={handleRegenerate}
                loading={regenerate.isPending}
              >
                Regenerate plan
              </Button>
            </div>
          )}

          {/* Final exam card — show above units when unlocked or completed
              so it's visible without scrolling. */}
          {(project.final_exam_unlocked ||
            project.exams.length > 0 ||
            project.status === "completed") && (
            <section className="mt-6">
              <FinalExamCard
                project={project}
                startPending={startExam.isPending}
                onStart={handleStartExam}
                onResume={(examId) => {
                  const exam = project.exams.find((e) => e.id === examId);
                  if (exam?.session_id) {
                    navigate(`/study/sessions/${exam.session_id}`);
                  } else {
                    void handleStartExam();
                  }
                }}
                onRetry={handleStartExam}
              />
            </section>
          )}

          {project.exams.length > 0 && (
            <ExamBreakdown exams={project.exams} units={project.units} />
          )}

          {/* Units grid */}
          {project.units.length > 0 && (
            <section className="mt-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Units</h2>
                {!isArchived && project.status !== "completed" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                    onClick={() => setRegenerateOpen(true)}
                    loading={regenerate.isPending}
                    title="Replace the current plan with a fresh one"
                  >
                    Regenerate plan
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {project.units.map((u) => (
                  <UnitCard
                    key={u.id}
                    unit={u}
                    onOpen={() => handleOpenUnit(u.id)}
                    disabled={isArchived || enterUnit.isPending}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <ConfirmDoubleModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        destructive
        pending={deleteMutation.isPending}
        firstTitle="Delete this study topic?"
        firstDescription={
          `"${project.title}" and everything inside it — units, chat history, exams — will be permanently deleted. This cannot be undone.`
        }
        firstConfirmLabel="Continue"
        secondTitle="Delete permanently"
        secondDescription={`Type the topic title to confirm permanent deletion of "${project.title}".`}
        typeToConfirm={project.title}
        secondConfirmLabel="Delete topic"
      />

      <ConfirmDoubleModal
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={handleArchive}
        pending={archiveMutation.isPending}
        firstTitle="Archive this topic?"
        firstDescription={
          `"${project.title}" will move to your archive. It stays readable there and you can unarchive it any time — but you won't be able to chat with the tutor or take the exam until you do.`
        }
        firstConfirmLabel="Continue"
        secondTitle="Confirm archive"
        secondDescription={`Archive "${project.title}" now?`}
        secondConfirmLabel="Archive topic"
      />

      <ConfirmDoubleModal
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        onConfirm={handleRegenerate}
        destructive
        pending={regenerate.isPending}
        firstTitle="Regenerate the study plan?"
        firstDescription={buildRegenerateWarning({
          totalUnits: project.total_units,
          completedUnits,
          inProgress: project.units.some((u) => u.status === "in_progress"),
          examAttempts: project.exams.length,
        })}
        firstConfirmLabel="Continue"
        secondTitle="Replace the plan"
        secondDescription="The AI will re-read your original brief and produce a brand-new set of units. This can't be undone."
        secondConfirmLabel="Regenerate plan"
      />
    </>
  );
}

/** Build a context-aware warning for the regenerate-plan modal so the
 *  user sees exactly what progress is on the line. Phrased in full
 *  sentences so it reads well in the modal body and doesn't feel like
 *  a templated checklist. */
/** Display label for the student's self-reported level. Falls back to
 *  a sensible title-case of the raw value for any future additions. */
function levelBadgeLabel(level: string): string {
  switch (level) {
    case "beginner":
      return "Beginner";
    case "some_exposure":
      return "Some exposure";
    case "refresher":
      return "Refresher";
    default:
      return level.replace(/_/g, " ");
  }
}

function buildRegenerateWarning({
  totalUnits,
  completedUnits,
  inProgress,
  examAttempts,
}: {
  totalUnits: number;
  completedUnits: number;
  inProgress: boolean;
  examAttempts: number;
}): string {
  const lost: string[] = [];
  if (completedUnits > 0) {
    lost.push(
      `${completedUnits} completed unit${completedUnits === 1 ? "" : "s"}`
    );
  }
  if (inProgress) {
    lost.push("any in-progress tutor work");
  }
  if (examAttempts > 0) {
    lost.push(
      `${examAttempts} final-exam attempt${examAttempts === 1 ? "" : "s"}`
    );
  }

  const base = `All ${totalUnits} current unit${
    totalUnits === 1 ? "" : "s"
  } will be deleted and the AI will build a fresh plan from your original brief.`;

  if (lost.length === 0) {
    return `${base} You haven't made any progress yet, so this is safe — but it will give you a different set of units.`;
  }

  const joined =
    lost.length === 1
      ? lost[0]
      : lost.length === 2
        ? `${lost[0]} and ${lost[1]}`
        : `${lost.slice(0, -1).join(", ")}, and ${lost[lost.length - 1]}`;

  return `${base} You'll lose ${joined}. Past tutor chats stay in your history but are no longer linked to any unit.`;
}
