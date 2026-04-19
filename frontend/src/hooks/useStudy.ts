import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { studyApi, type CreateStudyProjectPayload } from "@/api/study";

const PROJECTS_KEY = ["study", "projects"] as const;

export function useStudyProjectsQuery() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => studyApi.listProjects(),
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

export function useDeleteStudyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studyApi.deleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useCreateStudySession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => studyApi.createSession(projectId),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ["study", "project", projectId] });
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
