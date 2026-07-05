import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  tasksApi,
  type FlowGraph,
  type Task,
  type TaskInput,
} from "@/api/tasks";

const TASKS_KEY = ["tasks"] as const;
const taskKey = (id: string) => ["tasks", id] as const;
const graphKey = (id: string) => ["tasks", id, "graph"] as const;
const runsKey = (id: string) => ["tasks", id, "runs"] as const;
const runKey = (taskId: string, runId: string) =>
  ["tasks", taskId, "runs", runId] as const;

export function useTasks(scope: "personal" | "all" = "personal") {
  return useQuery<Task[]>({
    queryKey: [...TASKS_KEY, scope],
    queryFn: () => tasksApi.list(scope),
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

export function useTaskGraph(id: string | undefined) {
  return useQuery<FlowGraph>({
    queryKey: graphKey(id ?? ""),
    queryFn: () => tasksApi.getGraph(id as string),
    enabled: !!id,
  });
}

export function useSaveTaskGraph(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (graph: FlowGraph) => tasksApi.saveGraph(id, graph),
    onSuccess: (data) => {
      qc.setQueryData(graphKey(id), data);
      // The save may rewrite the task's columns (prompt/schedule/etc.).
      qc.invalidateQueries({ queryKey: taskKey(id) });
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });
}

export function usePromoteTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tasksApi.promote(id),
    onSuccess: (data) => {
      qc.setQueryData(graphKey(id), data);
      qc.invalidateQueries({ queryKey: taskKey(id) });
    },
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

export function useDuplicateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tasksApi.duplicate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
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
