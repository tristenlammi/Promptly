import { apiClient } from "@/api/client";

/**
 * A home's automations (backend ``app/home/auto_router.py``): things the home
 * does when asked ("movie time"), at a time, or when a device changes. A
 * flow of home steps: the node editor's graph, kept on the server. Everyone
 * in the home sees and runs them; whoever looks after the home changes them.
 */

export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface FlowEdge {
  source: string;
  target: string;
  source_handle?: string | null;
  target_handle?: string | null;
}

export interface FlowGraph {
  version: number;
  mode: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface AutomationRun {
  id: string;
  /** pending | running | success | warning (part of it didn't work) | failed */
  status: string;
  /** manual (the Run button) | phrase | schedule | device */
  trigger: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  steps?: { node_id: string; status: string; text: string }[];
}

export interface HomeAutomation {
  id: string;
  name: string;
  phrases: string[];
  enabled: boolean;
  trigger: { kind: "asked" | "schedule" | "device"; words: string };
  /** How many things it does. */
  steps: number;
  next_run_at: string | null;
  last: AutomationRun | null;
  can_edit: boolean;
  graph?: FlowGraph;
}

export interface MusicChoice {
  uri: string;
  kind: string;
  words: string;
}

const base = (home: string) => `/home/${home}/automations`;

export const homeAutomationsApi = {
  list: (home: string) => apiClient.get<{ can_edit: boolean; automations: HomeAutomation[] }>(base(home)).then((r) => r.data),
  get: (home: string, id: string) => apiClient.get<HomeAutomation>(`${base(home)}/${id}`).then((r) => r.data),
  create: (home: string, name: string) =>
    apiClient.post<HomeAutomation>(base(home), { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "" }).then((r) => r.data),
  save: (home: string, id: string, body: { name?: string; phrases?: string[]; enabled?: boolean; graph?: FlowGraph }) =>
    apiClient
      .put<HomeAutomation>(`${base(home)}/${id}`, { ...body, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "" })
      .then((r) => r.data),
  remove: (home: string, id: string) => apiClient.delete(`${base(home)}/${id}`).then(() => undefined),
  run: (home: string, id: string) =>
    apiClient.post<{ ok: boolean; words: string; run: AutomationRun }>(`${base(home)}/${id}/run`).then((r) => r.data),
  runs: (home: string, id: string) => apiClient.get<{ runs: AutomationRun[] }>(`${base(home)}/${id}/runs`).then((r) => r.data.runs),
  music: (home: string, boxId: string, q: string) =>
    apiClient.get<{ results: MusicChoice[] }>(`/home/${home}/automations-music`, { params: { box_id: boxId, q } }).then((r) => r.data.results),
};
