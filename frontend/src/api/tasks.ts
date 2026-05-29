import { apiClient } from "./client";

export type TaskFrequency = "hourly" | "daily" | "weekly" | "monthly";
export type TaskRunStatus = "pending" | "running" | "success" | "failed";

export interface TaskRunSummary {
  id: string;
  status: TaskRunStatus;
  trigger: "schedule" | "manual";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number | null;
}

export interface TaskRun extends TaskRunSummary {
  task_id: string;
  output_markdown: string | null;
  error: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  sources: Array<{ title?: string; url?: string; snippet?: string }>;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  use_web_search: boolean;
  frequency: TaskFrequency;
  hour: number | null;
  minute: number;
  weekday: number | null;
  day_of_month: number | null;
  timezone: string;
  schedule_label: string;
  enabled: boolean;
  notify: boolean;
  retention_runs: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: TaskRunStatus | null;
  latest_run: TaskRunSummary | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  title: string;
  prompt: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort?: string | null;
  use_web_search: boolean;
  frequency: TaskFrequency;
  hour: number | null;
  minute: number;
  weekday: number | null;
  day_of_month: number | null;
  timezone: string;
  enabled: boolean;
  notify: boolean;
  retention_runs: number;
}

export const tasksApi = {
  async list(): Promise<Task[]> {
    const { data } = await apiClient.get<Task[]>("/tasks");
    return data;
  },
  async get(id: string): Promise<Task> {
    const { data } = await apiClient.get<Task>(`/tasks/${id}`);
    return data;
  },
  async create(input: TaskInput): Promise<Task> {
    const { data } = await apiClient.post<Task>("/tasks", input);
    return data;
  },
  async update(id: string, input: Partial<TaskInput>): Promise<Task> {
    const { data } = await apiClient.patch<Task>(`/tasks/${id}`, input);
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/tasks/${id}`);
  },
  async runNow(id: string): Promise<TaskRun> {
    const { data } = await apiClient.post<TaskRun>(`/tasks/${id}/run`);
    return data;
  },
  async listRuns(id: string, limit = 50, offset = 0): Promise<TaskRunSummary[]> {
    const { data } = await apiClient.get<TaskRunSummary[]>(
      `/tasks/${id}/runs`,
      { params: { limit, offset } }
    );
    return data;
  },
  async getRun(taskId: string, runId: string): Promise<TaskRun> {
    const { data } = await apiClient.get<TaskRun>(
      `/tasks/${taskId}/runs/${runId}`
    );
    return data;
  },
  async deleteRun(taskId: string, runId: string): Promise<void> {
    await apiClient.delete(`/tasks/${taskId}/runs/${runId}`);
  },
  async toChat(taskId: string, runId: string): Promise<{ conversation_id: string }> {
    const { data } = await apiClient.post<{ conversation_id: string }>(
      `/tasks/${taskId}/runs/${runId}/to-chat`
    );
    return data;
  },
  async downloadPdf(taskId: string, runId: string): Promise<Blob> {
    const { data } = await apiClient.get<Blob>(
      `/tasks/${taskId}/runs/${runId}/pdf`,
      { responseType: "blob" }
    );
    return data;
  },
};
