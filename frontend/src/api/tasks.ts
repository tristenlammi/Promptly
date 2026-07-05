import { apiClient } from "./client";

export type TaskFrequency = "hourly" | "daily" | "weekly" | "monthly";
/** "warning" = the run completed but its output self-reports a dead end
 *  (empty searches, missing data) — surfaced amber, not green. */
export type TaskRunStatus =
  | "pending"
  | "running"
  | "success"
  | "warning"
  | "failed";

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

export interface NodeRun {
  node_id: string;
  type: string;
  label: string;
  status: string;
  input?: string;
  output: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

export interface TaskRun extends TaskRunSummary {
  task_id: string;
  output_markdown: string | null;
  error: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  sources: Array<{ title?: string; url?: string; snippet?: string }>;
  node_runs?: NodeRun[] | null;
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
  /** Home workspace title — populated by the ``scope=all`` list so the
   *  Automations page can group by home. Null for personal automations. */
  workspace_title: string | null;
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
  /** True when the automation has a stored Advanced flow (opens the flow
   *  editor); false = a Simple single-prompt task. */
  is_advanced: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: TaskRunStatus | null;
  latest_run: TaskRunSummary | null;
  /** Credential segment of the inbound-hook URL. Minted on first save of a
   *  flow containing a webhook trigger; only ever returned to the owner. */
  webhook_secret: string | null;
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
  async list(scope: "personal" | "all" = "personal"): Promise<Task[]> {
    const { data } = await apiClient.get<Task[]>("/tasks", {
      params: scope === "all" ? { scope } : undefined,
    });
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
  /** Copy an automation (same prompt/schedule/flow/connectors) — arrives
   *  paused so it never double-fires next to its source. */
  async duplicate(id: string): Promise<Task> {
    const { data } = await apiClient.post<Task>(`/tasks/${id}/duplicate`);
    return data;
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
  async testGraph(
    id: string,
    graph: FlowGraph,
    targetNodeId: string,
    pinned: Record<string, string>
  ): Promise<GraphTestResult> {
    const { data } = await apiClient.post<GraphTestResult>(
      `/tasks/${id}/graph/test`,
      { graph, target_node_id: targetNodeId, pinned }
    );
    return data;
  },
  async getMemory(id: string): Promise<TaskMemory> {
    const { data } = await apiClient.get<TaskMemory>(`/tasks/${id}/memory`);
    return data;
  },
  async clearMemory(id: string, nodeId: string): Promise<void> {
    await apiClient.delete(`/tasks/${id}/memory/${nodeId}`);
  },
};

// ---------------------------------------------------------------------
// Flow graph types — mirror app/tasks/flow_graph.py. ``data`` is freeform
// per node type; the editor narrows it via the typed helpers below.
// ---------------------------------------------------------------------
export type FlowNodeType =
  | "trigger.schedule"
  | "trigger.manual"
  | "trigger.webhook"
  | "ai.prompt"
  | "ai.summarise"
  | "ai.extract"
  | "search.web"
  | "fetch.page"
  | "http.request"
  | "research.deep"
  | "loop.foreach"
  | "memory.store"
  | "flow.merge"
  | "flow.delay"
  | "control.condition"
  | "control.router"
  | "output.report"
  | "output.board_card"
  | "output.chat_message"
  | "output.note"
  | "output.sheet";

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

export interface WebSearchData {
  query: string;
  count: number;
}

export interface DeepResearchData {
  query: string;
  max_pages: number;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
}

export interface SummariseData {
  length: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
}

export interface ExtractData {
  spec: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
}

export interface ChatMessageOutputData {
  chat_item_id: string | null;
}

export interface NoteOutputData {
  title: string;
  folder_item_id: string | null;
}

export interface SheetOutputData {
  title: string;
  folder_item_id: string | null;
}

export interface MemoryData {
  name: string;
  remember: boolean;
  max_runs: number;
}

export interface GraphTestNode {
  node_id: string;
  label: string;
  status: string;
  input?: string;
  output: string;
}
export interface GraphTestResult {
  ok: boolean;
  error?: string;
  nodes: GraphTestNode[];
}

export interface TaskMemoryEntry {
  value: string;
  at: string;
}
export type TaskMemory = Record<
  string,
  { entries: TaskMemoryEntry[]; updated_at: string | null }
>;

export interface MergeData {
  mode: string;
  separator: string;
}

export interface DelayData {
  seconds: number;
}

export interface LoopData {
  split_mode: string;
  prompt: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  use_web_search: boolean;
  connector_ids: string[];
  max_items: number;
  join_with: string;
}

export interface ConditionData {
  source: string;
  operator: string;
  value: string;
  case_sensitive: boolean;
}

export interface RouterCategory {
  id: string;
  name: string;
  description: string;
}

export interface RouterData {
  categories: RouterCategory[];
  provider_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
}

export interface FetchPageData {
  url: string;
  max_chars: number;
}

/** One header on an HTTP-request node. ``value`` is a template and may
 *  reference ``{{secret.NAME}}`` from the credentials vault. */
export interface HttpHeader {
  name: string;
  value: string;
}

/** The universal API adapter (A1). URL / header values / body are
 *  templates; ``{{secret.NAME}}`` resolves from the vault at run time. */
export interface HttpRequestData {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: HttpHeader[];
  body: string;
  timeout_s: number;
  fail_on_error_status: boolean;
  allow_private_network: boolean;
}

export interface ReportOutputData {
  notify: boolean;
}

export interface BoardCardOutputData {
  board_item_id: string | null;
  column: string;
  priority: string;
  /** Update the live card with the same title instead of filing a duplicate. */
  update_existing?: boolean;
}
