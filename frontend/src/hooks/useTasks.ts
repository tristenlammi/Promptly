import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { tasksApi, type Task, type TaskInput } from "@/api/tasks";

const TASKS_KEY = ["tasks"] as const;
const taskKey = (id: string) => ["tasks", id] as const;
const runsKey = (id: string) => ["tasks", id, "runs"] as const;
const runKey = (taskId: string, runId: string) =>
  ["tasks", taskId, "runs", runId] as const;

export function useTasks() {
  return useQuery<Task[]>({
    queryKey: TASKS_KEY,
    queryFn: () => tasksApi.list(),
    staleTime: 30_000,
  });
}

export function useTask(id: string | undefined) {
  return useQuery<Task>({
    queryKey: taskKey(id ?? ""),
    queryFn: () => tasksApi.get(id as string),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskInput) => tasksApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<TaskInput> }) =>
      tasksApi.update(id, input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: TASKS_KEY });
      qc.invalidateQueries({ queryKey: taskKey(vars.id) });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tasksApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useRunTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tasksApi.runNow(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: runsKey(id) });
      qc.invalidateQueries({ queryKey: taskKey(id) });
    },
  });
}

export function useTaskRuns(id: string | undefined, poll = false) {
  return useQuery({
    queryKey: runsKey(id ?? ""),
    queryFn: () => tasksApi.listRuns(id as string),
    enabled: !!id,
    // While a run is in flight the page asks us to poll so the history
    // rail + viewer flip from "running" to the finished report on their
    // own without a manual refresh.
    refetchInterval: poll ? 4000 : false,
  });
}

export function useTaskRun(
  taskId: string | undefined,
  runId: string | undefined,
  poll = false
) {
  return useQuery({
    queryKey: runKey(taskId ?? "", runId ?? ""),
    queryFn: () => tasksApi.getRun(taskId as string, runId as string),
    enabled: !!taskId && !!runId,
    refetchInterval: poll ? 4000 : false,
  });
}
