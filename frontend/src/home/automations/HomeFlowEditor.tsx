import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Hourglass, Lightbulb, Music, Play, Plus, Power, Split, Trash2, X, Zap } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { Home } from "@/api/home";
import { homeAutomationsApi, type FlowGraph, type FlowNode, type HomeAutomation } from "@/api/homeAutomations";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { useThemeStore } from "@/store/themeStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { AUTOMATIONS_KEY } from "./AutomationsSection";
import { tidy } from "./layout";
import { StepForm } from "./StepForm";
import { isCheck, newStep, runWords, STEP_KINDS, stepWords, type StepKind } from "./steps";

/**
 * The flow editor for one home automation. A "When…" at the top, then the
 * steps it does, joined top to bottom. A check ("only if…") has two ways
 * out: Yes and No. The same node graph and engine as every other automation
 * in Promptly, with only the steps a home needs.
 *
 * Left: its name, what to say to run it, and how its last runs went.
 * Middle: the flow. Right: the step that's picked.
 */

const HomeContext = createContext<Home | undefined>(undefined);

const ICONS: Record<string, typeof Zap> = {
  "trigger.manual": Zap,
  "trigger.schedule": Clock,
  "trigger.home_state": Zap,
  "home.device": Power,
  "home.lights": Lightbulb,
  "home.music": Music,
  "flow.delay": Hourglass,
  "control.home_state": Split,
  "control.time": Split,
};

function StepNode({ id, type, data, selected }: NodeProps) {
  const home = useContext(HomeContext);
  const words = stepWords({ id, type: type ?? "", position: { x: 0, y: 0 }, data: data as Record<string, unknown> }, home);
  const Icon = ICONS[type ?? ""] ?? Power;
  const start = (type ?? "").startsWith("trigger.");
  const check = isCheck(type);
  return (
    <div
      className={cn(
        "w-64 rounded-2xl border bg-[var(--surface)] px-3 py-2.5 shadow-sm transition",
        selected ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/30" : words.unset ? "border-dashed border-[var(--warning)]" : "border-[var(--border)]",
      )}
    >
      {!start && <Handle type="target" position={Position.Top} className="!h-3 !w-3 !border-2 !border-[var(--surface)] !bg-[var(--accent)]" />}
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", start ? "bg-[var(--accent-strong)] text-white" : "bg-[var(--accent)]/15 text-[var(--accent-text,var(--accent))]")}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{words.title}</p>
          <p className={cn("text-sm leading-snug", words.unset ? "text-[var(--warning)]" : "text-[var(--text)]")}>{words.line}</p>
        </div>
      </div>
      {check ? (
        <>
          <div className="mt-2 flex justify-between px-6 text-[11px] font-medium text-[var(--text-muted)]">
            <span>Yes</span>
            <span>No</span>
          </div>
          <Handle id="true" type="source" position={Position.Bottom} style={{ left: "22%" }} className="!h-3 !w-3 !border-2 !border-[var(--surface)] !bg-[var(--success)]" />
          <Handle id="false" type="source" position={Position.Bottom} style={{ left: "78%" }} className="!h-3 !w-3 !border-2 !border-[var(--surface)] !bg-[var(--text-muted)]" />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !border-2 !border-[var(--surface)] !bg-[var(--accent)]" />
      )}
    </div>
  );
}

const nodeTypes = Object.fromEntries(Object.keys(ICONS).map((k) => [k, StepNode]));

function toCanvas(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data ?? {} })),
    edges: graph.edges.map((e, i) => edgeOf(e.source, e.target, e.source_handle ?? null, i)),
  };
}

function edgeOf(source: string, target: string, handle: string | null, n = 0): Edge {
  return {
    id: `e_${source}_${handle ?? "out"}_${target}_${n}`,
    source,
    target,
    sourceHandle: handle,
    label: handle === "true" ? "Yes" : handle === "false" ? "No" : undefined,
    style: { strokeWidth: 2 },
  };
}

function fromCanvas(nodes: Node[], edges: Edge[]): FlowGraph {
  return {
    version: 1,
    mode: "advanced",
    nodes: nodes.map((n) => ({ id: n.id, type: n.type ?? "", position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: (n.data ?? {}) as Record<string, unknown> })),
    edges: edges.map((e) => ({ source: e.source, target: e.target, source_handle: e.sourceHandle ?? null })),
  };
}

const quiet =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent-strong)] px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const field =
  "h-9 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

export function HomeFlowEditor({ home, automation }: { home: Home; automation: HomeAutomation }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const colorMode = useThemeStore((s) => s.resolved());
  const flow = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const start = useMemo(() => toCanvas(automation.graph ?? { version: 1, mode: "advanced", nodes: [], edges: [] }), [automation.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(start.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(start.edges);
  const [name, setName] = useState(automation.name);
  const [phrases, setPhrases] = useState<string[]>(automation.phrases);
  const [phrase, setPhrase] = useState("");
  const [enabled, setEnabled] = useState(automation.enabled);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canEdit = automation.can_edit;
  const key = ["home", "automation", home.id, automation.id];

  const runs = useQuery({ queryKey: [...key, "runs"], queryFn: () => homeAutomationsApi.runs(home.id, automation.id) });

  const touch = () => {
    setDirty(true);
    setProblem(null);
  };
  const fit = () => window.setTimeout(() => flow.current?.fitView({ padding: 0.3, duration: 200, maxZoom: 1 }), 30);

  // Leaving with changes that aren't saved: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || !c.source || !c.target || c.source === c.target) return;
      setEdges((old) => {
        // One line out of each way out: a new one replaces the old.
        const kept = old.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
        return addEdge(edgeOf(c.source, c.target, c.sourceHandle ?? null, Date.now()), kept);
      });
      touch();
    },
    [canEdit, setEdges],
  );

  const addStep = (kind: StepKind) => {
    setAdding(false);
    const id = `s_${Math.random().toString(36).slice(2, 9)}`;
    // After the picked step, or the last one in the flow.
    const out = new Set(edges.map((e) => e.source));
    const anchor = nodes.find((n) => n.id === picked) ?? [...nodes].filter((n) => !out.has(n.id) || isCheck(n.type)).sort((a, b) => b.position.y - a.position.y)[0] ?? nodes[0];
    const made = newStep(kind, id, { x: anchor ? anchor.position.x : 0, y: anchor ? anchor.position.y + 130 : 0 });
    let nextEdges = edges;
    if (anchor) {
      if (isCheck(anchor.type)) {
        const used = new Set(edges.filter((e) => e.source === anchor.id).map((e) => e.sourceHandle));
        const way = !used.has("true") ? "true" : !used.has("false") ? "false" : null;
        if (way) nextEdges = [...edges, edgeOf(anchor.id, id, way)];
      } else {
        // In between: what came after the anchor now comes after the new step.
        const after = edges.filter((e) => e.source === anchor.id);
        nextEdges = [...edges.filter((e) => e.source !== anchor.id), edgeOf(anchor.id, id, null), ...(isCheck(kind) ? after.map((e) => edgeOf(id, e.target, "true")) : after.map((e) => edgeOf(id, e.target, null)))];
      }
    }
    const nextNodes = tidy([...nodes, { id, type: made.type, position: made.position, data: made.data }], nextEdges);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setPicked(id);
    touch();
    fit();
  };

  const removeStep = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node || (node.type ?? "").startsWith("trigger.")) return;
    const into = edges.filter((e) => e.target === id);
    const outOf = edges.filter((e) => e.source === id);
    let next = edges.filter((e) => e.source !== id && e.target !== id);
    // Close the gap when it sat in a simple line.
    if (into.length === 1 && outOf.length === 1) next = [...next, edgeOf(into[0].source, outOf[0].target, into[0].sourceHandle ?? null, Date.now())];
    setEdges(next);
    setNodes(tidy(nodes.filter((n) => n.id !== id), next));
    setPicked(null);
    touch();
    fit();
  };

  const changeStep = (id: string, patch: { type?: string; data: Record<string, unknown> }) => {
    setNodes((old) => old.map((n) => (n.id === id ? { ...n, type: patch.type ?? n.type, data: patch.data } : n)));
    touch();
  };

  const save = useMutation({
    mutationFn: () => homeAutomationsApi.save(home.id, automation.id, { name: name.trim() || automation.name, phrases, graph: fromCanvas(nodes, edges), enabled: automation.steps > 0 ? enabled : undefined }),
    onSuccess: (saved) => {
      setDirty(false);
      setProblem(null);
      setEnabled(saved.enabled);
      setPhrases(saved.phrases);
      qc.setQueryData(key, saved);
      void qc.invalidateQueries({ queryKey: AUTOMATIONS_KEY(home.id) });
      toast.success("Saved");
    },
    onError: (e) => setProblem(apiErrorMessage(e, "Couldn't save it. Try again.")),
  });
  const run = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return homeAutomationsApi.run(home.id, automation.id);
    },
    onSuccess: (r) => {
      if (r.ok) toast.success(r.words);
      else toast.error(r.words);
      void runs.refetch();
      void qc.invalidateQueries({ queryKey: AUTOMATIONS_KEY(home.id) });
    },
    onError: (e) => {
      if (!problem) toast.error(apiErrorMessage(e, "That didn't run. Try again."));
    },
  });
  const remove = useMutation({
    mutationFn: () => homeAutomationsApi.remove(home.id, automation.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUTOMATIONS_KEY(home.id) });
      navigate("/home");
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't delete it.")),
  });

  const addPhrase = () => {
    const text = phrase.trim().replace(/\s+/g, " ");
    if (!text) return;
    if (!phrases.some((p) => p.toLowerCase() === text.toLowerCase())) setPhrases([...phrases, text]);
    setPhrase("");
    touch();
  };

  const pickedNode = nodes.find((n) => n.id === picked) ?? null;
  const pickedModel: FlowNode | null = pickedNode ? { id: pickedNode.id, type: pickedNode.type ?? "", position: pickedNode.position, data: pickedNode.data as Record<string, unknown> } : null;
  const hasSteps = nodes.some((n) => (n.type ?? "").startsWith("home."));

  return (
    <HomeContext.Provider value={home}>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Its name, its phrases, its runs */}
        <aside aria-label="About this automation" className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-b border-[var(--border)] p-4 md:w-72 md:border-b-0 md:border-r">
          <div>
            <label htmlFor="auto-name" className="mb-1 block text-xs font-semibold text-[var(--text-muted)]">Name</label>
            <input id="auto-name" className={field} value={name} maxLength={80} disabled={!canEdit} onChange={(e) => { setName(e.target.value); touch(); }} />
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold text-[var(--text-muted)]">Say this to run it</p>
            <p className="mb-2 text-xs text-[var(--text-muted)]">
              To the assistant, out loud or typed. “Hey Promptly” in front is fine. Anyone in this home can say it.
            </p>
            {phrases.length > 0 && (
              <ul className="mb-2 flex flex-col gap-1.5" aria-label="Phrases">
                {phrases.map((p) => (
                  <li key={p} className="flex items-center gap-2 rounded-xl bg-[var(--hover)] py-1 pl-3 pr-1 text-sm text-[var(--text)]">
                    <span className="min-w-0 flex-1 truncate">“{p}”</span>
                    {canEdit && (
                      <button type="button" aria-label={`Remove the phrase ${p}`} onClick={() => { setPhrases(phrases.filter((x) => x !== p)); touch(); }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--border)]">
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addPhrase(); }}>
                <label htmlFor="auto-phrase" className="sr-only">A phrase</label>
                <input id="auto-phrase" className={field} value={phrase} maxLength={80} placeholder="e.g. it's morning time" onChange={(e) => setPhrase(e.target.value)} />
                <button type="submit" className={quiet} disabled={!phrase.trim()}>Add</button>
              </form>
            )}
            {!canEdit && phrases.length === 0 && <p className="text-xs text-[var(--text-muted)]">No phrase yet.</p>}
          </div>

          {canEdit && automation.steps > 0 && (
            <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
              <span>
                Switched on
                <span className="block text-xs text-[var(--text-muted)]">Off: its phrase, time or device won't start it.</span>
              </span>
              <input type="checkbox" className="h-5 w-5 accent-[var(--accent-strong)]" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); touch(); }} />
            </label>
          )}

          <div>
            <p className="mb-1 text-xs font-semibold text-[var(--text-muted)]">Last runs</p>
            {(runs.data ?? []).length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">It hasn't run yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(runs.data ?? []).slice(0, 5).map((r) => {
                  const w = runWords(r);
                  return (
                    <li key={r.id} className="rounded-xl border border-[var(--border)] px-3 py-2">
                      <p className={cn("text-xs font-medium", w.tone === "bad" ? "text-[var(--danger)]" : w.tone === "warn" ? "text-[var(--warning)]" : "text-[var(--text)]")}>{w.words}</p>
                      {(r.steps ?? []).length > 0 ? (
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {(r.steps ?? []).map((s, i) => (
                            <li key={i} className={cn("text-xs", s.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                              {s.status === "error" ? "Didn't work: " : ""}
                              {s.text}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        r.error && <p className="mt-1 text-xs text-[var(--danger)]">{r.error}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {canEdit && (
            <button
              type="button"
              className="mt-auto inline-flex h-9 items-center gap-1.5 self-start rounded-xl px-2 text-xs font-medium text-[var(--danger)] hover:bg-[var(--hover)]"
              onClick={async () => {
                if (await confirm({ title: `Delete “${automation.name}”?`, message: "Its steps, phrases and run history go with it. This can't be undone.", confirmLabel: "Delete", danger: true })) remove.mutate();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete this automation
            </button>
          )}
        </aside>

        {/* The flow */}
        <div className="relative min-h-[420px] min-w-0 flex-1">
          <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap items-start gap-2">
            {canEdit && (
              <div className="relative">
                <button type="button" className={strong} aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
                  <Plus className="h-3.5 w-3.5" aria-hidden /> Add a step
                </button>
                {adding && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAdding(false)} aria-hidden />
                    <ul role="menu" aria-label="Kinds of step" className="absolute left-0 top-11 z-20 w-72 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl">
                      {STEP_KINDS.map((k) => {
                        const Icon = ICONS[k.kind];
                        return (
                          <li key={k.kind} role="none">
                            <button type="button" role="menuitem" onClick={() => addStep(k.kind)} className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--hover)]">
                              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,var(--accent))]" aria-hidden />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium text-[var(--text)]">{k.name}</span>
                                <span className="block text-xs text-[var(--text-muted)]">{k.about}</span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
            {canEdit && (
              <button type="button" className={quiet} onClick={() => { setNodes((old) => tidy(old, edges)); touch(); fit(); }}>
                Tidy up
              </button>
            )}
            <span className="flex-1" />
            <button type="button" className={quiet} disabled={!hasSteps || run.isPending || save.isPending} onClick={() => run.mutate()} title={dirty ? "Saves it first, then runs it" : "Run it now"}>
              <Play className="h-3.5 w-3.5" aria-hidden /> {run.isPending ? "Running…" : "Run it now"}
            </button>
            {canEdit && (
              <button type="button" className={strong} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
              </button>
            )}
          </div>
          {problem && (
            <p role="alert" className="absolute left-3 right-3 top-14 z-10 rounded-xl border border-[var(--danger)]/50 bg-[var(--surface)] px-3 py-2 text-sm text-[var(--danger)] shadow">
              {problem}
            </p>
          )}
          {!hasSteps && canEdit && (
            <p className="pointer-events-none absolute inset-x-0 bottom-6 z-10 mx-auto max-w-sm rounded-xl bg-[var(--surface)]/90 px-4 py-2 text-center text-sm text-[var(--text-muted)]">
              Tap “Add a step” to say what happens. Tap the “When” box to change how it starts.
            </p>
          )}
          <ReactFlow
            colorMode={colorMode}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(inst) => {
              flow.current = inst;
              fit();
            }}
            onNodesChange={(changes) => {
              const real = changes.filter((c) => c.type !== "remove" || !(nodes.find((n) => n.id === c.id)?.type ?? "").startsWith("trigger."));
              if (real.some((c) => c.type === "remove" || (c.type === "position" && c.dragging === false))) touch();
              onNodesChange(canEdit ? real : real.filter((c) => c.type === "select" || c.type === "dimensions"));
            }}
            onEdgesChange={(changes) => {
              if (!canEdit) return onEdgesChange(changes.filter((c) => c.type === "select"));
              if (changes.some((c) => c.type === "remove")) touch();
              onEdgesChange(changes);
            }}
            onConnect={onConnect}
            onSelectionChange={({ nodes: sel }) => setPicked(sel.length === 1 ? sel[0].id : null)}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* The picked step */}
        {pickedModel && (
          <aside aria-label="This step" className="w-full shrink-0 overflow-y-auto border-t border-[var(--border)] p-4 md:w-80 md:border-l md:border-t-0">
            <StepForm
              key={pickedModel.id}
              home={home}
              node={pickedModel}
              canEdit={canEdit}
              onChange={(patch) => changeStep(pickedModel.id, patch)}
              onRemove={() => removeStep(pickedModel.id)}
            />
          </aside>
        )}
      </div>
    </HomeContext.Provider>
  );
}
