import { apiClient } from "./client";

export interface McpToolInfo {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
}

export type ConnectorKind = "mcp" | "unifi";

/** Wire protocol an MCP server speaks. Streamable-HTTP is the current
 *  standard and the default; SSE is the older transport that plenty of
 *  real servers still expose — Home Assistant's among them. */
export type ConnectorTransport = "http" | "sse";

/** Talking to the connector itself (create, test, refresh) — a slow home
 *  server shouldn't trip the client's default timeout. */
const SLOW_MS = 90_000;

export interface McpConnector {
  id: string;
  name: string;
  slug: string;
  kind: ConnectorKind;
  url: string;
  transport: ConnectorTransport;
  has_auth: boolean;
  auth_header_name: string | null;
  enabled: boolean;
  availability: ConnectorAvailability;
  allowed_tools: string[] | null;
  group_ids: string[];
  user_ids: string[];
  workspace_ids: string[];
  tools: McpToolInfo[];
  tools_refreshed_at: string | null;
  /** Health — refreshes and live calls from chat, commands and
   *  automations all update these (R-158). */
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
}

export type ConnectorAvailability = "global" | "restricted";

export interface ConnectorCreatePayload {
  name: string;
  url: string;
  kind?: ConnectorKind;
  transport?: ConnectorTransport;
  auth_header_name?: string | null;
  auth_value?: string | null;
  availability?: ConnectorAvailability;
  allowed_tools?: string[] | null;
  group_ids?: string[];
  user_ids?: string[];
  workspace_ids?: string[];
}

export interface ConnectorUpdatePayload {
  name?: string;
  url?: string;
  transport?: ConnectorTransport;
  auth_header_name?: string | null;
  auth_value?: string | null;
  enabled?: boolean;
  availability?: ConnectorAvailability;
  allowed_tools?: string[] | null;
  group_ids?: string[];
  user_ids?: string[];
  workspace_ids?: string[];
}

export interface WorkspaceOption {
  id: string;
  title: string;
  owner: string | null;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  tools: McpToolInfo[];
}

export const mcpApi = {
  async list(): Promise<McpConnector[]> {
    const { data } = await apiClient.get<McpConnector[]>("/admin/mcp/connectors");
    return data;
  },
  async create(payload: ConnectorCreatePayload): Promise<McpConnector> {
    // Creating fetches the tool list from the server, which can be slow on
    // a home network — longer than the default timeout (R-158).
    const { data } = await apiClient.post<McpConnector>(
      "/admin/mcp/connectors",
      payload,
      { timeout: SLOW_MS }
    );
    return data;
  },
  async update(
    id: string,
    payload: ConnectorUpdatePayload
  ): Promise<McpConnector> {
    const { data } = await apiClient.patch<McpConnector>(
      `/admin/mcp/connectors/${id}`,
      payload,
      { timeout: SLOW_MS }
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/admin/mcp/connectors/${id}`);
  },
  async refresh(id: string): Promise<McpConnector> {
    const { data } = await apiClient.post<McpConnector>(
      `/admin/mcp/connectors/${id}/refresh`,
      undefined,
      { timeout: SLOW_MS }
    );
    return data;
  },
  async test(payload: {
    url: string;
    kind?: ConnectorKind;
    transport?: ConnectorTransport;
    auth_header_name?: string | null;
    auth_value?: string | null;
    /** Editing: test with the saved token when none was typed. */
    connector_id?: string;
  }): Promise<TestResult> {
    const { data } = await apiClient.post<TestResult>("/admin/mcp/test", payload, {
      timeout: SLOW_MS,
    });
    return data;
  },

  // All workspaces (id + title + owner) — feeds the restricted-scope selector.
  async listWorkspaceOptions(): Promise<WorkspaceOption[]> {
    const { data } = await apiClient.get<WorkspaceOption[]>(
      "/admin/mcp/workspaces"
    );
    return data;
  },

  // ---- Workspace-scoped attachment (owner-managed) ----
  async listWorkspaceConnectors(
    workspaceId: string
  ): Promise<WorkspaceConnector[]> {
    const { data } = await apiClient.get<WorkspaceConnector[]>(
      `/workspaces/${workspaceId}/connectors`
    );
    return data;
  },
  async setWorkspaceConnectors(
    workspaceId: string,
    connectorIds: string[]
  ): Promise<void> {
    await apiClient.put(`/workspaces/${workspaceId}/connectors`, {
      connector_ids: connectorIds,
    });
  },
};

export interface WorkspaceConnector {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  tool_count: number;
  attached: boolean;
  /** "global" works in every chat; "restricted" only where attached. */
  availability: "global" | "restricted";
  attached_by_admin: boolean;
  /** Whether this viewer can switch it — and if not, why. */
  can_change: boolean;
  reason: string | null;
}
