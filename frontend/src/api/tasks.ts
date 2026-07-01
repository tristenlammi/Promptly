import { apiClient } from "./client";

export type TaskFrequency = "hourly" | "daily" | "weekly" | "monthly";
export type TaskRunStatus = "pending" | "running" | "success" | "failed";

export interface TaskRunSummary {
  id: string;
  status: TaskRunStatus;
  trigger: "schedule" | "manual";
  title: string | null;
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
  workspace_id: string | null;
  connector_ids: string[];
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
  workspace_id?: string | null;
  connector_ids?: string[];
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

export interface AvailableTaskConnector {
  id: string;
  name: string;
  slug: string;
  kind: string;
  tool_count: number;
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
  async availableConnectors(
    workspaceId?: string | null
  ): Promise<AvailableTaskConnector[]> {
    const { data } = await apiClient.get<AvailableTaskConnector[]>(
      "/tasks/connectors/available",
      { params: workspaceId ? { workspace_id: workspaceId } : undefined }
    );
    return data;
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
  // ---- Flow graph (Automations Phase 1) ----
  async getGraph(id: string): Promise<FlowGraph> {
    const { data } = await apiClient.get<FlowGraph>(`/tasks/${id}/graph`);
    return data;
  },
  async saveGraph(id: string, graph: FlowGraph): Promise<FlowGraph> {
    const { data } = await apiClient.put<FlowGraph>(`/tasks/${id}/graph`, graph);
    return data;
  },
  async promote(id: string): Promise<FlowGraph> {
    const { data } = await apiClient.post<FlowGraph>(`/tasks/${id}/promote`);
    return data;
  },
};

// ---------------------------------------------------------------------
// Flow graph types — mirror app/tasks/flow_graph.py. ``data`` is freeform
// per node type; the editor narrows it via the typed helpers below.
// ---------------------------------------------------------------------
export type FlowNodeType =
  | "trigger.schedule"
  | "trigger.manual"
  | "ai.prompt"
  | "output.report"
  | "output.board_card";

export interface FlowNodeModel {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface FlowEdgeModel {
  source: string;
  target: string;
  source_handle?: string | null;
  target_handle?: string | null;
}

export interface FlowGraph {
  version: number;
  mode: "simple" | "advanced";
  nodes: FlowNodeModel[];
  edges: FlowEdgeModel[];
}

export interface ScheduleTriggerData {
  frequency: TaskFrequency;
  hour: number | null;
  minute: number;
  weekday: number | null;
  day_of_month: number | null;
  timezone: string;
}

export interface AIPromptData {
  prompt: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  use_web_search: boolean;
  connector_ids: string[];
}

export interface ReportOutputData {
  notify: boolean;
}

export interface BoardCardOutputData {
  board_item_id: string | null;
  column: string;
  priority: string;
}
