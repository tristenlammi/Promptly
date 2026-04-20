import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  studyApi,
  type CreateStudyProjectPayload,
  type ListProjectsParams,
  type RegeneratePlanPayload,
  type StartExamPayload,
  type UpdateStudyProjectPayload,
} from "@/api/study";

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
