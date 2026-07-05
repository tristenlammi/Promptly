import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  useNodeId,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Columns3,
  Download,
  FileText,
  GitBranch,
  GitMerge,
  Globe,
  HelpCircle,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  NotebookPen,
  Pin,
  Play,
  Plug,
  Plus,
  Repeat2,
  ScanText,
  Save,
  Search,
  Sheet,
  Sparkles,
  Split,
  StickyNote,
  Telescope,
  Timer,
  Trash2,
  TextQuote,
  Webhook,
  X,
  Zap,
} from "lucide-react";

import {
  tasksApi,
  type AIPromptData,
  type AvailableTaskConnector,
  type BoardCardOutputData,
  type ChatMessageOutputData,
  type ConditionData,
  type DeepResearchData,
  type DelayData,
  type ExtractData,
  type FetchPageData,
  type HttpHeader,
  type HttpRequestData,
  type McpActionData,
  type LoopData,
  type MemoryData,
  type MergeData,
  type NoteOutputData,
  type SheetOutputData,
  type SummariseData,
  type FlowGraph,
  type FlowNodeModel,
  type ReportOutputData,
  type RouterCategory,
  type RouterData,
  type ScheduleTriggerData,
  type TaskRun,
  type WebSearchData,
} from "@/api/tasks";
import {
  useSaveTaskGraph,
  useTask,
  useTaskGraph,
  useUpdateTask,
} from "@/hooks/useTasks";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import { useAvailableModels } from "@/hooks/useProviders";
import { secretsApi } from "@/api/secrets";
import { useThemeStore } from "@/store/themeStore";
import { Modal } from "@/components/shared/Modal";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { cn } from "@/utils/cn";

// Shared by the custom node renderers so "Detailed" mode can show each node's
// full settings on its face (the same inspector, rendered inline). Provided by
// the editor around the ReactFlow canvas.
interface FlowEditCtx {
  detailed: boolean;
  expandedIds: Set<string>;
  toggleExpanded: (id: string) => void;
  boards: BoardOption[];
  chats: BoardOption[];
  folders: BoardOption[];
  connectors: AvailableTaskConnector[];
  inWorkspace: boolean;
  outputsCount: number;
  memory: import("@/api/tasks").TaskMemory;
  clearMemory: (nodeId: string) => void;
  // Build-time test loop: last input/output per node, pins, run-to-here.
  nodeData: Record<string, { input: string; output: string; status: string }>;
  pins: Record<string, string>;
  runningNode: string | null;
  runToHere: (nodeId: string) => void;
  togglePin: (nodeId: string) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  setOutputTypeFor: (id: string, type: string) => void;
  removeNode: (id: string) => void;
}
const FlowEditContext = createContext<FlowEditCtx | null>(null);

/** Whether a node should show its settings inline — the global Detailed toggle,
 *  or this node individually expanded via its header caret. */
function nodeIsExpanded(ctx: FlowEditCtx | null, id: string | null): boolean {
  return !!ctx && (ctx.detailed || (id != null && ctx.expandedIds.has(id)));
}

/** The inline settings panel for a node when expanded; else null. Called at the
 *  top of every custom node so the hook order stays stable. */
function useDetailed(
  id: string,
  type: string,
  data: unknown
): React.ReactNode | null {
  const ctx = useContext(FlowEditContext);
  if (!nodeIsExpanded(ctx, id) || !ctx) return null;
  return <InlineNodeSettings ctx={ctx} node={{ id, type, data } as Node} />;
}

/** The expand/collapse caret shown in a node header (when not in global
 *  Detailed mode). Uses React Flow's node id so no prop threading is needed. */
function NodeExpandToggle() {
  const ctx = useContext(FlowEditContext);
  const nodeId = useNodeId();
  if (!ctx || ctx.detailed || !nodeId) return null;
  const expanded = ctx.expandedIds.has(nodeId);
  return (
    <button
      type="button"
      className="nodrag ml-auto -mr-1 rounded p-0.5 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
      title={expanded ? "Collapse" : "Show settings"}
      onClick={(e) => {
        e.stopPropagation();
        ctx.toggleExpanded(nodeId);
      }}
    >
      {expanded ? (
        <ChevronUp className="h-3.5 w-3.5" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function InlineNodeSettings({
  ctx,
  node,
}: {
  ctx: FlowEditCtx;
  node: Node;
}) {
  const t = node.type ?? "";
  const isOutput = t.startsWith("output.");
  const canDelete =
    PROCESSING_NODE_TYPES.has(t) || (isOutput && ctx.outputsCount > 1);
  // `nodrag`/`nowheel` so editing fields doesn't pan/drag the canvas.
  return (
    <div className="nodrag nowheel mt-1 border-t border-[var(--border)] pt-2">
      <NodeInspector
        node={node}
        boards={ctx.boards}
        chats={ctx.chats}
        folders={ctx.folders}
        memory={ctx.memory[node.id]?.entries ?? []}
        onClearMemory={() => ctx.clearMemory(node.id)}
        nodeData={ctx.nodeData[node.id]}
        pinned={node.id in ctx.pins}
        running={ctx.runningNode === node.id}
        onRunToHere={() => ctx.runToHere(node.id)}
        onTogglePin={() => ctx.togglePin(node.id)}
        inWorkspace={ctx.inWorkspace}
        connectors={ctx.connectors}
        canDelete={canDelete}
        onPatch={(p) => ctx.updateNodeData(node.id, p)}
        onSetOutputType={(ty) => ctx.setOutputTypeFor(node.id, ty)}
        onDelete={() => ctx.removeNode(node.id)}
        inline
      />
    </div>
  );
}

// --- Variable picker: type {{ in a template field to insert a run variable ---
interface FlowVar {
  token: string;
  label: string;
}
const DEFAULT_VARS: FlowVar[] = [
  { token: "upstream_output", label: "The previous step's output" },
  { token: "json.field", label: "A field from upstream JSON (rename 'field')" },
  { token: "date", label: "Run date (YYYY-MM-DD)" },
  { token: "time", label: "Run time (HH:MM)" },
  { token: "datetime", label: "Run date & time" },
  { token: "trigger.payload", label: "The trigger's payload" },
  { token: "trigger.timestamp", label: "When the run started" },
];
const LOOP_VARS: FlowVar[] = [
  { token: "item", label: "The current loop item" },
  { token: "item_index", label: "The item's number (from 1)" },
  ...DEFAULT_VARS,
];

const FIELD_CLASS =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

function VariableField({
  value,
  onChange,
  variables,
  multiline,
  rows,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  variables: FlowVar[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Open the picker when the caret sits just after an unclosed ``{`` / ``{{``.
  const refresh = (val: string, caret: number | null) => {
    if (caret == null) return setOpen(false);
    const m = val.slice(0, caret).match(/\{\{?\s*([\w.]*)$/);
    if (m) {
      setQuery(m[1]);
      setOpen(true);
    } else {
      setOpen(false);
    }
  };
  const handleChange = (
    e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>
  ) => {
    onChange(e.target.value);
    refresh(e.target.value, e.target.selectionStart);
  };
  const handleCaret = (
    e: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>
  ) => refresh(e.currentTarget.value, e.currentTarget.selectionStart);

  const insert = (token: string) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const beforeRaw = value.slice(0, caret);
    const after = value.slice(caret);
    // Replace an in-progress ``{``/``{{`` token if present, else insert fresh.
    const m = beforeRaw.match(/\{\{?\s*[\w.]*$/);
    const before =
      m && m.index != null
        ? beforeRaw.slice(0, m.index) + `{{${token}}}`
        : beforeRaw + `{{${token}}}`;
    const next = before + after;
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };
  const openPicker = () => {
    setQuery("");
    setOpen(true);
    ref.current?.focus();
  };

  const filtered = variables.filter((v) =>
    v.token.toLowerCase().includes(query.toLowerCase())
  );
  const shared = {
    value,
    onChange: handleChange,
    onKeyUp: handleCaret,
    onClick: handleCaret,
    onBlur: () => window.setTimeout(() => setOpen(false), 120),
    placeholder,
    className: cn(FIELD_CLASS, multiline && "resize-y"),
  };

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          rows={rows ?? 4}
          {...shared}
        />
      ) : (
        <input ref={ref as React.RefObject<HTMLInputElement>} {...shared} />
      )}
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          openPicker();
        }}
        className="mt-1 inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)] transition hover:text-[var(--accent)]"
        title="Insert a variable (or just type {)"
      >
        <Braces className="h-3 w-3" /> Insert variable
      </button>
      {open && filtered.length > 0 && (
        <ul className="nodrag nowheel absolute z-50 mt-1 max-h-44 w-full overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
          {filtered.map((v) => (
            <li key={v.token}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(v.token);
                }}
                className="flex w-full flex-col items-start px-2.5 py-1 text-left transition hover:bg-[var(--hover)]"
              >
                <code className="text-[11px] text-[var(--accent)]">{`{{${v.token}}}`}</code>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {v.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function nodeModalTitle(type?: string): string {
  if (type === "ai.prompt") return "AI step";
  if (type === "ai.summarise") return "Summarise";
  if (type === "ai.extract") return "Extract";
  if (type === "search.web") return "Web search";
  if (type === "fetch.page") return "Fetch page";
  if (type === "research.deep") return "Deep research";
  if (type === "loop.foreach") return "Loop";
  if (type === "memory.store") return "Memory";
  if (type === "flow.merge") return "Merge";
  if (type === "flow.delay") return "Delay";
  if (type === "control.condition") return "Condition";
  if (type === "control.router") return "Router";
  if (
    type === "output.report" ||
    type === "output.board_card" ||
    type === "output.chat_message" ||
    type === "output.note" ||
    type === "output.sheet"
  )
    return "Output";
  if (type === "trigger.webhook") return "Webhook";
  if (type?.startsWith("trigger.")) return "Schedule";
  return "Node";
}

const CONDITION_OPERATORS: { value: string; label: string; needsValue: boolean }[] =
  [
    { value: "contains", label: "contains", needsValue: true },
    { value: "not_contains", label: "does not contain", needsValue: true },
    { value: "equals", label: "equals", needsValue: true },
    { value: "not_equals", label: "does not equal", needsValue: true },
    { value: "matches", label: "matches regex", needsValue: true },
    { value: "is_empty", label: "is empty", needsValue: false },
    { value: "is_not_empty", label: "is not empty", needsValue: false },
  ];

const genCategoryId = () => "c_" + Math.random().toString(36).slice(2, 8);

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
  const ctx = useContext(FlowEditContext);
  const nodeId = useNodeId();
  const expanded = nodeIsExpanded(ctx, nodeId);
  return (
    <div
      className={cn(
        "rounded-card border bg-[var(--surface)] shadow-sm transition",
        expanded ? "w-80" : "w-60",
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
        <NodeExpandToggle />
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

function TriggerNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as ScheduleTriggerData;
  const detail = useDetailed(id, type ?? "trigger.schedule", data);
  if (type === "trigger.webhook") {
    return (
      <NodeShell
        icon={<Webhook className="h-3.5 w-3.5" />}
        label="Webhook"
        accent="var(--success)"
        selected={selected}
        hasOut
      >
        {detail ?? (
          <>
            <div className="truncate text-[var(--text)]">POST to fire</div>
            <div className="mt-0.5 truncate">URL in the trigger settings</div>
          </>
        )}
      </NodeShell>
    );
  }
  return (
    <NodeShell
      icon={<Clock className="h-3.5 w-3.5" />}
      label="Schedule"
      accent="var(--success)"
      selected={selected}
      hasOut
    >
      {detail ?? (
        <>
          <div className="truncate text-[var(--text)]">{scheduleSummary(d)}</div>
          <div className="mt-0.5 truncate">{d.timezone}</div>
        </>
      )}
    </NodeShell>
  );
}

function AINode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as AIPromptData;
  const detail = useDetailed(id, type ?? "ai.prompt", data);
  return (
    <NodeShell
      icon={<Brain className="h-3.5 w-3.5" />}
      label="AI step"
      accent="var(--accent)"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
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
        </>
      )}
    </NodeShell>
  );
}

function SummariseNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as SummariseData;
  const detail = useDetailed(id, type ?? "ai.summarise", data);
  return (
    <NodeShell
      icon={<TextQuote className="h-3.5 w-3.5" />}
      label="Summarise"
      accent="var(--accent)"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="text-[var(--text)]">Condenses the upstream text</div>
          <div className="mt-1">
            <span className="truncate rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.model_id || "no model"}
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function ExtractNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as ExtractData;
  const detail = useDetailed(id, type ?? "ai.extract", data);
  return (
    <NodeShell
      icon={<ScanText className="h-3.5 w-3.5" />}
      label="Extract data"
      accent="var(--accent)"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="line-clamp-2 text-[var(--text)]">
            {d.spec || (
              <span className="italic text-[var(--text-muted)]">
                Pulls JSON fields
              </span>
            )}
          </div>
          <div className="mt-1">
            <span className="truncate rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.model_id || "no model"}
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function SearchNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as WebSearchData;
  const detail = useDetailed(id, type ?? "search.web", data);
  return (
    <NodeShell
      icon={<Search className="h-3.5 w-3.5" />}
      label="Web search"
      accent="#3b82f6"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="line-clamp-2 text-[var(--text)]">
            {d.query || (
              <span className="italic text-[var(--text-muted)]">
                Searches the upstream text
              </span>
            )}
          </div>
          <div className="mt-1">
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.count || 5} results
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function FetchNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as FetchPageData;
  const detail = useDetailed(id, type ?? "fetch.page", data);
  return (
    <NodeShell
      icon={<Download className="h-3.5 w-3.5" />}
      label="Fetch page"
      accent="#3b82f6"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="truncate text-[var(--text)]">
            {d.url || (
              <span className="italic text-[var(--text-muted)]">
                First URL from upstream
              </span>
            )}
          </div>
          <div className="mt-1">
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              reader text
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function HttpNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as HttpRequestData;
  const detail = useDetailed(id, type ?? "http.request", data);
  return (
    <NodeShell
      icon={<Globe className="h-3.5 w-3.5" />}
      label="HTTP request"
      accent="#3b82f6"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold">
              {d.method || "GET"}
            </span>
            <span className="truncate text-[var(--text)]">
              {d.url || (
                <span className="italic text-[var(--text-muted)]">No URL yet</span>
              )}
            </span>
          </div>
          <div className="mt-1 truncate text-[10px] text-[var(--text-muted)]">
            {(d.headers?.length ?? 0) > 0
              ? `${d.headers.length} header${d.headers.length === 1 ? "" : "s"}`
              : "JSON response → {{json.*}}"}
          </div>
        </>
      )}
    </NodeShell>
  );
}

function McpNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as McpActionData;
  const detail = useDetailed(id, type ?? "mcp.action", data);
  return (
    <NodeShell
      icon={<Plug className="h-3.5 w-3.5" />}
      label="Tool action"
      accent="#0ea5e9"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <div className="truncate text-[var(--text)]">
          {d.tool_name || (
            <span className="italic text-[var(--text-muted)]">
              Pick a connector tool
            </span>
          )}
        </div>
      )}
    </NodeShell>
  );
}

function DeepResearchNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as DeepResearchData;
  const detail = useDetailed(id, type ?? "research.deep", data);
  return (
    <NodeShell
      icon={<Telescope className="h-3.5 w-3.5" />}
      label="Deep research"
      accent="#0ea5e9"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="line-clamp-2 text-[var(--text)]">
            {d.query || (
              <span className="italic text-[var(--text-muted)]">
                Researches the upstream text
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.max_pages || 5} pages
            </span>
            <span className="truncate rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.model_id || "no model"}
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function LoopNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as LoopData;
  const detail = useDetailed(id, type ?? "loop.foreach", data);
  return (
    <NodeShell
      icon={<Repeat2 className="h-3.5 w-3.5" />}
      label="Loop"
      accent="#f97316"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="line-clamp-2 text-[var(--text)]">
            {d.prompt || (
              <span className="italic text-[var(--text-muted)]">
                Runs a step per item
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              per {d.split_mode === "json" ? "JSON item" : "line"}
            </span>
            <span className="truncate rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.model_id || "no model"}
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function MemoryNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as MemoryData;
  const ctx = useContext(FlowEditContext);
  const detail = useDetailed(id, type ?? "memory.store", data);
  const entries = ctx?.memory[id]?.entries ?? [];
  const latest = entries[entries.length - 1]?.value ?? "";
  return (
    <NodeShell
      icon={<StickyNote className="h-3.5 w-3.5" />}
      label={d.name || "Memory"}
      accent="#eab308"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          {/* Sticky-note face: the last remembered value, or a hint. */}
          <div className="line-clamp-3 whitespace-pre-wrap rounded bg-[#eab308]/10 px-1.5 py-1 text-[11px] text-[var(--text)]">
            {latest || (
              <span className="italic text-[var(--text-muted)]">
                Captures the previous step's output
              </span>
            )}
          </div>
          <div className="mt-1">
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px]">
              {d.remember ? `remembers ${d.max_runs || 5} runs` : "sticky note"}
            </span>
          </div>
        </>
      )}
    </NodeShell>
  );
}

function MergeNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as MergeData;
  const detail = useDetailed(id, type ?? "flow.merge", data);
  return (
    <NodeShell
      icon={<GitMerge className="h-3.5 w-3.5" />}
      label="Merge"
      accent="#f97316"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? (
        <>
          <div className="text-[var(--text)]">
            {d.mode === "any"
              ? "Proceeds with any branch"
              : "Waits for all branches"}
          </div>
          <div className="mt-0.5">Joins their outputs</div>
        </>
      )}
    </NodeShell>
  );
}

function DelayNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as DelayData;
  const s = d.seconds || 0;
  const label = s >= 60 ? `${Math.round(s / 60)} min` : `${s} sec`;
  const detail = useDetailed(id, type ?? "flow.delay", data);
  return (
    <NodeShell
      icon={<Timer className="h-3.5 w-3.5" />}
      label="Delay"
      accent="#f97316"
      selected={selected}
      hasIn
      hasOut
    >
      {detail ?? <div className="text-[var(--text)]">Pauses {label}</div>}
    </NodeShell>
  );
}

// A control node with several labelled *source* handles on the right — one per
// branch. React Flow reads each handle's real DOM position, so absolutely
// positioning them per-row lets edges leave from the right branch.
function BranchNode({
  icon,
  label,
  accent,
  selected,
  header,
  branches,
  body,
}: {
  icon: React.ReactNode;
  label: string;
  accent: string;
  selected?: boolean;
  header: React.ReactNode;
  branches: { id: string; label: string; color: string }[];
  body?: React.ReactNode;
}) {
  const ctx = useContext(FlowEditContext);
  const nodeId = useNodeId();
  const expanded = nodeIsExpanded(ctx, nodeId);
  return (
    <div
      className={cn(
        "rounded-card border bg-[var(--surface)] shadow-sm transition",
        expanded ? "w-80" : "w-60",
        selected
          ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/30"
          : "border-[var(--border)]"
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-[var(--surface)]"
        style={{ background: accent }}
      />
      <div
        className="flex items-center gap-2 rounded-t-card px-3 py-2 text-xs font-semibold"
        style={{ color: accent }}
      >
        {icon}
        <span className="truncate">{label}</span>
        <NodeExpandToggle />
      </div>
      <div className="px-3 pb-1 text-xs text-[var(--text-muted)]">{header}</div>
      {body && <div className="px-3 pb-1">{body}</div>}
      <div className="pb-2">
        {branches.length === 0 ? (
          <div className="px-3 py-1 text-[11px] italic text-[var(--text-muted)]">
            No branches yet
          </div>
        ) : (
          branches.map((b) => (
            <div
              key={b.id}
              className="relative flex items-center justify-end py-1 pr-4 text-[11px] font-medium"
              style={{ color: b.color }}
            >
              <span className="truncate">{b.label}</span>
              <Handle
                id={b.id}
                type="source"
                position={Position.Right}
                className="!h-2.5 !w-2.5 !border-2 !border-[var(--surface)]"
                style={{
                  background: b.color,
                  right: -5,
                  top: "50%",
                  transform: "translateY(-50%)",
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConditionNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as ConditionData;
  const op = CONDITION_OPERATORS.find((o) => o.value === d.operator);
  const detail = useDetailed(id, type ?? "control.condition", data);
  return (
    <BranchNode
      icon={<GitBranch className="h-3.5 w-3.5" />}
      label="Condition"
      accent="#a855f7"
      selected={selected}
      header={
        detail ? null : (
          <span className="text-[var(--text)]">
            input {op?.label ?? d.operator}
            {op?.needsValue && d.value ? ` "${d.value}"` : ""}
          </span>
        )
      }
      body={detail}
      branches={[
        { id: "true", label: "✓ true", color: "var(--success)" },
        { id: "false", label: "✗ false", color: "var(--danger)" },
      ]}
    />
  );
}

function RouterNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as RouterData;
  const detail = useDetailed(id, type ?? "control.router", data);
  return (
    <BranchNode
      icon={<Split className="h-3.5 w-3.5" />}
      label="Router"
      accent="#a855f7"
      selected={selected}
      header={detail ? null : <span>AI classifies into one branch</span>}
      body={detail}
      branches={(d.categories ?? []).map((c) => ({
        id: c.id,
        label: c.name || c.id,
        color: "#a855f7",
      }))}
    />
  );
}

function OutputNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as ReportOutputData;
  const detail = useDetailed(id, type ?? "output.report", data);
  return (
    <NodeShell
      icon={<FileText className="h-3.5 w-3.5" />}
      label="Report"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      {detail ?? (
        <>
          <div className="text-[var(--text)]">Saved as a run report</div>
          <div className="mt-0.5">
            {d.notify ? "Notifies on completion" : "No notification"}
          </div>
        </>
      )}
    </NodeShell>
  );
}

function BoardCardNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as BoardCardOutputData & { board_title?: string };
  const detail = useDetailed(id, type ?? "output.board_card", data);
  return (
    <NodeShell
      icon={<Columns3 className="h-3.5 w-3.5" />}
      label="Create card"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      {detail ?? (
        <>
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
        </>
      )}
    </NodeShell>
  );
}

function SendMessageNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as ChatMessageOutputData & { chat_title?: string };
  const detail = useDetailed(id, type ?? "output.chat_message", data);
  return (
    <NodeShell
      icon={<MessageSquare className="h-3.5 w-3.5" />}
      label="Send message"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      {detail ?? (
        <div className="truncate text-[var(--text)]">
          {d.chat_item_id ? (
            d.chat_title || "To a chat"
          ) : (
            <span className="italic text-[var(--text-muted)]">Pick a chat</span>
          )}
        </div>
      )}
    </NodeShell>
  );
}

function NoteOutNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as NoteOutputData;
  const detail = useDetailed(id, type ?? "output.note", data);
  return (
    <NodeShell
      icon={<NotebookPen className="h-3.5 w-3.5" />}
      label="Create note"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      {detail ?? (
        <div className="truncate text-[var(--text)]">
          {d.title ? `"${d.title}"` : "New note from the result"}
        </div>
      )}
    </NodeShell>
  );
}

function SheetOutNode({ id, type, data, selected }: NodeProps) {
  const d = data as unknown as SheetOutputData;
  const detail = useDetailed(id, type ?? "output.sheet", data);
  return (
    <NodeShell
      icon={<Sheet className="h-3.5 w-3.5" />}
      label="Create sheet"
      accent="var(--warning)"
      selected={selected}
      hasIn
    >
      {detail ?? (
        <div className="truncate text-[var(--text)]">
          {d.title ? `"${d.title}"` : "New sheet from the result"}
        </div>
      )}
    </NodeShell>
  );
}

// ---------------------------------------------------------------------
// Output view (A1 data pane): when a node's output parses as JSON, render
// a collapsible tree where clicking a leaf copies its {{node_<id>.json.path}}
// token — turning the engine's existing field-access power into something
// users can see and grab. Plain text falls back to the <pre>.
// ---------------------------------------------------------------------
function OutputView({ text, nodeId }: { text: string; nodeId: string }) {
  const [tab, setTab] = useState<"tree" | "raw">("tree");
  const [copied, setCopied] = useState<string | null>(null);
  const parsed = useMemo(() => {
    const t = text.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return undefined;
    }
  }, [text]);

  if (parsed === undefined) {
    return (
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-[var(--text)]">
        {text || "(empty)"}
      </pre>
    );
  }

  const copyToken = (path: string) => {
    const token = `{{node_${nodeId}.json${path}}}`;
    void navigator.clipboard?.writeText(token);
    setCopied(path);
    window.setTimeout(() => setCopied((c) => (c === path ? null : c)), 1200);
  };

  return (
    <div className="mt-1">
      <div className="mb-1 flex items-center gap-2">
        <div className="inline-flex overflow-hidden rounded border border-[var(--border)]">
          {(["tree", "raw"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                "px-1.5 py-0.5 text-[10px] capitalize transition",
                tab === k
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              {k === "tree" ? "JSON" : "Raw"}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[var(--text-muted)]">
          click a field to copy its variable
        </span>
      </div>
      {tab === "raw" ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-[var(--text)]">
          {text}
        </pre>
      ) : (
        <div className="max-h-48 overflow-auto rounded bg-[var(--bg)] p-1.5 font-mono text-[11px]">
          <JsonTree value={parsed} path="" onCopy={copyToken} copied={copied} />
        </div>
      )}
    </div>
  );
}

function JsonTree({
  value,
  path,
  onCopy,
  copied,
  keyName,
  depth = 0,
}: {
  value: unknown;
  path: string;
  onCopy: (path: string) => void;
  copied: string | null;
  keyName?: string;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === "object";
  const label = keyName !== undefined && (
    <span className="text-[var(--accent)]">{keyName}: </span>
  );

  if (!isObj) {
    // Leaf — the clickable, copyable node.
    const display =
      typeof value === "string"
        ? `"${value.length > 60 ? value.slice(0, 60) + "…" : value}"`
        : String(value);
    return (
      <button
        type="button"
        onClick={() => onCopy(path)}
        title={`Copy {{node.json${path}}}`}
        className="group flex w-full items-baseline gap-1 rounded px-1 text-left hover:bg-[var(--hover)]"
      >
        {label}
        <span className="truncate text-[var(--text)]">{display}</span>
        {copied === path && (
          <span className="ml-auto shrink-0 text-[9px] text-[var(--success)]">
            copied
          </span>
        )}
      </button>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const bracket = Array.isArray(value)
    ? `[${entries.length}]`
    : `{${entries.length}}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded px-1 hover:bg-[var(--hover)]"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform",
            open && "rotate-90"
          )}
        />
        {label}
        <span className="text-[var(--text-muted)]">{bracket}</span>
      </button>
      {open && (
        <div className="ml-3 border-l border-[var(--border)] pl-1.5">
          {entries.map(([k, v]) => {
            const childPath = Array.isArray(value)
              ? `${path}.${k}`
              : `${path}.${k}`;
            return (
              <JsonTree
                key={k}
                value={v}
                path={childPath}
                keyName={k}
                onCopy={onCopy}
                copied={copied}
                depth={depth + 1}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** MCP action node config (A2) — connector → tool → templated JSON args.
 *  Deterministic tool call, no model involved. */
function McpActionConfig({
  node,
  onPatch,
  connectors,
}: {
  node: { data: unknown };
  onPatch: (patch: Record<string, unknown>) => void;
  connectors: AvailableTaskConnector[];
}) {
  const d = node.data as unknown as McpActionData;
  const selected = connectors.find((c) => c.id === d.connector_id) ?? null;
  const tools = selected?.tools ?? [];
  const inputCls =
    "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

  if (connectors.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        No connectors are available. An admin adds MCP servers under
        Admin ▸ Connectors; this step then calls one of their tools directly.
      </p>
    );
  }

  return (
    <>
      <p className="text-[11px] text-[var(--text-muted)]">
        Calls a connector tool directly — no model decides whether to run it
        (that's the AI step's job). The result flows downstream as text and,
        if it's JSON, as {"{{json.*}}"}.
      </p>
      <label className="text-xs font-medium text-[var(--text-muted)]">
        Connector
        <select
          value={d.connector_id ?? ""}
          onChange={(e) =>
            onPatch({ connector_id: e.target.value || null, tool_name: "" })
          }
          className={inputCls}
        >
          <option value="">Select a connector…</option>
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <label className="text-xs font-medium text-[var(--text-muted)]">
          Tool
          <select
            value={d.tool_name}
            onChange={(e) => onPatch({ tool_name: e.target.value })}
            className={inputCls}
          >
            <option value="">Select a tool…</option>
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          {d.tool_name &&
            tools.find((t) => t.name === d.tool_name)?.description && (
              <span className="mt-1 block text-[10px] leading-snug text-[var(--text-muted)]">
                {tools.find((t) => t.name === d.tool_name)?.description}
              </span>
            )}
        </label>
      )}
      <label className="text-xs font-medium text-[var(--text-muted)]">
        Arguments (JSON)
        <div className="mt-1">
          <VariableField
            value={d.arguments}
            onChange={(v) => onPatch({ arguments: v })}
            variables={DEFAULT_VARS}
            multiline
            rows={4}
            placeholder={'{"site_id": "{{json.id}}"}'}
          />
        </div>
        <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
          Must render to a JSON object. Reference upstream data with{" "}
          <code className="rounded bg-[var(--surface-2)] px-1">
            {"{{json.field}}"}
          </code>{" "}
          etc. Use <code className="rounded bg-[var(--surface-2)] px-1">{"{}"}</code>{" "}
          for a no-argument tool.
        </span>
      </label>
    </>
  );
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** HTTP-request node config (A1) — method, templated URL, headers with a
 *  ⊕/× editor, JSON/text body, and the safety knobs. The credentials vault
 *  is surfaced inline so `{{secret.NAME}}` is discoverable at the point of
 *  use. */
function HttpRequestConfig({
  node,
  onPatch,
}: {
  node: { data: unknown };
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const d = node.data as unknown as HttpRequestData;
  const headers = d.headers ?? [];
  const { data: secrets } = useQuery({
    queryKey: ["secrets"],
    queryFn: () => secretsApi.list(),
    staleTime: 30_000,
  });
  const inputCls =
    "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

  const patchHeader = (i: number, patch: Partial<HttpHeader>) => {
    const next = headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h));
    onPatch({ headers: next });
  };

  return (
    <>
      <div className="flex gap-2">
        <label className="text-xs font-medium text-[var(--text-muted)]">
          Method
          <select
            value={d.method || "GET"}
            onChange={(e) => onPatch({ method: e.target.value })}
            className={inputCls}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
          URL
          <div className="mt-1">
            <VariableField
              value={d.url}
              onChange={(v) => onPatch({ url: v })}
              variables={DEFAULT_VARS}
              placeholder="https://api.example.com/v1/…"
            />
          </div>
        </label>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Headers
          </span>
          <button
            type="button"
            onClick={() =>
              onPatch({ headers: [...headers, { name: "", value: "" }] })
            }
            className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
        {headers.length === 0 ? (
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            e.g. <code className="rounded bg-[var(--surface-2)] px-1">
              Authorization
            </code>{" "}
            ={" "}
            <code className="rounded bg-[var(--surface-2)] px-1">
              {"Bearer {{secret.NAME}}"}
            </code>
          </p>
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {headers.map((h, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={h.name}
                  onChange={(e) => patchHeader(i, { name: e.target.value })}
                  placeholder="Header"
                  className="w-1/3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
                <input
                  value={h.value}
                  onChange={(e) => patchHeader(i, { value: e.target.value })}
                  placeholder="Value ({{secret.NAME}})"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() =>
                    onPatch({ headers: headers.filter((_, idx) => idx !== i) })
                  }
                  aria-label="Remove header"
                  className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {d.method !== "GET" && (
        <label className="text-xs font-medium text-[var(--text-muted)]">
          Body
          <div className="mt-1">
            <VariableField
              value={d.body}
              onChange={(v) => onPatch({ body: v })}
              variables={DEFAULT_VARS}
              multiline
              rows={4}
              placeholder={'{"key": "{{upstream_output}}"}'}
            />
          </div>
          <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
            Valid JSON is sent as <code>application/json</code>; anything else
            as plain text.
          </span>
        </label>
      )}

      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2">
        <div className="text-[11px] font-medium text-[var(--text-muted)]">
          Credentials
        </div>
        {secrets && secrets.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {secrets.map((s) => (
              <code
                key={s.id}
                title="Reference this in the URL, a header, or the body"
                className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text)]"
              >
                {`{{secret.${s.name}}}`}
              </code>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Add API keys under{" "}
            <span className="font-medium text-[var(--text)]">
              Automations ▸ Credentials
            </span>
            , then reference them as {"{{secret.NAME}}"} — the value is
            resolved at run time and never shown in logs.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <label className="text-xs font-medium text-[var(--text-muted)]">
          Timeout (s)
          <input
            type="number"
            min={1}
            max={120}
            value={d.timeout_s ?? 30}
            onChange={(e) =>
              onPatch({
                timeout_s: Math.max(
                  1,
                  Math.min(120, Number(e.target.value) || 30)
                ),
              })
            }
            className={inputCls}
          />
        </label>
      </div>

      <label className="flex items-start gap-2 text-xs text-[var(--text-muted)]">
        <input
          type="checkbox"
          checked={d.fail_on_error_status !== false}
          onChange={(e) => onPatch({ fail_on_error_status: e.target.checked })}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span>
          <span className="font-medium text-[var(--text)]">
            Fail on error status
          </span>
          <span className="mt-0.5 block text-[10px] leading-snug">
            Treat a 4xx/5xx response as a step failure (pairs with “If this step
            errors” to branch on it). Off = the flow continues with the error
            body as output.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-xs text-[var(--text-muted)]">
        <input
          type="checkbox"
          checked={d.allow_private_network === true}
          onChange={(e) => onPatch({ allow_private_network: e.target.checked })}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span>
          <span className="font-medium text-[var(--text)]">
            Allow private network
          </span>
          <span className="mt-0.5 block text-[10px] leading-snug">
            Permit reaching a LAN / localhost address (self-hosted services on
            your own network). Cloud metadata endpoints stay blocked either way.
          </span>
        </span>
      </label>
    </>
  );
}

const nodeTypes = {
  "trigger.schedule": TriggerNode,
  "trigger.manual": TriggerNode,
  "trigger.webhook": TriggerNode,
  "ai.prompt": AINode,
  "ai.summarise": SummariseNode,
  "ai.extract": ExtractNode,
  "search.web": SearchNode,
  "fetch.page": FetchNode,
  "http.request": HttpNode,
  "mcp.action": McpNode,
  "research.deep": DeepResearchNode,
  "loop.foreach": LoopNode,
  "memory.store": MemoryNode,
  "flow.merge": MergeNode,
  "flow.delay": DelayNode,
  "control.condition": ConditionNode,
  "control.router": RouterNode,
  "output.report": OutputNode,
  "output.board_card": BoardCardNode,
  "output.chat_message": SendMessageNode,
  "output.note": NoteOutNode,
  "output.sheet": SheetOutNode,
};

// Interior "do work" node types (processing + control) are freely deletable;
// the trigger is a protected singleton and outputs are guarded down to the last.
const PROCESSING_NODE_TYPES = new Set([
  "ai.prompt",
  "ai.summarise",
  "ai.extract",
  "search.web",
  "fetch.page",
  "research.deep",
  "loop.foreach",
  "memory.store",
  "flow.merge",
  "flow.delay",
  "control.condition",
  "control.router",
]);

// --- graph ⇄ react-flow ---------------------------------------------
function toRF(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { ...n.data },
      // The trigger is a protected singleton. Everything else — processing
      // steps AND output sinks (a flow can now fan out to several) — is
      // deletable; Save validates that at least one output remains.
      deletable: !(n.type ?? "").startsWith("trigger."),
    })),
    edges: graph.edges.map((e) => ({
      id: `${e.source}:${e.source_handle ?? ""}->${e.target}`,
      source: e.source,
      target: e.target,
      // Branch nodes (Condition/Router) route via the handle an edge leaves.
      sourceHandle: e.source_handle ?? undefined,
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
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      source_handle: e.sourceHandle ?? null,
    })),
  };
}

/**
 * The Advanced flow editor for a scheduled task. Renders the task's node
 * graph (derived from its Simple config, or its stored Advanced graph),
 * lets the user wire steps together (AI / web search / fetch page →
 * ``{{upstream_output}}``), fan out to several outputs, and edit each step,
 * then persists via PUT /graph. The backend runs the graph as a DAG.
 */
export function TaskFlowEditor({
  taskId,
  activeRun,
  animateRunId,
}: {
  taskId: string;
  activeRun?: TaskRun | null;
  animateRunId?: string | null;
}) {
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

  // Chats in this workspace — the targets a "Send message" output can post to.
  const chats = useMemo<BoardOption[]>(() => {
    const out: BoardOption[] = [];
    const walk = (ns: WorkspaceItemNode[]) => {
      for (const n of ns) {
        if (n.kind === "chat") out.push({ id: n.id, title: n.title || "Chat" });
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree ?? []);
    return out;
  }, [tree]);

  // Folders — where a "Create note/sheet" output can file its new item.
  const folders = useMemo<BoardOption[]>(() => {
    const out: BoardOption[] = [];
    const walk = (ns: WorkspaceItemNode[], prefix: string) => {
      for (const n of ns) {
        if (n.kind === "folder") {
          const label = prefix + (n.title || "Folder");
          out.push({ id: n.id, title: label });
          walk(n.children ?? [], label + " / ");
        } else if (n.children?.length) {
          walk(n.children, prefix);
        }
      }
    };
    walk(tree ?? [], "");
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

  // Stored Memory-node contents — shown on the node face + in the inspector.
  const memoryQuery = useQuery({
    queryKey: ["task-memory", taskId],
    queryFn: () => tasksApi.getMemory(taskId),
  });
  const qc = useQueryClient();
  const clearMemory = useCallback(
    (nodeId: string) => {
      void tasksApi.clearMemory(taskId, nodeId).then(() =>
        qc.invalidateQueries({ queryKey: ["task-memory", taskId] })
      );
    },
    [taskId, qc]
  );

  const rfInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // "Detailed" view: each node shows its settings inline (no click-to-open).
  const [detailed, setDetailed] = useState(false);
  // Individually expanded nodes (header caret) — inline even when Detailed is off.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- Build-time test ("Run to here") + pinned data ----
  const [pins, setPins] = useState<Record<string, string>>({});
  const [nodeData, setNodeData] = useState<
    Record<string, { input: string; output: string; status: string }>
  >({});
  const [runningNode, setRunningNode] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // ---- Copilot (A2): draft a flow from a description; explain a flow ----
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotPrompt, setCopilotPrompt] = useState("");
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const [explainText, setExplainText] = useState<string | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);

  const handleDraft = useCallback(async () => {
    const desc = copilotPrompt.trim();
    if (!desc || copilotBusy) return;
    // Replacing a non-trivial graph is destructive — confirm first.
    if (nodes.length > 3) {
      const ok = window.confirm(
        "Replace the current flow with an AI-drafted one? Your current steps will be discarded (unless you've saved them)."
      );
      if (!ok) return;
    }
    setCopilotBusy(true);
    setCopilotError(null);
    try {
      const drafted = await tasksApi.draftGraph(taskId, desc);
      const rf = toRF(drafted);
      setNodes(rf.nodes);
      setEdges(rf.edges);
      setDirty(true);
      setCopilotOpen(false);
      setCopilotPrompt("");
      window.setTimeout(
        () => rfInstance.current?.fitView({ padding: 0.25, duration: 250 }),
        60
      );
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })
        .response?.data?.detail;
      setCopilotError(detail || "Couldn't draft a flow. Try rephrasing.");
    } finally {
      setCopilotBusy(false);
    }
  }, [copilotPrompt, copilotBusy, nodes.length, taskId, setNodes, setEdges]);

  const handleExplain = useCallback(async () => {
    if (!graph || explainBusy) return;
    setExplainBusy(true);
    setExplainText(null);
    try {
      const text = await tasksApi.explainGraph(
        taskId,
        fromRF(graph, nodes, edges)
      );
      setExplainText(text);
    } catch {
      setExplainText("Couldn't explain this flow right now.");
    } finally {
      setExplainBusy(false);
    }
  }, [graph, nodes, edges, taskId, explainBusy]);

  const runToHere = useCallback(
    async (nodeId: string) => {
      if (!graph) return;
      setRunningNode(nodeId);
      setTestError(null);
      try {
        const res = await tasksApi.testGraph(
          taskId,
          fromRF(graph, nodes, edges),
          nodeId,
          pins
        );
        if (!res.ok) {
          setTestError(res.error ?? "Test failed.");
          return;
        }
        setNodeData((prev) => {
          const next = { ...prev };
          for (const n of res.nodes)
            next[n.node_id] = {
              input: n.input ?? "",
              output: n.output,
              status: n.status,
            };
          return next;
        });
      } catch {
        setTestError("Couldn't run the test.");
      } finally {
        setRunningNode(null);
      }
    },
    [graph, nodes, edges, pins, taskId]
  );
  const togglePin = useCallback(
    (nodeId: string) => {
      setPins((prev) => {
        const next = { ...prev };
        if (nodeId in next) delete next[nodeId];
        else next[nodeId] = nodeData[nodeId]?.output ?? "";
        return next;
      });
    },
    [nodeData]
  );

  // ---- Run replay: paint each node's status onto the canvas as the run's
  // steps come back, so you watch the flow light up like n8n. ----
  const runDone =
    activeRun?.status === "success" || activeRun?.status === "failed";
  const runActive =
    activeRun?.status === "pending" || activeRun?.status === "running";
  const statusByNode = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of activeRun?.node_runs ?? []) m[r.node_id] = r.status;
    return m;
  }, [activeRun]);
  const triggerId = useMemo(
    () => nodes.find((n) => (n.type ?? "").startsWith("trigger."))?.id,
    [nodes]
  );
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const animatedRef = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
    if (!activeRun || !runDone) {
      setRevealed(new Set());
      return;
    }
    const steps = activeRun.node_runs ?? [];
    const seedTrigger = () =>
      new Set<string>(triggerId ? [triggerId] : []);
    const animate = activeRun.id === animateRunId && animatedRef.current !== activeRun.id;
    if (!animate) {
      // A run picked from the rail (or a failed run with no steps) → paint at once.
      setRevealed(new Set([...seedTrigger(), ...steps.map((s) => s.node_id)]));
      return;
    }
    animatedRef.current = activeRun.id;
    setRevealed(seedTrigger());
    steps.forEach((s, i) => {
      const t = window.setTimeout(() => {
        setRevealed((prev) => new Set(prev).add(s.node_id));
      }, 320 * (i + 1));
      timers.current.push(t);
    });
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
    // Keyed on the run id + terminal status so a fresh run animates exactly
    // once; polling stops on completion, so no tick interrupts the reveal.
  }, [activeRun?.id, activeRun?.status, animateRunId, triggerId]);

  // Overlay the run status onto nodes (a CSS ring) + light the edges between
  // revealed steps. Kept separate from the editable `nodes`/`edges` state.
  const displayNodes = useMemo(() => {
    if (revealed.size === 0) return nodes;
    return nodes.map((n) => {
      if (!revealed.has(n.id)) return n;
      const st = n.id === triggerId ? "success" : statusByNode[n.id];
      const cls =
        st === "skipped"
          ? "flow-node-skipped"
          : st === "failed" || st === "error"
            ? "flow-node-failed"
            : "flow-node-success";
      return { ...n, className: cn(n.className, cls) };
    });
  }, [nodes, revealed, statusByNode, triggerId]);
  const displayEdges = useMemo(() => {
    if (revealed.size === 0) return edges;
    return edges.map((e) => ({
      ...e,
      animated:
        revealed.has(e.source) &&
        revealed.has(e.target) &&
        statusByNode[e.target] !== "skipped",
    }));
  }, [edges, revealed, statusByNode]);

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

  // Patch any node's data by id — used by both the modal (selected node) and
  // inline Detailed-mode editors.
  const updateNodeData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
      );
      setDirty(true);
    },
    [setNodes]
  );
  const patchSelected = useCallback(
    (patch: Record<string, unknown>) => {
      if (selectedId) updateNodeData(selectedId, patch);
    },
    [selectedId, updateNodeData]
  );

  // Switch an output node between report / board card / chat message, resetting
  // its data to that kind's defaults.
  const setOutputTypeFor = useCallback(
    (id: string, type: string) => {
      const defaults: Record<string, Record<string, unknown>> = {
        "output.board_card": {
          board_item_id: null,
          column: "todo",
          priority: "medium",
        },
        "output.chat_message": { chat_item_id: null },
        "output.note": { title: "", folder_item_id: null },
        "output.sheet": { title: "", folder_item_id: null },
        "output.report": { notify: true },
      };
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, type, data: defaults[type] ?? { notify: true } } : n
        )
      );
      setDirty(true);
    },
    [setNodes]
  );
  const setOutputType = useCallback(
    (type: string) => {
      if (selectedId) setOutputTypeFor(selectedId, type);
    },
    [selectedId, setOutputTypeFor]
  );

  // Trigger kind switch (5.2): the flow always has exactly one trigger —
  // this swaps what fires it (clock vs. inbound webhook) in place,
  // keeping the node id + edges.
  const setTriggerType = useCallback(
    (type: string) => {
      if (!selectedId) return;
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== selectedId) return n;
          if (type === "trigger.webhook") {
            return { ...n, type, data: {} };
          }
          return {
            ...n,
            type,
            data: {
              frequency: "daily",
              hour: 9,
              minute: 0,
              weekday: null,
              day_of_month: null,
              timezone:
                Intl.DateTimeFormat().resolvedOptions().timeZone ||
                "Australia/Brisbane",
            },
          };
        })
      );
      setDirty(true);
    },
    [selectedId, setNodes]
  );

  const aiNodes = nodes.filter((n) => n.type === "ai.prompt");

  // Free-form wiring: drag from one node's handle to another to connect them.
  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) =>
        addEdge(
          { ...c, id: `${c.source}:${c.sourceHandle ?? ""}->${c.target}` },
          eds
        )
      );
      setDirty(true);
    },
    [setEdges]
  );

  // Add a *disconnected* processing node — the user wires it in themselves.
  // New AI steps inherit an existing step's model so they're runnable once
  // connected. Search/fetch nodes default to consuming the upstream text.
  const nodeCount = nodes.length;
  const addNode = useCallback(
    (
      type:
        | "ai.prompt"
        | "ai.summarise"
        | "ai.extract"
        | "search.web"
        | "fetch.page"
        | "http.request"
        | "mcp.action"
        | "research.deep"
        | "loop.foreach"
        | "memory.store"
        | "flow.merge"
        | "flow.delay"
        | "control.condition"
        | "control.router"
        | "output.report",
      pos?: { x: number; y: number }
    ) => {
      const model =
        (aiNodes[aiNodes.length - 1]?.data as unknown as
          | AIPromptData
          | undefined) ?? null;
      const prefix = type.split(".")[0];
      const id = `${prefix}_${Date.now().toString(36)}`;
      const position =
        pos ?? { x: 140 + nodeCount * 40, y: 280 + nodeCount * 22 };
      const modelBits = {
        provider_id: model?.provider_id ?? null,
        model_id: model?.model_id ?? null,
        reasoning_effort: model?.reasoning_effort ?? null,
      };
      let data: Record<string, unknown>;
      if (type === "ai.summarise") data = { length: "medium", ...modelBits };
      else if (type === "ai.extract") data = { spec: "", ...modelBits };
      else if (type === "search.web") data = { query: "", count: 5 };
      else if (type === "fetch.page") data = { url: "", max_chars: 8000 };
      else if (type === "http.request")
        data = {
          method: "GET",
          url: "",
          headers: [],
          body: "",
          timeout_s: 30,
          fail_on_error_status: true,
          allow_private_network: false,
        };
      else if (type === "mcp.action")
        data = { connector_id: null, tool_name: "", arguments: "{}" };
      else if (type === "research.deep")
        data = {
          query: "",
          max_pages: 5,
          provider_id: model?.provider_id ?? null,
          model_id: model?.model_id ?? null,
          reasoning_effort: model?.reasoning_effort ?? null,
        };
      else if (type === "loop.foreach")
        data = {
          split_mode: "lines",
          prompt: "Process this item:\n\n{{item}}",
          provider_id: model?.provider_id ?? null,
          model_id: model?.model_id ?? null,
          reasoning_effort: model?.reasoning_effort ?? null,
          use_web_search: false,
          connector_ids: [],
          max_items: 10,
          join_with: "blank",
        };
      else if (type === "memory.store")
        data = { name: "Memory", remember: true, max_runs: 5 };
      else if (type === "flow.merge") data = { mode: "all", separator: "blank" };
      else if (type === "flow.delay") data = { seconds: 30 };
      else if (type === "output.report") data = { notify: true };
      else if (type === "control.condition")
        data = { source: "", operator: "contains", value: "", case_sensitive: false };
      else if (type === "control.router")
        data = {
          categories: [
            { id: genCategoryId(), name: "Category A", description: "" },
            { id: genCategoryId(), name: "Category B", description: "" },
          ],
          provider_id: model?.provider_id ?? null,
          model_id: model?.model_id ?? null,
          reasoning_effort: model?.reasoning_effort ?? null,
        };
      else
        data = {
          prompt: "Use the previous step's output:\n\n{{upstream_output}}",
          provider_id: model?.provider_id ?? null,
          model_id: model?.model_id ?? null,
          reasoning_effort: model?.reasoning_effort ?? null,
          use_web_search: false,
          connector_ids: [],
        };
      const newNode: Node = { id, type, position, deletable: true, data };
      setNodes((ns) => ns.concat(newNode));
      setSelectedId(id);
      setDirty(true);
    },
    [aiNodes, nodeCount, setNodes]
  );

  // Right-click pane menu → add a node at the clicked position.
  const addNodeAtMenu = useCallback(
    (
      type:
        | "ai.prompt"
        | "ai.summarise"
        | "ai.extract"
        | "search.web"
        | "fetch.page"
        | "http.request"
        | "mcp.action"
        | "research.deep"
        | "loop.foreach"
        | "memory.store"
        | "flow.merge"
        | "flow.delay"
        | "control.condition"
        | "control.router"
        | "output.report"
    ) => {
      if (menu && rfInstance.current) {
        addNode(
          type,
          rfInstance.current.screenToFlowPosition({ x: menu.x, y: menu.y })
        );
      } else {
        addNode(type);
      }
      setMenu(null);
    },
    [menu, addNode]
  );

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

  const outputsCount = nodes.filter((n) =>
    (n.type ?? "").startsWith("output.")
  ).length;
  // Per-node data shown in the inspector: the selected run's data (base),
  // overlaid by any newer "Run to here" test results.
  const mergedNodeData: Record<
    string,
    { input: string; output: string; status: string }
  > = {};
  for (const r of activeRun?.node_runs ?? [])
    mergedNodeData[r.node_id] = {
      input: r.input ?? "",
      output: r.output ?? "",
      status: r.status,
    };
  Object.assign(mergedNodeData, nodeData);
  const editCtx: FlowEditCtx = {
    detailed,
    expandedIds,
    toggleExpanded,
    boards,
    chats,
    folders,
    connectors: connectors ?? [],
    inWorkspace: !!task?.workspace_id,
    outputsCount,
    memory: memoryQuery.data ?? {},
    clearMemory,
    nodeData: mergedNodeData,
    pins,
    runningNode,
    runToHere,
    togglePin,
    updateNodeData,
    setOutputTypeFor,
    removeNode,
  };

  return (
    <FlowEditContext.Provider value={editCtx}>
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
          <span className="hidden text-[11px] text-[var(--text-muted)] lg:inline">
            Right-click the canvas to add nodes
          </span>
          <button
            type="button"
            onClick={() => {
              setCopilotError(null);
              setCopilotOpen(true);
            }}
            title="Describe an automation and let AI draft the flow"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 text-xs font-medium text-[var(--accent)] transition hover:bg-[var(--accent)]/15"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Draft with AI
          </button>
          <button
            type="button"
            onClick={() => void handleExplain()}
            disabled={explainBusy || nodes.length < 2}
            title="Explain what this flow does in plain language"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {explainBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HelpCircle className="h-3.5 w-3.5" />
            )}
            Explain
          </button>
          <button
            type="button"
            onClick={() => setDetailed((v) => !v)}
            title="Show each node's settings on its face"
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition",
              detailed
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-hover)]"
            )}
          >
            {detailed ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
            Detailed
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

          {runActive && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--accent)]">
              <Loader2 className="h-3 w-3 animate-spin" /> Running…
            </span>
          )}
          {runDone && activeRun?.status === "success" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--success)]/40 bg-[var(--success)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--success)]">
              ✓ Ran successfully
            </span>
          )}
          {runDone && activeRun?.status === "failed" && (
            <span
              className="inline-flex max-w-xs items-center gap-1 truncate rounded-full border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--danger)]"
              title={activeRun.error ?? "Run failed"}
            >
              ✗ {activeRun.error ?? "Run failed"}
            </span>
          )}
          {testError && (
            <span
              className="inline-flex max-w-xs items-center gap-1 truncate rounded-full border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--danger)]"
              title={testError}
            >
              ✗ {testError}
            </span>
          )}
        </div>

        {save.isError && (
          <div className="absolute left-3 top-12 z-10 max-w-md rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-1.5 text-[11px] text-[var(--danger)]">
            {saveErrorMessage(save.error)}
          </div>
        )}

        {/* Copilot draft modal (A2) */}
        <Modal
          open={copilotOpen}
          onClose={() => setCopilotOpen(false)}
          title="Draft with AI"
          description="Describe the automation in plain language — AI builds the flow, then you review and tweak it."
          widthClass="max-w-lg"
        >
          <div className="space-y-2">
            <textarea
              autoFocus
              value={copilotPrompt}
              onChange={(e) => setCopilotPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                  void handleDraft();
              }}
              rows={4}
              placeholder="e.g. Every morning at 8, fetch open GitHub issues from my repo, summarise them, and post the summary to my team chat."
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex flex-wrap gap-1.5">
              {[
                "Daily at 9am, search the web for AI news and email me a summary.",
                "When my webhook fires, extract the order id and create a board card for it.",
                "Every hour, check my site's health endpoint; if it's down, alert my chat.",
              ].map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setCopilotPrompt(ex)}
                  className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
                >
                  {ex.length > 46 ? ex.slice(0, 46) + "…" : ex}
                </button>
              ))}
            </div>
            {copilotError && (
              <p className="text-xs text-[var(--danger)]">{copilotError}</p>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--text-muted)]">
                ⌘/Ctrl + Enter to draft
              </span>
              <button
                type="button"
                disabled={copilotBusy || !copilotPrompt.trim()}
                onClick={() => void handleDraft()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copilotBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {copilotBusy ? "Drafting…" : "Draft flow"}
              </button>
            </div>
          </div>
        </Modal>

        {/* Explain result card */}
        {explainText && (
          <div className="absolute right-3 top-12 z-10 max-w-sm rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
                <HelpCircle className="h-3.5 w-3.5 text-[var(--accent)]" />
                What this flow does
              </span>
              <button
                type="button"
                onClick={() => setExplainText(null)}
                aria-label="Dismiss"
                className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              {explainText}
            </p>
          </div>
        )}

        <ReactFlow
          colorMode={colorMode}
          nodes={displayNodes}
          edges={displayEdges}
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
                onClick={() => addNodeAtMenu("ai.prompt")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Brain className="h-3.5 w-3.5 text-[var(--accent)]" /> Add AI step
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("ai.summarise")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <TextQuote className="h-3.5 w-3.5 text-[var(--accent)]" /> Add
                summarise
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("ai.extract")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <ScanText className="h-3.5 w-3.5 text-[var(--accent)]" /> Add
                extract data
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("search.web")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Search className="h-3.5 w-3.5 text-[#3b82f6]" /> Add web search
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("fetch.page")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Download className="h-3.5 w-3.5 text-[#3b82f6]" /> Add fetch page
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("http.request")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Globe className="h-3.5 w-3.5 text-[#3b82f6]" /> Add HTTP request
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("mcp.action")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Plug className="h-3.5 w-3.5 text-[#0ea5e9]" /> Add tool action
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("research.deep")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Telescope className="h-3.5 w-3.5 text-[#0ea5e9]" /> Add deep
                research
              </button>
              <div className="my-1 h-px bg-[var(--border)]" />
              <button
                type="button"
                onClick={() => addNodeAtMenu("control.condition")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <GitBranch className="h-3.5 w-3.5 text-[#a855f7]" /> Add condition
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("control.router")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Split className="h-3.5 w-3.5 text-[#a855f7]" /> Add router
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("loop.foreach")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Repeat2 className="h-3.5 w-3.5 text-[#f97316]" /> Add loop
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("memory.store")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <StickyNote className="h-3.5 w-3.5 text-[#eab308]" /> Add memory
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("flow.merge")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <GitMerge className="h-3.5 w-3.5 text-[#f97316]" /> Add merge
              </button>
              <button
                type="button"
                onClick={() => addNodeAtMenu("flow.delay")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Timer className="h-3.5 w-3.5 text-[#f97316]" /> Add delay
              </button>
              <div className="my-1 h-px bg-[var(--border)]" />
              <button
                type="button"
                onClick={() => addNodeAtMenu("output.report")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <FileText className="h-3.5 w-3.5 text-[var(--warning)]" /> Add output
              </button>
            </div>
          </>
        )}
      </div>

      {/* Node editor — a modal with its own Save so it's right where you edit.
          Suppressed when the node's settings already live on its face (global
          Detailed mode, or this node individually expanded). */}
      <Modal
        open={!!selected && !detailed && !(selected && expandedIds.has(selected.id))}
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
            chats={chats}
            folders={folders}
            memory={memoryQuery.data?.[selected.id]?.entries ?? []}
            onClearMemory={() => clearMemory(selected.id)}
            nodeData={mergedNodeData[selected.id]}
            pinned={selected.id in pins}
            running={runningNode === selected.id}
            onRunToHere={() => runToHere(selected.id)}
            onTogglePin={() => togglePin(selected.id)}
            inWorkspace={!!task?.workspace_id}
            connectors={connectors ?? []}
            canDelete={
              PROCESSING_NODE_TYPES.has(selected.type ?? "") ||
              // An output is removable only while another output remains.
              (((selected.type ?? "").startsWith("output.")) &&
                nodes.filter((n) => (n.type ?? "").startsWith("output.")).length >
                  1)
            }
            onPatch={patchSelected}
            onSetOutputType={setOutputType}
            onSetTriggerType={setTriggerType}
            webhookUrl={
              task?.webhook_secret
                ? `${window.location.origin}/api/hooks/${task.id}/${task.webhook_secret}`
                : null
            }
            onDelete={() => {
              removeNode(selected.id);
              setSelectedId(null);
            }}
          />
        )}
      </Modal>
    </div>
    </FlowEditContext.Provider>
  );
}

function NodeInspector({
  node,
  boards,
  chats,
  folders,
  memory,
  onClearMemory,
  nodeData,
  pinned,
  running,
  onRunToHere,
  onTogglePin,
  inWorkspace,
  connectors,
  canDelete,
  onPatch,
  onSetOutputType,
  onSetTriggerType,
  webhookUrl,
  onDelete,
  inline,
}: {
  node: Node;
  boards: BoardOption[];
  chats: BoardOption[];
  folders: BoardOption[];
  memory: import("@/api/tasks").TaskMemoryEntry[];
  onClearMemory: () => void;
  nodeData?: { input: string; output: string; status: string };
  pinned?: boolean;
  running?: boolean;
  onRunToHere?: () => void;
  onTogglePin?: () => void;
  inWorkspace: boolean;
  connectors: AvailableTaskConnector[];
  canDelete: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onSetOutputType: (type: string) => void;
  /** Swap the trigger kind in place (schedule ⇄ webhook). */
  onSetTriggerType?: (type: string) => void;
  /** Full inbound-hook URL once the secret is minted (after first save). */
  webhookUrl?: string | null;
  onDelete: () => void;
  inline?: boolean;
}) {
  const isOutput = (node.type ?? "").startsWith("output.");
  const { data: models } = useAvailableModels();
  const ai = node.data as unknown as AIPromptData;
  const modelKey =
    ai.provider_id && ai.model_id ? `${ai.provider_id}::${ai.model_id}` : "";
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        // Inline on a node: grow with content. In the modal: bounded + scroll.
        inline ? "text-left" : "max-h-[60vh] overflow-y-auto"
      )}
    >
      {/* Build-time test loop: run up to here + see the data in/out, pin it. */}
      {!(node.type ?? "").startsWith("trigger.") && onRunToHere && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 p-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRunToHere}
              disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run to here
            </button>
            {onTogglePin && (
              <button
                type="button"
                onClick={onTogglePin}
                disabled={!pinned && !nodeData}
                title="Pin this output so downstream tests reuse it (no re-run)"
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition disabled:opacity-40",
                  pinned
                    ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                )}
              >
                <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
                {pinned ? "Pinned" : "Pin"}
              </button>
            )}
          </div>
          {nodeData && (
            <div className="mt-2 space-y-1.5">
              {nodeData.input ? (
                <details className="rounded bg-[var(--surface)] px-2 py-1">
                  <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    Input
                  </summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-[var(--text)]">
                    {nodeData.input}
                  </pre>
                </details>
              ) : null}
              <div className="rounded bg-[var(--surface)] px-2 py-1">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Output {pinned && "(pinned)"}
                </div>
                <OutputView
                  text={nodeData.output || ""}
                  nodeId={node.id}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {node.type === "ai.prompt" && (
        <>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Prompt
            <div className="mt-1">
              <VariableField
                value={(node.data as unknown as AIPromptData).prompt}
                onChange={(v) => onPatch({ prompt: v })}
                variables={DEFAULT_VARS}
                multiline
                rows={8}
                placeholder="What should this step do?"
              />
            </div>
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Type{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">{"{{"}</code> to
            insert a variable (like the previous step's output).
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
        </>
      )}

      {(node.type === "ai.summarise" || node.type === "ai.extract") &&
        (() => {
          const isSummarise = node.type === "ai.summarise";
          const md = node.data as unknown as SummariseData & ExtractData;
          const mKey =
            md.provider_id && md.model_id
              ? `${md.provider_id}::${md.model_id}`
              : "";
          return (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                {isSummarise
                  ? "Condenses the previous step's output into a summary — no prompt-writing needed."
                  : "Pulls structured JSON out of the previous step's output. Describe the fields you want below."}
              </p>
              {isSummarise ? (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Length
                  <select
                    value={(node.data as unknown as SummariseData).length}
                    onChange={(e) => onPatch({ length: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="short">Short (1–2 sentences)</option>
                    <option value="medium">Medium (a paragraph)</option>
                    <option value="detailed">Detailed (a few paragraphs)</option>
                  </select>
                </label>
              ) : (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Fields to extract
                  <textarea
                    value={(node.data as unknown as ExtractData).spec}
                    onChange={(e) => onPatch({ spec: e.target.value })}
                    rows={5}
                    className="mt-1 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    placeholder={"e.g. name, email, amount (USD), due_date (YYYY-MM-DD)"}
                  />
                </label>
              )}
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Model
                <select
                  value={mKey}
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
            </>
          );
        })()}

      {node.type === "search.web" && (
        <>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Search query
            <div className="mt-1">
              <VariableField
                value={(node.data as unknown as WebSearchData).query}
                onChange={(v) => onPatch({ query: v })}
                variables={DEFAULT_VARS}
                multiline
                rows={3}
                placeholder="Leave blank to search the previous step's output"
              />
            </div>
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Runs against your configured search provider (SearXNG). Insert{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">
              {"{{upstream_output}}"}
            </code>{" "}
            to build the query from an earlier step. Feed the results into an AI
            step or a Fetch page step.
          </p>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Number of results
            <input
              type="number"
              min={1}
              max={20}
              value={(node.data as unknown as WebSearchData).count}
              onChange={(e) =>
                onPatch({
                  count: Math.max(1, Math.min(20, Number(e.target.value) || 5)),
                })
              }
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </label>
        </>
      )}

      {node.type === "fetch.page" && (
        <>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            URL
            <div className="mt-1">
              <VariableField
                value={(node.data as unknown as FetchPageData).url}
                onChange={(v) => onPatch({ url: v })}
                variables={DEFAULT_VARS}
                placeholder="Leave blank to fetch the first URL from upstream"
              />
            </div>
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Fetches the page (SSRF-guarded) and extracts its readable article
            text. Blank + a Web search step above = "fetch the top result".
            Supports{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">
              {"{{upstream_output}}"}
            </code>
            .
          </p>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Max characters
            <input
              type="number"
              min={500}
              max={50000}
              step={500}
              value={(node.data as unknown as FetchPageData).max_chars}
              onChange={(e) =>
                onPatch({
                  max_chars: Math.max(
                    500,
                    Math.min(50000, Number(e.target.value) || 8000)
                  ),
                })
              }
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </label>
        </>
      )}

      {node.type === "http.request" && (
        <HttpRequestConfig node={node} onPatch={onPatch} />
      )}

      {node.type === "mcp.action" && (
        <McpActionConfig
          node={node}
          onPatch={onPatch}
          connectors={connectors}
        />
      )}

      {node.type === "research.deep" && (
        <>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Research question
            <div className="mt-1">
              <VariableField
                value={(node.data as unknown as DeepResearchData).query}
                onChange={(v) => onPatch({ query: v })}
                variables={DEFAULT_VARS}
                multiline
                rows={3}
                placeholder="Leave blank to research the previous step's output"
              />
            </div>
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Searches the web (SearXNG), reads the top pages, and writes one cited
            report answering the question. Supports{" "}
            <code className="rounded bg-[var(--surface-2)] px-1">
              {"{{upstream_output}}"}
            </code>
            .
          </p>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Pages to read
            <input
              type="number"
              min={1}
              max={10}
              value={(node.data as unknown as DeepResearchData).max_pages}
              onChange={(e) =>
                onPatch({
                  max_pages: Math.max(
                    1,
                    Math.min(10, Number(e.target.value) || 5)
                  ),
                })
              }
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Synthesiser model
            <select
              value={
                (() => {
                  const d = node.data as unknown as DeepResearchData;
                  return d.provider_id && d.model_id
                    ? `${d.provider_id}::${d.model_id}`
                    : "";
                })()
              }
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
        </>
      )}

      {node.type === "memory.store" &&
        (() => {
          const m = node.data as unknown as MemoryData;
          return (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                Remembers the previous step's output <em>across runs</em>, so a
                later run can compare to last time ("what changed") or feed the
                history back in. Wire it into a later step to inject it as
                context. To pass data <em>within</em> one run, just wire nodes
                together — you don't need Memory for that.
              </p>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Name
                <input
                  value={m.name}
                  onChange={(e) => onPatch({ name: e.target.value })}
                  placeholder="e.g. Device list"
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label className="flex items-center justify-between text-xs text-[var(--text)]">
                <span>
                  Remember across runs
                  <span className="block text-[10px] font-normal text-[var(--text-muted)]">
                    Persist so a run can compare to previous runs
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={m.remember}
                  onChange={(e) => onPatch({ remember: e.target.checked })}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
              </label>
              {m.remember && (
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Remember the last N runs
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={m.max_runs}
                    onChange={(e) =>
                      onPatch({
                        max_runs: Math.max(
                          1,
                          Math.min(50, Number(e.target.value) || 5)
                        ),
                      })
                    }
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  />
                </label>
              )}
              {memory.length > 0 && (
                <div className="rounded-md border border-[var(--border)] p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      Stored ({memory.length})
                    </span>
                    <button
                      type="button"
                      onClick={onClearMemory}
                      className="inline-flex items-center gap-1 text-[10px] text-[var(--danger)] transition hover:underline"
                    >
                      <Trash2 className="h-3 w-3" /> Clear
                    </button>
                  </div>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {[...memory].reverse().map((e, i) => (
                      <div
                        key={i}
                        className="rounded bg-[var(--surface-2)] px-1.5 py-1 text-[11px]"
                      >
                        <div className="text-[9px] text-[var(--text-muted)]">
                          {e.at}
                        </div>
                        <div className="line-clamp-3 whitespace-pre-wrap text-[var(--text)]">
                          {e.value || "(empty)"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          );
        })()}

      {node.type === "loop.foreach" &&
        (() => {
          const l = node.data as unknown as LoopData;
          const modelKey =
            l.provider_id && l.model_id
              ? `${l.provider_id}::${l.model_id}`
              : "";
          return (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                Splits the upstream text into items and runs the step below once
                per item, then joins the results. Use{" "}
                <code className="rounded bg-[var(--surface-2)] px-1">
                  {"{{item}}"}
                </code>{" "}
                (and{" "}
                <code className="rounded bg-[var(--surface-2)] px-1">
                  {"{{item_index}}"}
                </code>
                ) in the prompt.
              </p>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Split the upstream by
                <select
                  value={l.split_mode}
                  onChange={(e) => onPatch({ split_mode: e.target.value })}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="lines">Lines (one item per line)</option>
                  <option value="json">JSON array</option>
                </select>
              </label>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Per-item prompt
                <div className="mt-1">
                  <VariableField
                    value={l.prompt}
                    onChange={(v) => onPatch({ prompt: v })}
                    variables={LOOP_VARS}
                    multiline
                    rows={5}
                    placeholder="What should run for each item? Use {{item}}"
                  />
                </div>
              </label>
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
              <div className="flex gap-2">
                <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
                  Max items
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={l.max_items}
                    onChange={(e) =>
                      onPatch({
                        max_items: Math.max(
                          1,
                          Math.min(50, Number(e.target.value) || 10)
                        ),
                      })
                    }
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  />
                </label>
                <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
                  Join results
                  <select
                    value={l.join_with}
                    onChange={(e) => onPatch({ join_with: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="blank">Blank line</option>
                    <option value="numbered">Numbered list</option>
                  </select>
                </label>
              </div>
              <label className="flex items-center justify-between text-xs text-[var(--text)]">
                <span className="inline-flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-[var(--text-muted)]" /> Web
                  search per item
                </span>
                <input
                  type="checkbox"
                  checked={l.use_web_search}
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
                      {l.connector_ids.length} selected
                    </span>
                  </div>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
                    {connectors.map((c) => {
                      const on = l.connector_ids.includes(c.id);
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
                                  ? l.connector_ids.filter((x) => x !== c.id)
                                  : [...l.connector_ids, c.id],
                              })
                            }
                            className="h-3.5 w-3.5 accent-[var(--accent)]"
                          />
                          <span className="truncate text-[var(--text)]">
                            {c.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          );
        })()}

      {node.type === "flow.merge" && (
        <>
          <p className="text-[11px] text-[var(--text-muted)]">
            Joins several branches back into one. Wire multiple steps into this
            node's input.
          </p>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            When to proceed
            <select
              value={(node.data as unknown as MergeData).mode}
              onChange={(e) => onPatch({ mode: e.target.value })}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option value="all">Wait for all branches</option>
              <option value="any">Proceed with any branch</option>
            </select>
          </label>
          <p className="text-[10px] text-[var(--text-muted)]">
            “Wait for all” only fires when every incoming branch ran — use it for
            parallel branches, not the two sides of a condition (only one of
            those ever runs).
          </p>
          <label className="text-xs font-medium text-[var(--text-muted)]">
            Join outputs with
            <select
              value={(node.data as unknown as MergeData).separator}
              onChange={(e) => onPatch({ separator: e.target.value })}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option value="blank">Blank line</option>
              <option value="newline">New line</option>
              <option value="space">Space</option>
            </select>
          </label>
        </>
      )}

      {node.type === "flow.delay" &&
        (() => {
          const secs = (node.data as unknown as DelayData).seconds || 0;
          const unit = secs % 60 === 0 && secs >= 60 ? "minutes" : "seconds";
          const amount = unit === "minutes" ? secs / 60 : secs;
          const setFrom = (nextAmount: number, nextUnit: string) => {
            const raw = nextUnit === "minutes" ? nextAmount * 60 : nextAmount;
            onPatch({ seconds: Math.max(0, Math.min(600, Math.round(raw))) });
          };
          return (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                Pauses the run before continuing — handy for rate-limiting or
                letting an external process settle. Capped at 10 minutes (longer
                waits would tie up a worker).
              </p>
              <div className="flex gap-2">
                <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
                  Duration
                  <input
                    type="number"
                    min={0}
                    value={amount}
                    onChange={(e) =>
                      setFrom(Number(e.target.value) || 0, unit)
                    }
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  />
                </label>
                <label className="flex-1 text-xs font-medium text-[var(--text-muted)]">
                  Unit
                  <select
                    value={unit}
                    onChange={(e) => setFrom(amount, e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="seconds">Seconds</option>
                    <option value="minutes">Minutes</option>
                  </select>
                </label>
              </div>
            </>
          );
        })()}

      {node.type === "control.condition" &&
        (() => {
          const c = node.data as unknown as ConditionData;
          const op = CONDITION_OPERATORS.find((o) => o.value === c.operator);
          return (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                Tests a value and sends the run down its{" "}
                <b className="text-[var(--success)]">true</b> or{" "}
                <b className="text-[var(--danger)]">false</b> branch. Wire each
                handle to what should happen next — only the matching branch
                runs.
              </p>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Value to test
                <div className="mt-1">
                  <VariableField
                    value={c.source}
                    onChange={(v) => onPatch({ source: v })}
                    variables={DEFAULT_VARS}
                    placeholder="Blank = the whole upstream. Or a field: {{json.status}}"
                  />
                </div>
              </label>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                …
                <select
                  value={c.operator}
                  onChange={(e) => onPatch({ operator: e.target.value })}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                >
                  {CONDITION_OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {op?.needsValue && (
                <>
                  <label className="text-xs font-medium text-[var(--text-muted)]">
                    Value
                    <div className="mt-1">
                      <VariableField
                        value={c.value}
                        onChange={(v) => onPatch({ value: v })}
                        variables={DEFAULT_VARS}
                        placeholder={
                          c.operator === "matches"
                            ? "regular expression"
                            : "text to look for"
                        }
                      />
                    </div>
                  </label>
                  <label className="flex items-center justify-between text-xs text-[var(--text)]">
                    <span>Case sensitive</span>
                    <input
                      type="checkbox"
                      checked={c.case_sensitive}
                      onChange={(e) => onPatch({ case_sensitive: e.target.checked })}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                  </label>
                </>
              )}
            </>
          );
        })()}

      {node.type === "control.router" &&
        (() => {
          const r = node.data as unknown as RouterData;
          const cats = r.categories ?? [];
          const modelKey =
            r.provider_id && r.model_id ? `${r.provider_id}::${r.model_id}` : "";
          const setCats = (next: RouterCategory[]) =>
            onPatch({ categories: next });
          return (
            <>
              <p className="text-[11px] text-[var(--text-muted)]">
                The AI reads the upstream text and picks the single best-matching
                category; that category's branch runs and the others are skipped.
                Give each a clear description — that's what the classifier reads.
              </p>
              <label className="text-xs font-medium text-[var(--text-muted)]">
                Classifier model
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
              <div className="space-y-2">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Categories (branches)
                </span>
                {cats.map((cat, i) => (
                  <div
                    key={cat.id}
                    className="space-y-1 rounded-md border border-[var(--border)] p-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={cat.name}
                        onChange={(e) =>
                          setCats(
                            cats.map((x, j) =>
                              j === i ? { ...x, name: e.target.value } : x
                            )
                          )
                        }
                        placeholder="Branch name"
                        className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        type="button"
                        disabled={cats.length <= 1}
                        onClick={() => setCats(cats.filter((_, j) => j !== i))}
                        title="Remove branch"
                        className="rounded p-1 text-[var(--danger)] transition hover:bg-[var(--danger-bg)] disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <input
                      value={cat.description}
                      onChange={(e) =>
                        setCats(
                          cats.map((x, j) =>
                            j === i ? { ...x, description: e.target.value } : x
                          )
                        )
                      }
                      placeholder="When should the AI pick this?"
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-1.5 text-[11px] text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setCats([
                      ...cats,
                      { id: genCategoryId(), name: "", description: "" },
                    ])
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add category
                </button>
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                Each category is a branch handle on the node — connect it to the
                steps for that case. Removing one drops its wire.
              </p>
            </>
          );
        })()}

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
                ? [
                    { t: "output.board_card", label: "Board card" },
                    { t: "output.chat_message", label: "Chat message" },
                    { t: "output.note", label: "Note" },
                    { t: "output.sheet", label: "Sheet" },
                  ]
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
                  The AI result becomes a card on this board. Beyond a title and
                  description, the AI can fill in a due date, labels, a
                  checklist, and links — just ask for them in this step's
                  prompt. The Column and Priority below are defaults the AI can
                  override.
                </p>
                <details className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
                  <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-muted)]">
                    How to ask the AI for these
                  </summary>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
                    <li>
                      <b>Due date</b> — “…due next Friday”, “…set the deadline to
                      the 15th”. Relative dates are resolved to the run date.
                    </li>
                    <li>
                      <b>Labels</b> — “tag it Errand and Home”. New labels are
                      created on the board automatically.
                    </li>
                    <li>
                      <b>Checklist</b> — “add a checklist: buy paint, tape
                      edges, apply first coat”.
                    </li>
                    <li>
                      <b>Links</b> — include real URLs, e.g. “link to
                      https://example.com/spec”.
                    </li>
                    <li>
                      <b>Priority</b> — “make it high priority” overrides the
                      default below.
                    </li>
                  </ul>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
                    Example prompt: “Create a card to repaint the fence, high
                    priority, due next Saturday, tagged Home. Checklist: buy
                    paint, sand the fence, apply two coats.”
                  </p>
                </details>
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
                <label className="flex items-start gap-2 text-xs font-medium text-[var(--text-muted)]">
                  <input
                    type="checkbox"
                    checked={
                      (node.data as unknown as BoardCardOutputData)
                        .update_existing ?? false
                    }
                    onChange={(e) =>
                      onPatch({ update_existing: e.target.checked })
                    }
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span>
                    Update the existing card with the same title
                    <span className="mt-0.5 block font-normal text-[10px] leading-snug">
                      If a live (not-done) card on this board already has the
                      same title, refresh its description, priority, column and
                      details instead of filing a duplicate — good for recurring
                      status cards.
                    </span>
                  </span>
                </label>
              </>
            ))}

          {node.type === "output.chat_message" &&
            (chats.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">
                This workspace has no chat yet — create a chat in it, then pick
                it here.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Posts the result as a message in a workspace chat — handy for
                  alerts and digests.
                </p>
                <label className="text-xs font-medium text-[var(--text-muted)]">
                  Chat
                  <select
                    value={
                      (node.data as unknown as ChatMessageOutputData)
                        .chat_item_id ?? ""
                    }
                    onChange={(e) =>
                      onPatch({
                        chat_item_id: e.target.value || null,
                        chat_title:
                          chats.find((c) => c.id === e.target.value)?.title ??
                          null,
                      })
                    }
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="">Select a chat…</option>
                    {chats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ))}

          {(node.type === "output.note" || node.type === "output.sheet") &&
            (() => {
              const isNote = node.type === "output.note";
              const d = node.data as unknown as NoteOutputData & SheetOutputData;
              return (
                <>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {isNote
                      ? "Creates a new note from the result (Markdown becomes rich text) each run."
                      : "Creates a new spreadsheet from the result each run — JSON, a Markdown table, or CSV/TSV rows are parsed into cells."}
                  </p>
                  <label className="text-xs font-medium text-[var(--text-muted)]">
                    Title
                    <div className="mt-1">
                      <VariableField
                        value={d.title}
                        onChange={(v) => onPatch({ title: v })}
                        variables={DEFAULT_VARS}
                        placeholder="Leave blank to use the result's first line"
                      />
                    </div>
                  </label>
                  <label className="text-xs font-medium text-[var(--text-muted)]">
                    Folder{" "}
                    <span className="font-normal text-[10px]">(optional)</span>
                    <select
                      value={d.folder_item_id ?? ""}
                      onChange={(e) =>
                        onPatch({ folder_item_id: e.target.value || null })
                      }
                      className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    >
                      <option value="">Workspace root</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Tip: point scheduled runs at a dedicated folder to keep the
                    workspace tidy.
                  </p>
                </>
              );
            })()}
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
          const isWebhook = node.type === "trigger.webhook";
          const firesOn = (
            <label className="text-xs font-medium text-[var(--text-muted)]">
              Fires on
              <select
                value={isWebhook ? "trigger.webhook" : "trigger.schedule"}
                className={selCls}
                onChange={(e) => onSetTriggerType?.(e.target.value)}
              >
                <option value="trigger.schedule">A schedule</option>
                <option value="trigger.webhook">An inbound webhook</option>
              </select>
            </label>
          );
          if (isWebhook) {
            return (
              <>
                {firesOn}
                {webhookUrl ? (
                  <div>
                    <div className="text-xs font-medium text-[var(--text-muted)]">
                      Webhook URL
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--text)]">
                        {webhookUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard.writeText(webhookUrl)
                        }
                        className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                      >
                        Copy
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-snug text-[var(--text-muted)]">
                      POST anything to this URL to start a run. The request
                      body reaches the flow as{" "}
                      <code>{"{{trigger.payload}}"}</code> (JSON fields as{" "}
                      <code>{"{{trigger.json.<field>}}"}</code>). Anyone with
                      the URL can fire it — treat it like a password.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">
                    Save the flow to mint this automation's webhook URL.
                  </p>
                )}
              </>
            );
          }
          return (
            <>
              {firesOn}
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

      {/* On-error behaviour — a run-robustness setting for any runnable node. */}
      {!(node.type ?? "").startsWith("trigger.") && (
        <label className="mt-1 flex items-center justify-between border-t border-[var(--border)] pt-2 text-xs text-[var(--text-muted)]">
          <span>If this step errors</span>
          <select
            value={
              ((node.data as Record<string, unknown>).on_error as string) ??
              "stop"
            }
            onChange={(e) => onPatch({ on_error: e.target.value })}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          >
            <option value="stop">Stop the run</option>
            <option value="continue">Continue (skip this step)</option>
          </select>
        </label>
      )}

      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs text-[var(--danger)] transition hover:bg-[var(--danger-bg)]"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove step
        </button>
      )}
    </div>
  );
}
