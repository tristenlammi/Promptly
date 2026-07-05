import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Archive,
  CheckCircle2,
  ChevronRight,
  Download,
  FileText,
  GraduationCap,
  Grid3X3,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Send,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";

import {
  courseApi,
  type CourseDetail,
  type CourseSummary,
  type CourseUnitPayload,
} from "@/api/study";
import { workspacesApi } from "@/api/workspaces";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { useWorkspace, useWorkspaces } from "@/hooks/useWorkspaces";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/** Team Learning — course authoring, assignment, and team progress.
 *
 * Lives on the Study page (a course is still *scoped* to a workspace —
 * its materials, members, and permissions come from there — but the
 * surface belongs to Study, not the workspace UI). A lead drafts a
 * course from workspace materials with the AI, edits the blueprint (the
 * human sign-off), publishes it, and assigns it to members.
 */
export function CoursesPane({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const [view, setView] = useState<
    { kind: "list" } | { kind: "new" } | { kind: "course"; id: string }
  >({ kind: "list" });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-6">
        {view.kind === "list" && (
          <CourseList
            workspaceId={workspaceId}
            canEdit={canEdit}
            onNew={() => setView({ kind: "new" })}
            onOpen={(id) => setView({ kind: "course", id })}
          />
        )}
        {view.kind === "new" && (
          <NewCourseForm
            workspaceId={workspaceId}
            onCancel={() => setView({ kind: "list" })}
            onCreated={(id) => setView({ kind: "course", id })}
          />
        )}
        {view.kind === "course" && (
          <CourseEditor
            courseId={view.id}
            canEdit={canEdit}
            onBack={() => setView({ kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}

// ====================================================================
// Course list
// ====================================================================
function CourseList({
  workspaceId,
  canEdit,
  onNew,
  onOpen,
}: {
  workspaceId: string;
  canEdit: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const { data: courses, isLoading } = useQuery({
    queryKey: ["workspace-courses", workspaceId],
    queryFn: () => courseApi.list(workspaceId),
  });

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
          <GraduationCap className="h-5 w-5 text-[var(--accent)]" />
          Team courses
        </h2>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={onNew} leftIcon={<Plus className="h-4 w-4" />}>
            New course
          </Button>
        )}
      </div>
      <p className="mb-5 text-sm text-[var(--text-muted)]">
        Courses this team authors from its own materials and assigns to
        members. AI drafts the curriculum; you review, edit, and publish it.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading courses…
        </div>
      ) : !courses || courses.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-6 py-10 text-center">
          <GraduationCap className="mx-auto h-8 w-8 text-[var(--text-muted)]" />
          <h3 className="mt-3 text-sm font-semibold text-[var(--text)]">
            No courses yet
          </h3>
          <p className="mx-auto mt-1 max-w-sm text-xs text-[var(--text-muted)]">
            Turn this workspace's docs, runbooks, or codebase notes into an
            onboarding course: the AI drafts a unit plan from files you pick,
            you edit and approve it, then assign it to teammates.
          </p>
          {canEdit && (
            <Button variant="primary" size="sm" className="mt-4" onClick={onNew}>
              Create the first course
            </Button>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {courses.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="flex w-full items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left transition hover:border-[var(--accent)]/40 hover:bg-[var(--hover)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--text)]">
                      {c.title}
                    </span>
                    <StatusChip status={c.status} error={c.drafting_error} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                    {c.unit_count} unit{c.unit_count === 1 ? "" : "s"} ·{" "}
                    {c.enrollment_count} enrolled
                    {c.difficulty_preset
                      ? ` · ${presetLabel(c.difficulty_preset)}`
                      : ""}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {canEdit && courses && courses.length > 0 && (
        <CompetencySection workspaceId={workspaceId} />
      )}
    </div>
  );
}

/** Competency matrix (L3): members × courses — "who on the team knows
 *  what". Same measured-only contract as the per-course dashboard. */
function CompetencySection({ workspaceId }: { workspaceId: string }) {
  const { data: matrix } = useQuery({
    queryKey: ["workspace-competency", workspaceId],
    queryFn: () => courseApi.competency(workspaceId),
  });

  if (!matrix || matrix.courses.length === 0 || matrix.members.length === 0)
    return null;

  const exportCsv = () => {
    const header = [
      "Member",
      ...matrix.courses.map((c) => `"${c.title.replace(/"/g, '""')}"`),
    ];
    const lines = matrix.members.map((m) => {
      const cells = matrix.courses.map((c) => {
        const cell = m.cells.find((x) => x.course_id === c.id);
        if (!cell) return "";
        if (cell.status === "completed")
          return cell.exam_score != null
            ? `completed (${cell.exam_score}/100)`
            : "completed";
        return cell.overall_mastery != null
          ? `${cell.status} (${cell.overall_mastery} mastery)`
          : cell.status;
      });
      return [`"${(m.username ?? "member").replace(/"/g, '""')}"`, ...cells]
        .join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "team-competency.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mt-8 border-t border-[var(--border)] pt-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Grid3X3 className="h-4 w-4 text-[var(--accent)]" />
          Team competency
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={exportCsv}
          leftIcon={<Download className="h-4 w-4" />}
        >
          Export CSV
        </Button>
      </div>
      <p className="mb-3 text-[11px] text-[var(--text-muted)]">
        Who's covered what, across every course in this workspace. ✓ = passed
        the final exam (independently graded).
      </p>
      <div className="overflow-x-auto rounded-card border border-[var(--border)]">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--surface)] text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-3 py-2 font-medium">Member</th>
              {matrix.courses.map((c) => (
                <th
                  key={c.id}
                  className="max-w-[9rem] truncate px-3 py-2 font-medium"
                  title={c.title}
                >
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.members.map((m) => (
              <tr
                key={m.user_id}
                className="border-b border-[var(--border)] last:border-b-0"
              >
                <td className="px-3 py-2 font-medium text-[var(--text)]">
                  {m.username ?? "member"}
                </td>
                {matrix.courses.map((c) => {
                  const cell = m.cells.find((x) => x.course_id === c.id);
                  if (!cell)
                    return (
                      <td
                        key={c.id}
                        className="px-3 py-2 text-[var(--text-muted)]"
                      >
                        —
                      </td>
                    );
                  return (
                    <td key={c.id} className="px-3 py-2">
                      {cell.status === "completed" ? (
                        <span
                          className="font-medium text-emerald-600 dark:text-emerald-400"
                          title={
                            cell.exam_score != null
                              ? `Final exam: ${cell.exam_score}/100`
                              : "Completed"
                          }
                        >
                          ✓{cell.exam_score != null ? ` ${cell.exam_score}` : ""}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            cell.status === "overdue"
                              ? "text-red-600 dark:text-red-400"
                              : "text-[var(--text-muted)]"
                          )}
                          title={
                            cell.overall_mastery != null
                              ? `Mastery so far: ${cell.overall_mastery}/100`
                              : undefined
                          }
                        >
                          {cell.status.replace("_", " ")}
                          {cell.overall_mastery != null
                            ? ` · ${cell.overall_mastery}`
                            : ""}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusChip({
  status,
  error,
}: {
  status: CourseSummary["status"];
  error?: string | null;
}) {
  if (error) {
    return (
      <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
        draft failed
      </span>
    );
  }
  const styles: Record<string, string> = {
    draft:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    published:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    archived: "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
  };
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        styles[status] ?? styles.archived
      )}
    >
      {status}
    </span>
  );
}

function presetLabel(preset: string): string {
  return (
    {
      beginner: "for beginners",
      some_exposure: "some exposure",
      refresher: "refresher",
    }[preset] ?? preset
  );
}

// ====================================================================
// New course form
// ====================================================================
const PRESETS = [
  { value: "beginner", label: "Beginner", hint: "Assume no prior exposure." },
  {
    value: "some_exposure",
    label: "Some exposure",
    hint: "They know the basics; go deeper.",
  },
  {
    value: "refresher",
    label: "Refresher",
    hint: "They've done this before; firm it up.",
  },
] as const;

function NewCourseForm({
  workspaceId,
  onCancel,
  onCreated,
}: {
  workspaceId: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [preset, setPreset] = useState<string | null>(null);
  const [fileIds, setFileIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { data: drive } = useQuery({
    queryKey: ["workspace-drive", workspaceId],
    queryFn: () => workspacesApi.getDrive(workspaceId),
  });

  const create = useMutation({
    mutationFn: () =>
      courseApi.create({
        workspace_id: workspaceId,
        title: title.trim(),
        brief: brief.trim(),
        difficulty_preset: preset,
        source_file_ids: [...fileIds],
        draft_with_ai: true,
      }),
    onSuccess: (course) => {
      void qc.invalidateQueries({ queryKey: ["workspace-courses", workspaceId] });
      onCreated(course.id);
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : "Couldn't create the course."),
  });

  const toggleFile = (id: string) =>
    setFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <button
        type="button"
        onClick={onCancel}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to courses
      </button>
      <h2 className="text-lg font-semibold text-[var(--text)]">New course</h2>
      <p className="mb-5 mt-1 text-sm text-[var(--text-muted)]">
        Describe what the course should teach and pick the workspace files it
        teaches from. The AI drafts a unit plan for you to review — nothing is
        assignable until you publish it.
      </p>

      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Course title
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Onboarding: our deployment pipeline"
            className={inputCls}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            What should it teach?
          </span>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={4}
            placeholder="New engineers should understand how our services are deployed: the CI pipeline, staging vs production, rollbacks, and the runbook for failed deploys."
            className={inputCls}
          />
        </label>

        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Learner starting level
          </span>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() =>
                  setPreset((cur) => (cur === p.value ? null : p.value))
                }
                className={cn(
                  "rounded-card border px-3 py-2 text-left transition",
                  preset === p.value
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]"
                )}
              >
                <span className="block text-xs font-semibold text-[var(--text)]">
                  {p.label}
                </span>
                <span className="block text-[11px] text-[var(--text-muted)]">
                  {p.hint}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Source material (workspace drive)
          </span>
          {!drive || drive.files.length === 0 ? (
            <p className="rounded-card border border-dashed border-[var(--border)] px-3 py-3 text-xs text-[var(--text-muted)]">
              No files in this workspace's drive yet. You can create the course
              without sources, but lessons ground and cite better with real
              material — add docs to the drive first for best results.
            </p>
          ) : (
            <ul className="max-h-52 space-y-1 overflow-y-auto rounded-card border border-[var(--border)] p-2">
              {drive.files.map((f) => (
                <li key={f.file_id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-[var(--hover)]">
                    <input
                      type="checkbox"
                      checked={fileIds.has(f.file_id)}
                      onChange={() => toggleFile(f.file_id)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate text-[var(--text)]">
                      {f.filename}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              if (!title.trim()) return setError("Give the course a title.");
              if (brief.trim().length < 20)
                return setError(
                  "Describe what the course should teach (a couple of sentences)."
                );
              create.mutate();
            }}
            loading={create.isPending}
            leftIcon={<Sparkles className="h-4 w-4" />}
          >
            Create &amp; draft with AI
          </Button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// Course editor
// ====================================================================
type DraftUnit = CourseUnitPayload & { key: string };

function CourseEditor({
  courseId,
  canEdit,
  onBack,
}: {
  courseId: string;
  canEdit: boolean;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const { data: course, refetch } = useQuery({
    queryKey: ["workspace-course", courseId],
    queryFn: () => courseApi.get(courseId),
  });

  // ---- AI draft progress poll (only while a draft is running) ----
  const [drafting, setDrafting] = useState(false);
  const [draftStage, setDraftStage] = useState<string | null>(null);
  const [draftUnits, setDraftUnits] = useState(0);
  useEffect(() => {
    if (!course) return;
    // A fresh draft course with no units and no error → assume the AI
    // draft is (still) running and poll until units land.
    const shouldPoll =
      course.status === "draft" &&
      course.units.length === 0 &&
      !course.drafting_error;
    if (!shouldPoll) {
      setDrafting(false);
      return;
    }
    setDrafting(true);
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const p = await courseApi.draftProgress(courseId);
        if (!alive) return;
        setDraftStage(p.stage);
        setDraftUnits(p.units_drafted);
        if (p.error || (!p.drafting && p.unit_count > 0)) {
          setDrafting(false);
          await refetch();
          return;
        }
        if (!p.drafting && p.unit_count === 0 && !p.error) {
          // Task not running and nothing landed — either a crash that was
          // recorded (error would be set on refetch) or a race; refetch.
          await refetch();
        }
      } catch {
        /* transient */
      }
      if (alive) timer = window.setTimeout(tick, 1200);
    };
    timer = window.setTimeout(tick, 600);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, course?.status, course?.units.length, course?.drafting_error]);

  // ---- Local blueprint edits (draft only) ----
  const [units, setUnits] = useState<DraftUnit[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!course) return;
    setUnits(
      course.units.map((u) => ({
        key: u.id,
        title: u.title,
        description: u.description ?? "",
        learning_objectives: u.learning_objectives,
        source_file_ids: u.source_file_ids,
      }))
    );
    setDirty(false);
  }, [course?.id, course?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["workspace-course", courseId] });
    if (course)
      void qc.invalidateQueries({
        queryKey: ["workspace-courses", course.workspace_id],
      });
  };

  const saveUnits = useMutation({
    mutationFn: () =>
      courseApi.replaceUnits(
        courseId,
        units.map(({ key: _key, ...u }) => u)
      ),
    onSuccess: () => {
      toast.success("Blueprint saved.");
      invalidate();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't save."),
  });

  const publish = useMutation({
    mutationFn: () => courseApi.publish(courseId),
    onSuccess: () => {
      toast.success("Course published — it can now be assigned.");
      invalidate();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't publish."),
  });

  const redraft = useMutation({
    mutationFn: () => courseApi.redraft(courseId),
    onSuccess: () => {
      setDrafting(true);
      invalidate();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't redraft."),
  });

  const archiveCourse = useMutation({
    mutationFn: () => courseApi.archive(courseId),
    onSuccess: () => {
      invalidate();
      onBack();
    },
  });

  const removeCourse = useMutation({
    mutationFn: () => courseApi.remove(courseId),
    onSuccess: () => {
      invalidate();
      onBack();
    },
  });

  if (!course) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading course…
      </div>
    );
  }

  const isDraft = course.status === "draft";
  const editable = canEdit && isDraft && !drafting;

  const patchUnit = (key: string, patch: Partial<CourseUnitPayload>) => {
    setUnits((prev) =>
      prev.map((u) => (u.key === key ? { ...u, ...patch } : u))
    );
    setDirty(true);
  };
  const moveUnit = (key: string, dir: -1 | 1) => {
    setUnits((prev) => {
      const idx = prev.findIndex((u) => u.key === key);
      const to = idx + dir;
      if (idx === -1 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(idx, 1);
      next.splice(to, 0, row);
      return next;
    });
    setDirty(true);
  };
  const removeUnit = (key: string) => {
    setUnits((prev) => prev.filter((u) => u.key !== key));
    setDirty(true);
  };
  const addUnit = () => {
    setUnits((prev) => [
      ...prev,
      {
        key: `new-${Date.now().toString(36)}`,
        title: "",
        description: "",
        learning_objectives: [],
        source_file_ids: [],
      },
    ]);
    setDirty(true);
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to courses
      </button>

      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[var(--text)]">
          {course.title}
        </h2>
        <StatusChip status={course.status} error={course.drafting_error} />
      </div>
      <p className="mb-4 text-sm text-[var(--text-muted)]">{course.brief}</p>

      {/* Actions */}
      {canEdit && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {isDraft && (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  if (dirty) {
                    toast.error("Save the blueprint first, then publish.");
                    return;
                  }
                  void publish.mutate();
                }}
                loading={publish.isPending}
                disabled={drafting || units.length === 0}
                leftIcon={<CheckCircle2 className="h-4 w-4" />}
                title="Lock the blueprint and make the course assignable"
              >
                Publish
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void saveUnits.mutate()}
                loading={saveUnits.isPending}
                disabled={!dirty || drafting}
              >
                Save blueprint
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Redraft with AI",
                    message:
                      "Replace the current unit list with a fresh AI draft? Your edits to the blueprint will be lost.",
                    confirmLabel: "Redraft",
                  });
                  if (ok) void redraft.mutate();
                }}
                disabled={drafting}
                leftIcon={<Sparkles className="h-4 w-4" />}
              >
                Redraft
              </Button>
            </>
          )}
          {course.status !== "archived" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const ok = await confirm({
                  title: "Archive course",
                  message:
                    "Archive this course? Existing learners keep their progress; it just can't be assigned anymore.",
                  confirmLabel: "Archive",
                });
                if (ok) void archiveCourse.mutate();
              }}
              leftIcon={<Archive className="h-4 w-4" />}
            >
              Archive
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-[var(--danger)]"
            onClick={async () => {
              const ok = await confirm({
                title: "Delete course",
                message:
                  "Delete this course? Learners keep their topics and progress — they just detach from the course.",
                confirmLabel: "Delete",
              });
              if (ok) void removeCourse.mutate();
            }}
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            Delete
          </Button>
        </div>
      )}

      {/* AI drafting progress */}
      {drafting && (
        <div className="mb-5 rounded-card border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
            Drafting the curriculum…
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {draftStage === "reading"
              ? "Reading the source material…"
              : draftStage === "building"
              ? "Building the blueprint…"
              : draftUnits > 0
              ? `Drafting unit ${draftUnits}…`
              : "Sketching focused units with clear objectives…"}
          </p>
        </div>
      )}
      {course.drafting_error && !drafting && (
        <div className="mb-5 rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          AI draft failed: {course.drafting_error}
          {canEdit && isDraft && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => void redraft.mutate()}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {/* Blueprint */}
      <h3 className="mb-2 text-sm font-semibold text-[var(--text)]">
        Curriculum{" "}
        <span className="font-normal text-[var(--text-muted)]">
          ({units.length} unit{units.length === 1 ? "" : "s"}
          {isDraft ? " — editable until you publish" : " — locked"})
        </span>
      </h3>
      {units.length === 0 && !drafting ? (
        <p className="rounded-card border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--text-muted)]">
          No units yet. Draft with AI or add units by hand.
        </p>
      ) : (
        <ol className="space-y-2">
          {units.map((u, idx) => (
            <li
              key={u.key}
              className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-start gap-2">
                <span className="mt-1.5 w-6 shrink-0 text-center text-xs font-semibold text-[var(--text-muted)]">
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  {editable ? (
                    <>
                      <input
                        value={u.title}
                        onChange={(e) =>
                          patchUnit(u.key, { title: e.target.value })
                        }
                        placeholder="Unit title"
                        className={cn(inputCls, "font-medium")}
                      />
                      <textarea
                        value={u.description ?? ""}
                        onChange={(e) =>
                          patchUnit(u.key, { description: e.target.value })
                        }
                        rows={2}
                        placeholder="What this unit covers"
                        className={inputCls}
                      />
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-[var(--text-muted)]">
                          Learning objectives (one per line)
                        </span>
                        <textarea
                          value={u.learning_objectives.join("\n")}
                          onChange={(e) =>
                            patchUnit(u.key, {
                              learning_objectives: e.target.value.split("\n"),
                            })
                          }
                          rows={Math.max(2, u.learning_objectives.length)}
                          className={inputCls}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-[var(--text)]">
                        {u.title}
                      </p>
                      {u.description && (
                        <p className="text-xs text-[var(--text-muted)]">
                          {u.description}
                        </p>
                      )}
                      <ul className="list-inside list-disc text-xs text-[var(--text-muted)]">
                        {u.learning_objectives
                          .filter(Boolean)
                          .map((o, i) => (
                            <li key={i}>{o}</li>
                          ))}
                      </ul>
                    </>
                  )}
                </div>
                {editable && (
                  <div className="flex shrink-0 flex-col gap-1">
                    <IconBtn
                      label="Move up"
                      onClick={() => moveUnit(u.key, -1)}
                      disabled={idx === 0}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn
                      label="Move down"
                      onClick={() => moveUnit(u.key, 1)}
                      disabled={idx === units.length - 1}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Remove unit" onClick={() => removeUnit(u.key)}>
                      <Trash2 className="h-3.5 w-3.5 text-[var(--danger)]" />
                    </IconBtn>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {editable && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={addUnit}
          leftIcon={<Plus className="h-4 w-4" />}
        >
          Add unit
        </Button>
      )}

      {/* Assignments (published courses) */}
      {course.status === "published" && canEdit && (
        <AssignSection course={course} />
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ====================================================================
// Assign + progress dashboard + gap inbox (published, L2)
// ====================================================================
function AssignSection({ course }: { course: CourseDetail }) {
  const qc = useQueryClient();
  const { data: workspace } = useWorkspace(course.workspace_id);
  const { data: progress } = useQuery({
    queryKey: ["course-progress", course.id],
    queryFn: () => courseApi.progress(course.id),
    refetchInterval: 30_000,
  });
  const [pickedUser, setPickedUser] = useState("");
  const [dueDate, setDueDate] = useState("");

  const enrolledIds = useMemo(
    () => new Set((progress ?? []).map((r) => r.learner_user_id)),
    [progress]
  );
  const candidates = (workspace?.members ?? []).filter(
    (m) => !enrolledIds.has(m.user_id)
  );

  const enroll = useMutation({
    mutationFn: () =>
      courseApi.enroll(course.id, {
        user_id: pickedUser,
        due_at: dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null,
      }),
    onSuccess: (e) => {
      toast.success(
        `Assigned to ${e.learner_name ?? "member"} — it's now in their Study list.`
      );
      setPickedUser("");
      setDueDate("");
      void qc.invalidateQueries({ queryKey: ["course-progress", course.id] });
      void qc.invalidateQueries({
        queryKey: ["workspace-courses", course.workspace_id],
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Couldn't assign."),
  });

  return (
    <div className="mt-6 border-t border-[var(--border)] pt-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <UserPlus className="h-4 w-4 text-[var(--accent)]" />
        Assignments &amp; progress
      </h3>
      <p className="mb-3 text-[11px] text-[var(--text-muted)]">
        You see measured progress — mastery, exams, struggle flags. You never
        see a learner's tutor conversation.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={pickedUser}
          onChange={(e) => setPickedUser(e.target.value)}
          className={cn(inputCls, "max-w-[14rem]")}
        >
          <option value="">Pick a member…</option>
          {candidates.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.username}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          Due
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={cn(inputCls, "w-auto py-1.5")}
          />
        </label>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void enroll.mutate()}
          loading={enroll.isPending}
          disabled={!pickedUser}
          leftIcon={<Send className="h-4 w-4" />}
        >
          Assign
        </Button>
      </div>

      {progress && progress.length > 0 ? (
        <div className="overflow-x-auto rounded-card border border-[var(--border)]">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface)] text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">Learner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Units</th>
                <th className="px-3 py-2 font-medium">Mastery</th>
                <th className="px-3 py-2 font-medium">Exam</th>
                <th className="px-3 py-2 font-medium">Flags</th>
                <th className="px-3 py-2 font-medium">Last active</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((r) => (
                <tr
                  key={r.enrollment_id}
                  className="border-b border-[var(--border)] last:border-b-0"
                >
                  <td className="px-3 py-2 font-medium text-[var(--text)]">
                    {r.learner_name ?? "member"}
                    {r.due_at && (
                      <span className="block text-[10px] font-normal text-[var(--text-muted)]">
                        due {new Date(r.due_at).toLocaleDateString()}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <EnrollmentStatusChip status={r.status} />
                  </td>
                  <td className="px-3 py-2">
                    <div
                      className="flex items-center gap-1"
                      title={r.units
                        .map(
                          (u) =>
                            `${u.order_index + 1}. ${u.title}${
                              u.mastery_score != null
                                ? ` — ${u.mastery_score}/100`
                                : ""
                            } (${u.status.replace("_", " ")})`
                        )
                        .join("\n")}
                    >
                      {r.units.map((u) => (
                        <span
                          key={u.order_index}
                          className={cn(
                            "inline-block h-2.5 w-2.5 rounded-full",
                            u.status === "completed"
                              ? "bg-emerald-500"
                              : u.status === "in_progress"
                              ? "bg-amber-500"
                              : "border border-[var(--border)] bg-transparent"
                          )}
                        />
                      ))}
                      <span className="ml-1.5 text-[var(--text-muted)]">
                        {r.completed_units}/{r.total_units}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--text)]">
                    {r.overall_mastery != null ? `${r.overall_mastery}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-[var(--text)]">
                    {r.latest_exam_score != null ? (
                      <span
                        className={
                          r.latest_exam_passed
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400"
                        }
                      >
                        {r.latest_exam_score}/100
                        {r.exam_attempts > 1 ? ` (#${r.exam_attempts})` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.open_struggle_flags > 0 ? (
                      <span
                        className="text-amber-600 dark:text-amber-400"
                        title="Recurring misconceptions the tutor has logged more than once"
                      >
                        {r.open_struggle_flags}
                      </span>
                    ) : (
                      <span className="text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">
                    {r.last_active_at
                      ? new Date(r.last_active_at).toLocaleDateString()
                      : "not started"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">
          Nobody's enrolled yet. Assigning creates the course as a study topic
          in the member's own Study space and notifies them.
        </p>
      )}

      <GapInbox course={course} />
    </div>
  );
}

function EnrollmentStatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    assigned:
      "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
    in_progress:
      "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    completed:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    overdue: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium",
        styles[status] ?? styles.assigned
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

/** Gap inbox (L2, principle 3): questions the course material couldn't
 *  answer — each one is a documentation improvement waiting to happen. */
function GapInbox({ course }: { course: CourseDetail }) {
  const qc = useQueryClient();
  const { data: gaps } = useQuery({
    queryKey: ["course-gaps", course.id],
    queryFn: () => courseApi.gaps(course.id),
    refetchInterval: 60_000,
  });
  const resolve = useMutation({
    mutationFn: (gapId: string) => courseApi.resolveGap(course.id, gapId),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["course-gaps", course.id] }),
  });

  if (!gaps || gaps.length === 0) return null;
  return (
    <div className="mt-5">
      <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
        <MessageCircleQuestion className="h-4 w-4 text-amber-500" />
        Material gaps
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          {gaps.length}
        </span>
      </h4>
      <p className="mb-2 text-[11px] text-[var(--text-muted)]">
        Learners asked these, and the course material couldn't answer them.
        Update your docs (and the course sources), then mark them resolved.
      </p>
      <ul className="space-y-1.5">
        {gaps.map((g) => (
          <li
            key={g.id}
            className="flex items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-xs text-[var(--text)]">{g.question}</p>
              <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                {g.unit_title ? `${g.unit_title} · ` : ""}
                {new Date(g.created_at).toLocaleDateString()}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void resolve.mutate(g.id)}
              loading={resolve.isPending}
            >
              Resolve
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const inputCls = cn(
  "block w-full rounded-input border bg-[var(--bg)] px-3 py-2 text-sm",
  "border-[var(--border)] text-[var(--text)]",
  "focus:border-[var(--accent)]/60 focus:outline-none"
);

// ====================================================================
// Study-page host: workspace picker + the courses pane
// ====================================================================
/** The "Courses" tab on /study. Courses are scoped to a workspace (its
 *  files, members, permissions), so this hosts a picker and remembers
 *  the last choice. */
export function TeamCoursesHome() {
  const { data: workspaces } = useWorkspaces();
  const usable = useMemo(
    () => (workspaces ?? []).filter((w) => !w.archived_at),
    [workspaces]
  );
  const [wsId, setWsId] = useState<string>(
    () => localStorage.getItem("promptly.study.courses.ws") ?? ""
  );
  const selectedId =
    usable.some((w) => w.id === wsId) ? wsId : usable[0]?.id ?? "";
  // Detail carries the caller's fine-grained role; viewers browse read-only.
  const { data: wsDetail } = useWorkspace(selectedId || undefined);
  const canEdit = wsDetail ? wsDetail.access_role !== "viewer" : false;

  if (usable.length === 0) {
    return (
      <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <GraduationCap className="h-5 w-5 text-[var(--accent)]" />
        </div>
        <h2 className="text-lg font-semibold">No workspaces yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
          Team courses are built from a workspace's materials and assigned to
          its members. Create a workspace (and add some docs to its drive)
          first — then author your first course here.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6">
      {usable.length > 1 && (
        <label className="mb-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          Workspace
          <select
            value={selectedId}
            onChange={(e) => {
              setWsId(e.target.value);
              localStorage.setItem("promptly.study.courses.ws", e.target.value);
            }}
            className={cn(inputCls, "w-auto py-1.5")}
          >
            {usable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedId && (
        <CoursesPane key={selectedId} workspaceId={selectedId} canEdit={canEdit} />
      )}
    </div>
  );
}
