import { apiClient } from "./client";

export interface McpToolInfo {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
}

export interface McpConnector {
  id: string;
  name: string;
  slug: string;
  url: string;
  has_auth: boolean;
  auth_header_name: string | null;
  enabled: boolean;
  availability: "global" | "workspace";
  allowed_tools: string[] | null;
  tools: McpToolInfo[];
  tools_refreshed_at: string | null;
  created_at: string;
}

export interface ConnectorCreatePayload {
  name: string;
  url: string;
  auth_header_name?: string | null;
  auth_value?: string | null;
  availability?: "global" | "workspace";
  allowed_tools?: string[] | null;
}

export interface ConnectorUpdatePayload {
  name?: string;
  url?: string;
  auth_header_name?: string | null;
  auth_value?: string | null;
  enabled?: boolean;
  availability?: "global" | "workspace";
  allowed_tools?: string[] | null;
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
    const { data } = await apiClient.post<McpConnector>(
      "/admin/mcp/connectors",
      payload
    );
    return data;
  },
  async update(
    id: string,
    payload: ConnectorUpdatePayload
  ): Promise<McpConnector> {
    const { data } = await apiClient.patch<McpConnector>(
      `/admin/mcp/connectors/${id}`,
      payload
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/admin/mcp/connectors/${id}`);
  },
  async refresh(id: string): Promise<McpConnector> {
    const { data } = await apiClient.post<McpConnector>(
      `/admin/mcp/connectors/${id}/refresh`
    );
    return data;
  },
  async test(payload: {
    url: string;
    auth_header_name?: string | null;
    auth_value?: string | null;
  }): Promise<TestResult> {
    const { data } = await apiClient.post<TestResult>("/admin/mcp/test", payload);
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
}
