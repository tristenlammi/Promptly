import { apiClient } from "./client";

/** What a command *does*. The Automations tabs are filtered views of
 *  this one field — Prompts is `prompt`, Commands is the rest — rather
 *  than separate features that would drift apart. */
export type CommandActionType = "prompt" | "automation" | "mcp_tool";

/** Action types that reach outside Promptly and change something. These
 *  confirm before running, whether typed or spoken. */
export const SIDE_EFFECTING: CommandActionType[] = ["automation", "mcp_tool"];

export function isSideEffecting(type: CommandActionType): boolean {
  return SIDE_EFFECTING.includes(type);
}

export interface Command {
  id: string;
  name: string;
  /** Every way of saying it. Matched after normalisation, so casing and
   *  punctuation don't need duplicating. May contain `{slot}` holes.
   *  Empty means menu-only — it can be picked but never spoken. */
  phrases: string[];
  action_type: CommandActionType;
  /** automation → task id; mcp_tool → "<connector id>:<tool>". */
  action_ref: string | null;
  action_args: Record<string, unknown>;
  /** The template text, for `prompt` commands. */
  body: string | null;
  response_template: string | null;
  enabled: boolean;
  /** "Ask before running this one." Off by default, and it governs both
   *  the typed and spoken paths so a command can't ask in one place and
   *  not the other. */
  confirm_before_run: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommandInput {
  name: string;
  phrases?: string[];
  action_type?: CommandActionType;
  action_ref?: string | null;
  action_args?: Record<string, unknown>;
  body?: string | null;
  response_template?: string | null;
  enabled?: boolean;
  confirm_before_run?: boolean;
}

export interface CommandMatch {
  matched: boolean;
  command: Command | null;
  slots: Record<string, string>;
  needs_confirmation: boolean;
}

export interface CommandRunResult {
  kind: string;
  /** prompt → the filled-in text to insert. */
  text: string | null;
  run_id: string | null;
  status: string | null;
  output: string | null;
  /** What to say aloud, when a template made that possible model-free. */
  spoken: string | null;
  /** The transcript message the run was recorded as, when it ran from a
   *  chat. Appended straight to the store rather than refetching. */
  message: {
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    tool_calls: unknown[] | null;
    created_at: string | null;
  } | null;
}

/** A connector and the tools a command may point at. Resolved through
 *  the same path the chat pipeline uses, so it lists exactly what the
 *  caller could already call — building a shortcut never surfaces a tool
 *  you couldn't otherwise reach. */
/** The subset of JSON Schema an MCP tool realistically declares. */
export interface ToolSchema {
  type?: string;
  properties?: Record<
    string,
    {
      type?: string;
      description?: string;
      enum?: (string | number)[];
      title?: string;
    }
  >;
  required?: string[];
}

export interface CommandToolSource {
  connector_id: string;
  connector_name: string;
  kind: string;
  tools: {
    name: string;
    description: string;
    /** The connector flags this as changing something in the world.
     *  Drives the "ask before running" default so the user doesn't have
     *  to know which of a hundred services opens a door. */
    destructive: boolean;
    /** The tool's own JSON Schema. Home Assistant exposes intents
     *  (`HassTurnOff`) rather than entities, so *which lamp* is an
     *  argument — the editor renders a field per property from this. */
    input_schema: ToolSchema;
  }[];
}

/** One device behind a connector, with the actions that make sense for
 *  it — filtered to what the connector actually publishes. */
export interface ConnectorDevice {
  name: string;
  domain: string;
  area: string;
  state: string;
  actions: string[];
}

export interface ConnectorDevices {
  supported: boolean;
  devices: ConnectorDevice[];
  /** Only populated when parsing failed, so the UI can show what came
   *  back instead of claiming there are no devices. */
  raw: string;
  detail: string;
}

export const commandsApi = {
  async devices(connectorId: string): Promise<ConnectorDevices> {
    const { data } = await apiClient.get<ConnectorDevices>(
      `/commands/tools/${connectorId}/devices`
    );
    return data;
  },
  async tools(): Promise<CommandToolSource[]> {
    const { data } = await apiClient.get<CommandToolSource[]>(
      "/commands/tools"
    );
    return data;
  },
  async list(actionType?: CommandActionType): Promise<Command[]> {
    const { data } = await apiClient.get<Command[]>("/commands", {
      params: actionType ? { action_type: actionType } : undefined,
    });
    return data;
  },
  async create(input: CommandInput): Promise<Command> {
    const { data } = await apiClient.post<Command>("/commands", input);
    return data;
  },
  async update(id: string, input: Partial<CommandInput>): Promise<Command> {
    const { data } = await apiClient.patch<Command>(`/commands/${id}`, input);
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/commands/${id}`);
  },
  /** What an utterance *would* do, without doing it. Separated from run
   *  so a side-effecting command can be confirmed first, and so the
   *  menu can preview a phrase. */
  async match(utterance: string): Promise<CommandMatch> {
    const { data } = await apiClient.post<CommandMatch>("/commands/match", {
      utterance,
    });
    return data;
  },
  async run(
    id: string,
    opts: {
      slots?: Record<string, string>;
      confirmed?: boolean;
      /** Record the run in this chat's transcript. */
      conversationId?: string | null;
    } = {}
  ): Promise<CommandRunResult> {
    const { data } = await apiClient.post<CommandRunResult>(
      `/commands/${id}/run`,
      {
        slots: opts.slots ?? {},
        confirmed: opts.confirmed ?? false,
        conversation_id: opts.conversationId ?? null,
      }
    );
    return data;
  },
};
