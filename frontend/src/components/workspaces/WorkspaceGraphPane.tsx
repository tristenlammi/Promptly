import { useMemo } from "react";
import { Loader2, Share2 } from "lucide-react";

import {
  useWorkspaceGraph,
} from "@/hooks/useWorkspaces";
import type {
  WorkspaceGraph,
  WorkspaceItemNode,
} from "@/api/workspaces";

/**
 * Workspace graph view (Phase 5).
 *
 * Items are nodes; edges are explicit ``[[`` wiki-links (solid) and
 * semantic neighbours (dashed). Laid out with a small dependency-free
 * force simulation computed once per data change. Click a node to open
 * the item. The semantic edges are the differentiator — connections the
 * user never typed, surfaced from the embedding index.
 */
const VIEW_W = 900;
const VIEW_H = 620;

const KIND_COLOR: Record<string, string> = {
  note: "#4F46E5",
  canvas: "#D97757",
  chat: "#0EA5E9",
};

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function computeLayout(graph: WorkspaceGraph): Map<string, Pt> {
  const nodes = graph.nodes;
  const n = nodes.length;
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const radius = Math.min(VIEW_W, VIEW_H) * 0.34;

  // Seed deterministically on a circle so layouts are stable per dataset.
  const pts: Pt[] = nodes.map((_, i) => ({
    x: cx + Math.cos((2 * Math.PI * i) / Math.max(n, 1)) * radius,
    y: cy + Math.sin((2 * Math.PI * i) / Math.max(n, 1)) * radius,
    vx: 0,
    vy: 0,
  }));
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const links = graph.edges
    .map((e) => ({ s: index.get(e.source), t: index.get(e.target) }))
    .filter((l): l is { s: number; t: number } => l.s != null && l.t != null);

  const REPULSE = 22000;
  const SPRING = 0.02;
  const REST = 150;
  const CENTER = 0.012;
  const DAMP = 0.85;
  const iterations = n > 1 ? 280 : 0;

  for (let it = 0; it < iterations; it++) {
    // Pairwise repulsion.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pts[i].x - pts[j].x;
        let dy = pts[i].y - pts[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.01;
        }
        const f = REPULSE / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        pts[i].vx += fx;
        pts[i].vy += fy;
        pts[j].vx -= fx;
        pts[j].vy -= fy;
      }
    }
    // Spring along edges.
    for (const l of links) {
      const a = pts[l.s];
      const b = pts[l.t];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - REST) * SPRING;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    // Pull toward centre + integrate with damping + clamp to bounds.
    for (let i = 0; i < n; i++) {
      pts[i].vx += (cx - pts[i].x) * CENTER;
      pts[i].vy += (cy - pts[i].y) * CENTER;
      pts[i].vx *= DAMP;
      pts[i].vy *= DAMP;
      pts[i].x = Math.max(30, Math.min(VIEW_W - 30, pts[i].x + pts[i].vx));
      pts[i].y = Math.max(30, Math.min(VIEW_H - 30, pts[i].y + pts[i].vy));
    }
  }

  const out = new Map<string, Pt>();
  nodes.forEach((nd, i) => out.set(nd.id, pts[i]));
  return out;
}

export function WorkspaceGraphPane({
  workspaceId,
  onOpenItem,
}: {
  workspaceId: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
}) {
  const { data: graph, isLoading } = useWorkspaceGraph(workspaceId);

  const layout = useMemo(
    () => (graph ? computeLayout(graph) : new Map<string, Pt>()),
    [graph]
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building graph…
      </div>
    );
  }

  if (!graph || graph.nodes.length < 2) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Share2 className="mb-3 h-8 w-8 text-[var(--text-muted)]" />
        <p className="text-sm font-medium text-[var(--text)]">
          Not much to graph yet
        </p>
        <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">
          Add a few notes, canvases, or chats — then `[[`-link them or let
          semantic similarity connect them automatically.
        </p>
      </div>
    );
  }

  const open = (n: WorkspaceGraph["nodes"][number]) =>
    onOpenItem({
      id: n.id,
      kind: n.kind as WorkspaceItemNode["kind"],
      ref_id: n.ref_id,
      title: n.title,
      icon: null,
      position: 0,
      indexing_status: null,
      children: [],
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-4 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
        <span className="font-semibold uppercase tracking-wide">
          Graph
        </span>
        <LegendDot color={KIND_COLOR.note} label="Note" />
        <LegendDot color={KIND_COLOR.canvas} label="Canvas" />
        <LegendDot color={KIND_COLOR.chat} label="Chat" />
        <span className="ml-auto inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-px w-4 bg-[var(--text-muted)]" />
            link
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-px w-4 bg-[var(--text-muted)]"
              style={{ borderTop: "1px dashed var(--text-muted)" }}
            />
            similar
          </span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Edges */}
          {graph.edges.map((e, i) => {
            const a = layout.get(e.source);
            const b = layout.get(e.target);
            if (!a || !b) return null;
            return (
              <line
                key={`e-${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--border)"
                strokeWidth={1.2}
                strokeDasharray={e.kind === "similar" ? "4 4" : undefined}
                opacity={0.8}
              />
            );
          })}
          {/* Nodes */}
          {graph.nodes.map((n) => {
            const p = layout.get(n.id);
            if (!p) return null;
            const color = KIND_COLOR[n.kind] ?? "#888";
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                className="cursor-pointer"
                onClick={() => open(n)}
              >
                <circle
                  r={9}
                  fill={color}
                  stroke="var(--bg)"
                  strokeWidth={2}
                />
                <text
                  x={12}
                  y={4}
                  fontSize={12}
                  fill="var(--text)"
                  className="pointer-events-none select-none"
                >
                  {(n.title || "Untitled").slice(0, 28)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
