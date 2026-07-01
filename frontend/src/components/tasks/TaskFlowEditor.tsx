import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Brain,
  Clock,
  FileText,
  Globe,
  Loader2,
  Plus,
  Save,
  Trash2,
  Zap,
} from "lucide-react";

import {
  type AIPromptData,
  type FlowGraph,
  type FlowNodeModel,
  type ReportOutputData,
  type ScheduleTriggerData,
} from "@/api/tasks";
import { useSaveTaskGraph, useTaskGraph } from "@/hooks/useTasks";
import { useThemeStore } from "@/store/themeStore";
import { cn } from "@/utils/cn";

// ---------------------------------------------------------------------
// Node category colours — the app's own warm palette (green triggers,
// terracotta "brain" AI steps, amber output), not n8n's stock hues, so the
// editor reads as native. Actions/flow-control land in later phases.
// ---------------------------------------------------------------------
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

const nodeTypes = {
  "trigger.schedule": TriggerNode,
  "trigger.manual": TriggerNode,
  "ai.prompt": AINode,
  "output.report": OutputNode,
};

// --- graph ⇄ react-flow ---------------------------------------------
function toRF(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { ...n.data },
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

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!graph) return;
    const rf = toRF(graph);
    setNodes(rf.nodes);
    setEdges(rf.edges);
    setDirty(false);
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

  const aiNodes = nodes.filter((n) => n.type === "ai.prompt");

  // Append an AI step just before the output, rewiring the chain
  // (…last → new → output). New step inherits the previous step's model so
  // the chain stays runnable.
  const addAIStep = useCallback(() => {
    const output = nodes.find((n) => n.type === "output.report");
    if (!output) return;
    const lastAi = aiNodes[aiNodes.length - 1];
    const prev = lastAi ?? nodes.find((n) => n.type?.startsWith("trigger."));
    if (!prev) return;
    const id = `ai_${Date.now().toString(36)}`;
    const model = (lastAi?.data as unknown as AIPromptData | undefined) ?? null;
    const newNode: Node = {
      id,
      type: "ai.prompt",
      position: { x: prev.position.x + 280, y: prev.position.y },
      data: {
        prompt: "Use the previous step's output:\n\n{{upstream_output}}",
        provider_id: model?.provider_id ?? null,
        model_id: model?.model_id ?? null,
        reasoning_effort: model?.reasoning_effort ?? null,
        use_web_search: false,
        connector_ids: [],
      } as unknown as Record<string, unknown>,
    };
    // Shift the output (and anything at/after it) right to make room.
    setNodes((ns) =>
      ns
        .map((n) =>
          n.id === output.id
            ? { ...n, position: { ...n.position, x: n.position.x + 280 } }
            : n
        )
        .concat(newNode)
    );
    setEdges((es) =>
      es
        .filter((e) => !(e.source === prev.id && e.target === output.id))
        .concat([
          { id: `${prev.id}->${id}`, source: prev.id, target: id },
          { id: `${id}->${output.id}`, source: id, target: output.id },
        ])
    );
    setSelectedId(id);
    setDirty(true);
  }, [nodes, aiNodes, setNodes, setEdges]);

  // Remove an AI step, healing the chain (its predecessor connects straight
  // to its successor). Disabled for the last remaining AI step.
  const removeAIStep = useCallback(
    (id: string) => {
      const incoming = edges.find((e) => e.target === id);
      const outgoing = edges.find((e) => e.source === id);
      if (!incoming || !outgoing) return;
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) =>
        es
          .filter((e) => e.source !== id && e.target !== id)
          .concat({
            id: `${incoming.source}->${outgoing.target}`,
            source: incoming.source,
            target: outgoing.target,
          })
      );
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
            onClick={addAIStep}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
          >
            <Plus className="h-3.5 w-3.5" /> AI step
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

        <ReactFlow
          colorMode={colorMode}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          onNodeDragStop={() => setDirty(true)}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-[var(--surface)]" />
        </ReactFlow>
      </div>

      {/* Inspector */}
      {selected && (
        <NodeInspector
          node={selected}
          canDelete={selected.type === "ai.prompt" && aiNodes.length > 1}
          onPatch={patchSelected}
          onDelete={() => removeAIStep(selected.id)}
        />
      )}
    </div>
  );
}

function NodeInspector({
  node,
  canDelete,
  onPatch,
  onDelete,
}: {
  node: Node;
  canDelete: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border)] bg-[var(--bg)] p-4">
      {node.type === "ai.prompt" && (
        <>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <Brain className="h-4 w-4 text-[var(--accent)]" /> AI step
          </div>
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
          <label className="flex items-center justify-between text-xs text-[var(--text)]">
            <span className="inline-flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-[var(--text-muted)]" /> Web search
            </span>
            <input
              type="checkbox"
              checked={(node.data as unknown as AIPromptData).use_web_search}
              onChange={(e) => onPatch({ use_web_search: e.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>
          <div className="text-[11px] text-[var(--text-muted)]">
            Model:{" "}
            <span className="text-[var(--text)]">
              {(node.data as unknown as AIPromptData).model_id || "inherited / none"}
            </span>
            <span className="block">Set the model in the Simple editor.</span>
          </div>
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

      {node.type === "output.report" && (
        <>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <FileText className="h-4 w-4 text-[var(--warning)]" /> Report
          </div>
          <label className="flex items-center justify-between text-xs text-[var(--text)]">
            <span>Notify on completion</span>
            <input
              type="checkbox"
              checked={(node.data as unknown as ReportOutputData).notify}
              onChange={(e) => onPatch({ notify: e.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>
        </>
      )}

      {(node.type ?? "").startsWith("trigger.") && (
        <>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <Clock className="h-4 w-4 text-[var(--success)]" /> Schedule
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {scheduleSummary(node.data as unknown as ScheduleTriggerData)}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            Edit the schedule in the Simple editor for now.
          </p>
        </>
      )}
    </aside>
  );
}
