import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  studyApi,
  type CreateStudyProjectPayload,
  type ListProjectsParams,
  type RegeneratePlanPayload,
  type StartExamPayload,
  type UpdateStudyProjectPayload,
} from "@/api/study";
import type { LearnerProfileUpdate } from "@/api/types";

const PROJECTS_KEY = ["study", "projects"] as const;

export function useStudyProjectsQuery(params: ListProjectsParams = {}) {
  const key = [
    ...PROJECTS_KEY,
    params.status ?? null,
    params.include_archived ?? false,
  ] as const;
  return useQuery({
    queryKey: key,
    queryFn: () => studyApi.listProjects(params),
  });
}

export function useStudyProjectQuery(id: string | null) {
  return useQuery({
    queryKey: ["study", "project", id],
    queryFn: () => studyApi.getProject(id as string),
    enabled: Boolean(id),
  });
}

export function useStudySessionQuery(id: string | null) {
  return useQuery({
    queryKey: ["study", "session", id],
    queryFn: () => studyApi.getSession(id as string),
    enabled: Boolean(id),
  });
}

export function useStudyUnitQuery(id: string | null) {
  return useQuery({
    queryKey: ["study", "unit", id],
    queryFn: () => studyApi.getUnit(id as string),
    enabled: Boolean(id),
  });
}

export function useStudyExamQuery(id: string | null) {
  return useQuery({
    queryKey: ["study", "exam", id],
    queryFn: () => studyApi.getExam(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateStudyProjectPayload) =>
      studyApi.createProject(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useRegenerateStudyPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; payload?: RegeneratePlanPayload }) =>
      studyApi.regeneratePlan(args.id, args.payload ?? {}),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ["study", "project", id] });
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useDeleteStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studyApi.deleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useArchiveStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studyApi.archiveProject(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ["study", "project", id] });
    },
  });
}

export function useCalibrateStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studyApi.calibrateProject(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ["study", "project", id] });
    },
  });
}

export function useUnarchiveStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studyApi.unarchiveProject(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ["study", "project", id] });
    },
  });
}

export function useUpdateStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; payload: UpdateStudyProjectPayload }) =>
      studyApi.updateProject(args.id, args.payload),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: ["study", "project", id] });
    },
  });
}

export function useEnterStudyUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unitId: string) => studyApi.enterUnit(unitId),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["study", "project", resp.unit.project_id] });
      qc.invalidateQueries({ queryKey: ["study", "unit", resp.unit.id] });
    },
  });
}

export function useStartFinalExam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; payload?: StartExamPayload }) =>
      studyApi.startFinalExam(args.projectId, args.payload ?? {}),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["study", "project", resp.exam.project_id] });
      qc.invalidateQueries({ queryKey: ["study", "exam", resp.exam.id] });
    },
  });
}

export function useExerciseHistoryQuery(sessionId: string | null) {
  return useQuery({
    queryKey: ["study", "exercises", sessionId],
    queryFn: () => studyApi.listExercises(sessionId as string),
    enabled: Boolean(sessionId),
  });
}

// ---- Learner state (Study 10/10) --------------------------------
/** Cache-key factories keep the key shape consistent between hooks and
 *  manual invalidations emitted by the SSE ``study_state_updated`` event. */
export const learnerStateKeys = {
  profile: (projectId: string) =>
    ["study", "learner-profile", projectId] as const,
  mastery: (projectId: string) =>
    ["study", "objective-mastery", projectId] as const,
  misconceptions: (projectId: string, includeResolved: boolean) =>
    ["study", "misconceptions", projectId, includeResolved] as const,
  reviewQueue: (projectId: string) =>
    ["study", "review-queue", projectId] as const,
};

export function useLearnerProfileQuery(projectId: string | null) {
  return useQuery({
    queryKey: projectId
      ? learnerStateKeys.profile(projectId)
      : ["study", "learner-profile", null],
    queryFn: () => studyApi.getLearnerProfile(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useUpdateLearnerProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; payload: LearnerProfileUpdate }) =>
      studyApi.updateLearnerProfile(args.projectId, args.payload),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: learnerStateKeys.profile(projectId) });
    },
  });
}

export function useObjectiveMasteryQuery(projectId: string | null) {
  return useQuery({
    queryKey: projectId
      ? learnerStateKeys.mastery(projectId)
      : ["study", "objective-mastery", null],
    queryFn: () => studyApi.getObjectiveMastery(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useMisconceptionsQuery(
  projectId: string | null,
  includeResolved = false
) {
  return useQuery({
    queryKey: projectId
      ? learnerStateKeys.misconceptions(projectId, includeResolved)
      : ["study", "misconceptions", null, includeResolved],
    queryFn: () =>
      studyApi.getMisconceptions(projectId as string, includeResolved),
    enabled: Boolean(projectId),
  });
}

export function useResolveMisconception() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; misconceptionId: string }) =>
      studyApi.resolveMisconception(args.projectId, args.misconceptionId),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: ["study", "misconceptions", projectId] });
    },
  });
}

export function useReviewQueueQuery(projectId: string | null) {
  return useQuery({
    queryKey: projectId
      ? learnerStateKeys.reviewQueue(projectId)
      : ["study", "review-queue", null],
    queryFn: () => studyApi.getReviewQueue(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useCaptureConfidence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      sessionId: string;
      level: number;
      objective_index?: number | null;
      note?: string | null;
    }) =>
      studyApi.captureConfidence(args.sessionId, {
        level: args.level,
        objective_index: args.objective_index ?? null,
        note: args.note ?? null,
      }),
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ["study", "session", sessionId] });
    },
  });
}
