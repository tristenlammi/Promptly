import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  Clock,
  Columns3,
  FileText,
  Globe,
  Loader2,
  Plus,
  Save,
  Trash2,
  Zap,
} from "lucide-react";

import {
  tasksApi,
  type AIPromptData,
  type AvailableTaskConnector,
  type BoardCardOutputData,
  type FlowGraph,
  type FlowNodeModel,
  type ReportOutputData,
  type ScheduleTriggerData,
} from "@/api/tasks";
import {
  useSaveTaskGraph,
  useTask,
  useTaskGraph,
  useUpdateTask,
} from "@/hooks/useTasks";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import { useAvailableModels } from "@/hooks/useProviders";
import { useThemeStore } from "@/store/themeStore";
import { Modal } from "@/components/shared/Modal";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { cn } from "@/utils/cn";

function nodeModalTitle(type?: string): string {
  if (type === "ai.prompt") return "AI step";
  if (type === "output.report" || type === "output.board_card") return "Output";
  if (type?.startsWith("trigger.")) return "Schedule";
  return "Node";
}

interface BoardOption {
  id: string;
  title: string;
}

// ---------------------------------------------------------------------
// Node category colours — the app's own warm palette (green triggers,
// terracotta "brain" AI steps, amber output), not n8n's stock hues, so the
// editor reads as native. Actions/flow-control land in later phases.
// ---------------------------------------------------------------------
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const FREQUENCIES = ["hourly", "daily", "weekly", "monthly"] as const;
const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
// AU-only for now (matches the Simple form), plus whatever the task already has.
const TIMEZONES = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Perth",
  "Australia/Hobart",
  "Australia/Darwin",
];
const pad = (n: number) => String(n).padStart(2, "0");

function saveErrorMessage(err: unknown): string {
  const detail = (
    err as { response?: { data?: { detail?: string } } } | undefined
  )?.response?.data?.detail;
  return detail || "Couldn't save the flow.";
}

function scheduleSummary(d: ScheduleTriggerData): string {
  const t = `${String(d.hour ?? 0).padStart(2, "0")}:${String(d.minute).padStart(2, "0")}`;
  switch (d.frequency) {
    case "hourly":
      return `Hourly at :${String(d.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${t}`;
    case "weekly":
      return `Weekly · ${DAYS[d.weekday ?? 0]} ${t}`;
    case "monthly":
      return `Monthly · day ${d.day_of_month ?? 1} ${t}`;
    default:
      return d.frequency;
  }
}

// --- custom node renderers ------------------------------------------
function NodeShell({
  icon,
  label,
  accent,
  selected,
  children,
  hasIn,
  hasOut,
}: {
  icon: React.ReactNode;
  label: string;
  accent: string;
  selected?: boolean;
  children: React.ReactNode;
  hasIn?: boolean;
  hasOut?: boolean;
}) {
  return (
    <div
      className={cn(
        "w-60 rounded-card border bg-[var(--surface)] shadow-sm transition",
        selected
          ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/30"
          : "border-[var(--border)]"
      )}
    >
      {hasIn && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-[var(--surface)]"
          style={{ background: accent }}
        />
      )}
      <div
        className="flex items-center gap-2 rounded-t-card px-3 py-2 text-xs font-semibold"
        style={{ color: accent }}
      >
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="px-3 pb-3 text-xs text-[var(--text-muted)]">{children}</div>
      {hasOut && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5 !border-2 !border-[var(--surface)]"
          style={{ background: accent }}
        />
      )}
    </div>
  );
}

function TriggerNode({ data, selected }: NodeProps) {
  const d = data as unknown as ScheduleTriggerData;
  return (
    <NodeShell
      icon={<Clock className="h-3.5 w-3.5" />}
      label="Schedule"
      accent="var(--success)"
      selected={selected}
      hasOut
    >
      <div className="truncate text-[var(--text)]">{scheduleSummary(d)}</div>
      <div className="mt-0.5 truncate">{d.timezone}</div>
    </NodeShell>
  );
}

function AINode({ data, selected }: NodeProps) {
  const d = data as unknown as AIPromptData;
  return (
    <NodeShell
      icon={<Brain className="h-3.5 w-3.5" />}
      label="AI step"
      accent="var(--accent)"
      selected={selected}
      hasIn
      hasOut
    >
      <div className="line-clamp-2 text-[var(--text)]">
        {d.prompt || <span className="italic text-[var(--text-muted)]">No prompt yet</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="truncate rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
          {d.model_id || "no model"}
        </span>
        {d.use_web_search && (
          <span className="inline-flex items-center gap-0.5 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
            <Globe className="h-2.5 w-2.5" /> web
          </span>
        )}
        {d.connector_ids.length > 0 && (
          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
            {d.connector_ids.length} tool{d.connector_ids.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </NodeShell>
  );
}

function OutputNode({ data, selected }: NodeProps) {
  const d = data as unknown as ReportOutputData;
  return (
    <NodeShell
      icon={<FileText className="h-3.5 w-3.5" />}
      label="Report"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      <div className="text-[var(--text)]">Saved as a run report</div>
      <div className="mt-0.5">{d.notify ? "Notifies on completion" : "No notification"}</div>
    </NodeShell>
  );
}

function BoardCardNode({ data, selected }: NodeProps) {
  const d = data as unknown as BoardCardOutputData & { board_title?: string };
  return (
    <NodeShell
      icon={<Columns3 className="h-3.5 w-3.5" />}
      label="Create card"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      <div className="truncate text-[var(--text)]">
        {d.board_item_id ? (
          d.board_title || "On a board"
        ) : (
          <span className="italic text-[var(--text-muted)]">Pick a board</span>
        )}
      </div>
      <div className="mt-0.5">
        {d.column} · {d.priority} priority
      </div>
    </NodeShell>
  );
}

const nodeTypes = {
  "trigger.schedule": TriggerNode,
  "trigger.manual": TriggerNode,
  "ai.prompt": AINode,
  "output.report": OutputNode,
  "output.board_card": BoardCardNode,
};

// --- graph ⇄ react-flow ---------------------------------------------
function toRF(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { ...n.data },
      // Trigger + output are required singletons — don't let a stray Delete
      // remove them. AI steps are freely deletable.
      deletable: n.type === "ai.prompt",
    })),
    edges: graph.edges.map((e) => ({
      id: `${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      animated: false,
    })),
  };
}

function fromRF(base: FlowGraph, nodes: Node[], edges: Edge[]): FlowGraph {
  return {
    ...base,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as string,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data as Record<string, unknown>,
    })) as FlowNodeModel[],
    edges: edges.map((e) => ({ source: e.source, target: e.target })),
  };
}

/**
 * The Advanced flow editor for a scheduled task. Renders the task's node
 * graph (derived from its Simple config, or its stored Advanced graph),
 * lets the user chain AI steps together (prompt-injection via
 * ``{{upstream_output}}``) and edit each step, then persists via PUT /graph.
 * Linear chains only for now — matches what the backend engine executes.
 */
export function TaskFlowEditor({ taskId }: { taskId: string }) {
  const { data: graph, isLoading } = useTaskGraph(taskId);
  const save = useSaveTaskGraph(taskId);
  const colorMode = useThemeStore((s) => s.resolved());

  // Boards in the automation's home workspace — the targets a "Create card"
  // output node can write to. Empty for a top-level (non-workspace) task.
  const { data: task } = useTask(taskId);
  const { data: tree } = useWorkspaceTree(task?.workspace_id ?? undefined);
  const boards = useMemo<BoardOption[]>(() => {
    const out: BoardOption[] = [];
    const walk = (ns: WorkspaceItemNode[]) => {
      for (const n of ns) {
        if (n.kind === "board") out.push({ id: n.id, title: n.title || "Board" });
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree ?? []);
    return out;
  }, [tree]);

  // Title editing lives in the flow toolbar (it's task metadata, not a node).
  const updateTask = useUpdateTask();
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (task) setTitle(task.title);
  }, [task?.title]);
  const commitTitle = () => {
    const t = title.trim();
    if (t && task && t !== task.title) {
      updateTask.mutate({ id: taskId, input: { title: t } });
    }
  };

  // MCP connectors this automation can attach (workspace-scoped when homed in
  // one). Offered per AI step in the inspector.
  const { data: connectors } = useQuery({
    queryKey: ["task-connectors", task?.workspace_id ?? null],
    queryFn: () => tasksApi.availableConnectors(task?.workspace_id ?? null),
    enabled: !!task,
  });

  const rfInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Fit the view once, after the graph's nodes first load — the ReactFlow
  // `fitView` prop runs on mount, before the async graph exists, so without
  // this the output node can sit off-screen and never get configured.
  const fitted = useRef(false);
  useEffect(() => {
    if (!graph) return;
    const rf = toRF(graph);
    setNodes(rf.nodes);
    setEdges(rf.edges);
    setDirty(false);
    if (!fitted.current) {
      fitted.current = true;
      window.setTimeout(
        () => rfInstance.current?.fitView({ padding: 0.25, duration: 250 }),
        80
      );
    }
  }, [graph, setNodes, setEdges]);

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId]
  );

  const patchSelected = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selectedId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n
        )
      );
      setDirty(true);
    },
    [selectedId, setNodes]
  );

  // Switch the terminal output node between "report" and "board card",
  // resetting its data to that kind's defaults.
  const setOutputType = useCallback(
    (type: string) => {
      if (!selectedId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedId
            ? {
                ...n,
                type,
                data:
                  type === "output.board_card"
                    ? { board_item_id: null, column: "todo", priority: "medium" }
                    : { notify: true },
              }
            : n
        )
      );
      setDirty(true);
    },
    [selectedId, setNodes]
  );

  const aiNodes = nodes.filter((n) => n.type === "ai.prompt");

  // Free-form wiring: drag from one node's handle to another to connect them.
  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) => addEdge({ ...c, id: `${c.source}->${c.target}` }, eds));
      setDirty(true);
    },
    [setEdges]
  );

  // Add a *disconnected* AI step — the user wires it in themselves. New steps
  // inherit an existing step's model so they're runnable once connected.
  const addAIStep = useCallback(
    (pos?: { x: number; y: number }) => {
      const model =
        (aiNodes[aiNodes.length - 1]?.data as unknown as
          | AIPromptData
          | undefined) ?? null;
      const id = `ai_${Date.now().toString(36)}`;
      const position =
        pos ?? { x: 140 + aiNodes.length * 48, y: 280 + aiNodes.length * 24 };
      const newNode: Node = {
        id,
        type: "ai.prompt",
        position,
        deletable: true,
        data: {
          prompt: "Use the previous step's output:\n\n{{upstream_output}}",
          provider_id: model?.provider_id ?? null,
          model_id: model?.model_id ?? null,
          reasoning_effort: model?.reasoning_effort ?? null,
          use_web_search: false,
          connector_ids: [],
        } as unknown as Record<string, unknown>,
      };
      setNodes((ns) => ns.concat(newNode));
      setSelectedId(id);
      setDirty(true);
    },
    [aiNodes, setNodes]
  );

  // Jump to + select the output node (where "send to a board" is configured)
  // so it's never lost off-screen.
  const focusOutput = useCallback(() => {
    const out = nodes.find(
      (n) => n.type === "output.report" || n.type === "output.board_card"
    );
    if (!out) return;
    setSelectedId(out.id);
    rfInstance.current?.setCenter(out.position.x + 120, out.position.y + 40, {
      zoom: 1,
      duration: 300,
    });
  }, [nodes]);

  // Right-click pane menu → add an AI step at the clicked position.
  const addAIStepAtMenu = useCallback(() => {
    if (menu && rfInstance.current) {
      addAIStep(
        rfInstance.current.screenToFlowPosition({ x: menu.x, y: menu.y })
      );
    } else {
      addAIStep();
    }
    setMenu(null);
  }, [menu, addAIStep]);

  // Remove a node + its edges; if it sat mid-chain (one in, one out), heal the
  // gap so the surrounding chain stays connected.
  const removeNode = useCallback(
    (id: string) => {
      const incoming = edges.find((e) => e.target === id);
      const outgoing = edges.find((e) => e.source === id);
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => {
        const kept = es.filter((e) => e.source !== id && e.target !== id);
        if (incoming && outgoing) {
          kept.push({
            id: `${incoming.source}->${outgoing.target}`,
            source: incoming.source,
            target: outgoing.target,
          });
        }
        return kept;
      });
      if (selectedId === id) setSelectedId(null);
      setDirty(true);
    },
    [edges, setNodes, setEdges, selectedId]
  );

  const onSave = useCallback(() => {
    if (!graph) return;
    save.mutate(fromRF(graph, nodes, edges), {
      onSuccess: () => setDirty(false),
    });
  }, [graph, nodes, edges, save]);

  if (isLoading || !graph) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading flow…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {/* Toolbar */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="Automation title"
            className="w-44 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium",
              graph.mode === "advanced"
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
            )}
          >
            <Zap className="h-3 w-3" />
            {graph.mode === "advanced" ? "Advanced flow" : "Simple task"}
          </span>
          <button
            type="button"
            onClick={() => addAIStep()}
            title="Add a disconnected AI step (or right-click the canvas)"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
          >
            <Plus className="h-3.5 w-3.5" /> AI step
          </button>
          <button
            type="button"
            onClick={focusOutput}
            title="Configure what happens with the result (report or board card)"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
          >
            <FileText className="h-3.5 w-3.5" /> Output
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || save.isPending}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>

        {save.isError && (
          <div className="absolute left-3 top-12 z-10 max-w-md rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-1.5 text-[11px] text-[var(--danger)]">
            {saveErrorMessage(save.error)}
          </div>
        )}

        <ReactFlow
          colorMode={colorMode}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(inst) => (rfInstance.current = inst)}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodesDelete={() => setDirty(true)}
          onEdgesDelete={() => setDirty(true)}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onPaneClick={() => {
            setSelectedId(null);
            setMenu(null);
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            const me = e as React.MouseEvent;
            setMenu({ x: me.clientX, y: me.clientY });
          }}
          onNodeDragStop={() => setDirty(true)}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-[var(--surface)]" />
        </ReactFlow>

        {menu && (
          <>
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
            <div className="fixed inset-0 z-20" onClick={() => setMenu(null)} />
            <div
              role="menu"
              className="fixed z-30 min-w-[9rem] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
              style={{ left: menu.x, top: menu.y }}
            >
              <button
                type="button"
                onClick={addAIStepAtMenu}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Brain className="h-3.5 w-3.5 text-[var(--accent)]" /> Add AI step
              </button>
            </div>
          </>
        )}
      </div>

      {/* Node editor — a modal with its own Save so it's right where you edit. */}
      <Modal
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected ? nodeModalTitle(selected.type) : ""}
        widthClass="max-w-md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-[var(--hover)]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                onSave();
                setSelectedId(null);
              }}
              disabled={save.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {save.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </button>
          </div>
        }
      >
        {selected && (
          <NodeInspector
            node={selected}
            boards={boards}
            inWorkspace={!!task?.workspace_id}
            connectors={connectors ?? []}
            canDelete={selected.type === "ai.prompt"}
            onPatch={patchSelected}
            onSetOutputType={setOutputType}
            onDelete={() => {
              removeNode(selected.id);
              setSelectedId(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function NodeInspector({
  node,
  boards,
  inWorkspace,
  connectors,
  canDelete,
  onPatch,
  onSetOutputType,
  onDelete,
}: {
  node: Node;
  boards: BoardOption[];
  inWorkspace: boolean;
  connectors: AvailableTaskConnector[];
  canDelete: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onSetOutputType: (type: string) => void;
  onDelete: () => void;
}) {
  const isOutput =
    node.type === "output.report" || node.type === "output.board_card";
  const { data: models } = useAvailableModels();
  const ai = node.data as unknown as AIPromptData;
  const modelKey =
    ai.provider_id && ai.model_id ? `${ai.provider_id}::${ai.model_id}` : "";
  return (
    <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
      {node.type === "ai.prompt" && (
        <>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Prompt
            <textarea
              value={(node.data as unknown as AIPromptData).prompt}
              onChange={(e) => onPatch({ prompt: e.target.value })}
              rows={8}
              className="mt-1 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              placeholder="What should this step do?"
            />
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Insert{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">
              {"{{upstream_output}}"}
            </code>{" "}
            to feed the previous step's output into this one.
          </p>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Model
            <select
              value={modelKey}
              onChange={(e) => {
                const [pid, mid] = e.target.value.split("::");
                onPatch({ provider_id: pid || null, model_id: mid || null });
              }}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option value="">No model — set one</option>
              {(models ?? []).map((m) => (
                <option
                  key={`${m.provider_id}::${m.model_id}`}
                  value={`${m.provider_id}::${m.model_id}`}
                >
                  {m.display_name} · {m.provider_name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between text-xs text-[var(--text)]">
            <span className="inline-flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-[var(--text-muted)]" /> Web search
            </span>
            <input
              type="checkbox"
              checked={ai.use_web_search}
              onChange={(e) => onPatch({ use_web_search: e.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>
          {connectors.length > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Connectors
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {ai.connector_ids.length} selected
                </span>
              </div>
              <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
                {connectors.map((c) => {
                  const on = ai.connector_ids.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-[var(--hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          onPatch({
                            connector_ids: on
                              ? ai.connector_ids.filter((x) => x !== c.id)
                              : [...ai.connector_ids, c.id],
                          })
                        }
                        className="h-3.5 w-3.5 accent-[var(--accent)]"
                      />
                      <span className="truncate text-[var(--text)]">{c.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">
                        {c.tool_count} tools
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                Read-only tools this step can call.
              </p>
            </div>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="mt-2 inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs text-[var(--danger)] transition hover:bg-[var(--danger-bg)]"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove step
            </button>
          )}
        </>
      )}

      {isOutput && (
        <>
          {/* What to do with the final AI result. "Board card" is offered for
              any workspace automation (a top-level one has no boards to write
              to). Gated on the workspace, not on boards having loaded, so the
              option is reliably present. */}
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-xs">
            {[
              { t: "output.report", label: "Report" },
              ...(inWorkspace
                ? [{ t: "output.board_card", label: "Board card" }]
                : []),
            ].map((o) => (
              <button
                key={o.t}
                type="button"
                onClick={() => onSetOutputType(o.t)}
                className={cn(
                  "rounded px-2 py-1 transition",
                  node.type === o.t
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          {node.type === "output.report" && (
            <label className="flex items-center justify-between text-xs text-[var(--text)]">
              <span>Notify on completion</span>
              <input
                type="checkbox"
                checked={(node.data as unknown as ReportOutputData).notify}
                onChange={(e) => onPatch({ notify: e.target.checked })}
                className="h-4 w-4 accent-[var(--accent)]"
              />
            </label>
          )}

          {node.type === "output.board_card" &&
            (boards.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">
                This workspace has no board yet — create a board in it, then pick
                it here.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-[var(--text-muted)]">
                  The AI result becomes a card — its first line is the title,
                  the rest the description.
                </p>
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Board
                  <select
                    value={
                      (node.data as unknown as BoardCardOutputData).board_item_id ??
                      ""
                    }
                    onChange={(e) =>
                      onPatch({
                        board_item_id: e.target.value || null,
                        board_title:
                          boards.find((b) => b.id === e.target.value)?.title ??
                          null,
                      })
                    }
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="">Select a board…</option>
                    {boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-2">
                  <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
                    Column
                    <select
                      value={(node.data as unknown as BoardCardOutputData).column}
                      onChange={(e) => onPatch({ column: e.target.value })}
                      className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    >
                      <option value="todo">To Do</option>
                      <option value="doing">In Progress</option>
                      <option value="done">Done</option>
                    </select>
                  </label>
                  <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
                    Priority
                    <select
                      value={(node.data as unknown as BoardCardOutputData).priority}
                      onChange={(e) => onPatch({ priority: e.target.value })}
                      className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </div>
              </>
            ))}
        </>
      )}

      {(node.type ?? "").startsWith("trigger.") &&
        (() => {
          const s = node.data as unknown as ScheduleTriggerData;
          const selCls =
            "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";
          const tzOptions = Array.from(
            new Set([...TIMEZONES, s.timezone].filter(Boolean))
          );
          return (
            <>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Frequency
                <select
                  value={s.frequency}
                  className={selCls}
                  onChange={(e) => {
                    const f = e.target.value;
                    const patch: Record<string, unknown> = { frequency: f };
                    if (f !== "hourly" && s.hour == null) patch.hour = 9;
                    if (f === "weekly" && s.weekday == null) patch.weekday = 0;
                    if (f === "monthly" && s.day_of_month == null)
                      patch.day_of_month = 1;
                    onPatch(patch);
                  }}
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {f[0].toUpperCase() + f.slice(1)}
                    </option>
                  ))}
                </select>
              </label>

              {s.frequency === "hourly" ? (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Minute past the hour
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={s.minute}
                    onChange={(e) =>
                      onPatch({
                        minute: Math.max(
                          0,
                          Math.min(59, Number(e.target.value) || 0)
                        ),
                      })
                    }
                    className={selCls}
                  />
                </label>
              ) : (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Time
                  <input
                    type="time"
                    value={`${pad(s.hour ?? 9)}:${pad(s.minute)}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      onPatch({ hour: h || 0, minute: m || 0 });
                    }}
                    className={selCls}
                  />
                </label>
              )}

              {s.frequency === "weekly" && (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Day of week
                  <select
                    value={s.weekday ?? 0}
                    className={selCls}
                    onChange={(e) => onPatch({ weekday: Number(e.target.value) })}
                  >
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {s.frequency === "monthly" && (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Day of month
                  <select
                    value={s.day_of_month ?? 1}
                    className={selCls}
                    onChange={(e) =>
                      onPatch({ day_of_month: Number(e.target.value) })
                    }
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="text-xs font-medium text-[var(--text-muted)]">
                Timezone
                <select
                  value={s.timezone}
                  className={selCls}
                  onChange={(e) => onPatch({ timezone: e.target.value })}
                >
                  {tzOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace("Australia/", "")}
                    </option>
                  ))}
                </select>
              </label>

              <p className="text-[11px] text-[var(--text-muted)]">
                Schedule changes take effect on Save.
              </p>
            </>
          );
        })()}
    </div>
  );
}
