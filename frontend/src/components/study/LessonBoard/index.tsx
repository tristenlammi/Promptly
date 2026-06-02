import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  FileText,
  History,
  Lightbulb,
  NotebookPen,
  Puzzle,
  Star,
  TrendingUp,
  Triangle,
  Zap,
} from "lucide-react";

import { studyApi } from "@/api/study";
import { useStudyStore } from "@/store/studyStore";
import { cn } from "@/utils/cn";
import type { BoardBlockKind, StudyBoardBlock } from "@/api/types";
import { CalibrationChart } from "@/components/study/CalibrationChart";
import { ExerciseHistory } from "@/components/study/Whiteboard/ExerciseHistory";
import {
  ExerciseRenderer,
  type ExerciseRendererHandle,
} from "@/components/study/Whiteboard/ExerciseRenderer";
import { SubmitBar } from "@/components/study/Whiteboard/SubmitBar";
import { UnitNotes } from "@/components/study/Whiteboard/UnitNotes";

// ---- Tab type -------------------------------------------------------

type Tab = "board" | "notes" | "history" | "insights";

// ---- Block renderers ------------------------------------------------

function TermBlock({ payload }: { payload: Record<string, unknown> }) {
  const term = String(payload.term ?? "");
  const def = String(payload.def ?? "");
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent)]">
          Term
        </span>
      </div>
      <p className="font-medium text-[var(--text)]">{term}</p>
      <p className="mt-0.5 text-sm leading-relaxed text-[var(--text-muted)]">{def}</p>
    </div>
  );
}

function NoteBlock({ payload }: { payload: Record<string, unknown> }) {
  const text = String(payload.text ?? "");
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
          Note
        </span>
      </div>
      <p className="text-sm leading-relaxed text-[var(--text)]">{text}</p>
    </div>
  );
}

function WorkedExampleBlock({ payload }: { payload: Record<string, unknown> }) {
  const title = String(payload.title ?? "Example");
  const steps = Array.isArray(payload.steps)
    ? (payload.steps as unknown[]).map(String)
    : [];
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-700/40 dark:bg-amber-900/10">
      <div className="mb-2 flex items-center gap-1.5">
        <Star className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">
          Worked example
        </span>
      </div>
      <p className="mb-2 text-sm font-medium text-[var(--text)]">{title}</p>
      {steps.length > 0 && (
        <ol className="space-y-1.5">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-sm text-[var(--text)]">
              <span className="mt-0.5 shrink-0 text-[10px] font-bold text-[var(--text-muted)]">
                {i + 1}.
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CalloutBlock({ payload }: { payload: Record<string, unknown> }) {
  const text = String(payload.text ?? "");
  const label = String(payload.label ?? "Key idea");

  type ColorKey = "Warning" | "Key idea" | "Surprise";
  const colorMap: Record<ColorKey, string> = {
    Warning:
      "border-amber-300 bg-amber-50/80 dark:border-amber-700/40 dark:bg-amber-900/10",
    "Key idea":
      "border-blue-300 bg-blue-50/80 dark:border-blue-700/40 dark:bg-blue-900/10",
    Surprise:
      "border-purple-300 bg-purple-50/80 dark:border-purple-700/40 dark:bg-purple-900/10",
  };
  const iconMap: Record<ColorKey, React.ReactNode> = {
    Warning: <Triangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />,
    "Key idea": <Lightbulb className="h-3.5 w-3.5 shrink-0 text-blue-500" />,
    Surprise: <Zap className="h-3.5 w-3.5 shrink-0 text-purple-500" />,
  };
  const colorClass =
    colorMap[label as ColorKey] ??
    "border-[var(--border)] bg-[var(--surface)]";
  const icon = iconMap[label as ColorKey] ?? (
    <Lightbulb className="h-3.5 w-3.5 shrink-0 text-blue-500" />
  );

  return (
    <div className={cn("rounded-lg border p-3", colorClass)}>
      <div className="mb-1 flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
          {label}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-[var(--text)]">{text}</p>
    </div>
  );
}

function ConceptNodeBlock({ payload }: { payload: Record<string, unknown> }) {
  const label = String(payload.label ?? "");
  const note = payload.note ? String(payload.note) : null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="inline-flex items-center rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-3 py-1">
        <span className="text-sm font-semibold text-[var(--accent)]">{label}</span>
      </div>
      {note && (
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{note}</p>
      )}
    </div>
  );
}

function DiagramBlock({ payload }: { payload: Record<string, unknown> }) {
  const svg = String(payload.svg ?? "");
  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 [&_svg]:max-w-full"
      // SVG content from the trusted tutor model — rendered inline.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ---- Concept-map block (#17) ----------------------------------------

interface CMNode { id: string; label: string; note?: string }
interface CMEdge { from: string; to: string; label?: string }

const MAP_W = 280;
const MAP_H = 200;

function ConceptMapBlock({ payload }: { payload: Record<string, unknown> }) {
  const title = payload.title ? String(payload.title) : null;
  const nodes: CMNode[] = Array.isArray(payload.nodes)
    ? (payload.nodes as CMNode[])
    : [];
  const edges: CMEdge[] = Array.isArray(payload.edges)
    ? (payload.edges as CMEdge[])
    : [];

  if (nodes.length === 0) return null;

  // Radial layout: first node centre, rest equally spaced around.
  const cx = MAP_W / 2;
  const cy = MAP_H / 2;
  const r = Math.min(cx, cy) * 0.68;

  const positions: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n, i) => {
    if (i === 0) {
      positions[n.id] = { x: cx, y: cy };
    } else {
      const angle = ((i - 1) / Math.max(nodes.length - 1, 1)) * 2 * Math.PI - Math.PI / 2;
      positions[n.id] = {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      };
    }
  });

  return (
    <div className="rounded-lg border border-purple-300/40 bg-purple-50/40 p-3 dark:border-purple-700/30 dark:bg-purple-900/10">
      {title && (
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-purple-600 dark:text-purple-400">
          {title}
        </p>
      )}
      <svg
        width={MAP_W}
        height={MAP_H}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className="mx-auto block max-w-full"
      >
        {/* Edges */}
        {edges.map((e, i) => {
          const from = positions[e.from];
          const to = positions[e.to];
          if (!from || !to) return null;
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          return (
            <g key={i}>
              <line
                x1={from.x} y1={from.y}
                x2={to.x} y2={to.y}
                stroke="currentColor"
                strokeOpacity={0.25}
                strokeWidth={1.5}
              />
              {e.label && (
                <text
                  x={midX} y={midY - 4}
                  textAnchor="middle"
                  fontSize={8}
                  fill="currentColor"
                  opacity={0.45}
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {/* Nodes */}
        {nodes.map((n, i) => {
          const pos = positions[n.id];
          if (!pos) return null;
          const isCenter = i === 0;
          return (
            <g key={n.id}>
              <rect
                x={pos.x - 36} y={pos.y - 12}
                width={72} height={24}
                rx={12}
                fill={isCenter ? "rgb(168 85 247 / 0.2)" : "rgb(168 85 247 / 0.08)"}
                stroke="rgb(168 85 247 / 0.4)"
                strokeWidth={isCenter ? 1.5 : 1}
              />
              <text
                x={pos.x} y={pos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={9}
                fontWeight={isCenter ? "600" : "400"}
                fill="currentColor"
              >
                {n.label.length > 12 ? n.label.slice(0, 11) + "…" : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function BlockRenderer({ block }: { block: StudyBoardBlock }) {
  const kind = block.kind as BoardBlockKind;
  switch (kind) {
    case "term":
      return <TermBlock payload={block.payload} />;
    case "note":
      return <NoteBlock payload={block.payload} />;
    case "worked_example":
      return <WorkedExampleBlock payload={block.payload} />;
    case "callout":
      return <CalloutBlock payload={block.payload} />;
    case "concept_node":
      return <ConceptNodeBlock payload={block.payload} />;
    case "diagram_svg":
      return <DiagramBlock payload={block.payload} />;
    case "concept_map":
      return <ConceptMapBlock payload={block.payload} />;
    case "exercise_ref":
      // Exercise itself renders above; skip the ref block in the list.
      return null;
    default:
      return <NoteBlock payload={block.payload} />;
  }
}

// ---- Animated wrapper -----------------------------------------------

function AnimatedBlock({
  block,
  index,
}: {
  block: StudyBoardBlock;
  index: number;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // Stagger each block by 80ms on initial hydration so the board
    // "builds up" with weight. Cap at 400ms total so a long board
    // doesn't make the student wait. Live-pinned blocks arrive
    // one at a time so index=0 applies → immediate fade-in.
    const delay = Math.min(index * 80, 400);
    const id = setTimeout(
      () => requestAnimationFrame(() => setVisible(true)),
      delay
    );
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      className={cn(
        "transition-all duration-400 ease-out",
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      )}
    >
      <BlockRenderer block={block} />
    </div>
  );
}

// ---- Main component -------------------------------------------------

interface LessonBoardProps {
  sessionId: string;
  /** Project id — used for the Calibration Chart in the Insights tab. */
  projectId: string;
  initialNotes: string | null;
  onSubmit: (args: { exerciseId: string; answers: unknown }) => void;
}

export function LessonBoard({
  sessionId,
  projectId,
  initialNotes,
  onSubmit,
}: LessonBoardProps) {
  const [tab, setTab] = useState<Tab>("board");
  const boardBlocks = useStudyStore((s) => s.boardBlocks);
  const setBoardBlocks = useStudyStore((s) => s.setBoardBlocks);
  const activeExercise = useStudyStore((s) => s.activeExercise);
  const historyFromStore = useStudyStore((s) => s.exerciseHistory);
  const setActiveExercise = useStudyStore((s) => s.setActiveExercise);
  const submissionStatus = useStudyStore((s) => s.submissionStatus);

  const rendererRef = useRef<ExerciseRendererHandle | null>(null);

  // Hydrate board blocks from the API once per session mount.
  useEffect(() => {
    setBoardBlocks([]);
    void studyApi
      .getBoardBlocks(sessionId)
      .then(setBoardBlocks)
      .catch(() => {
        // Silently ignore — board just starts empty.
      });
  }, [sessionId, setBoardBlocks]);

  // Auto-switch to the board tab when a new block arrives live.
  const prevBlockCountRef = useRef(0);
  useEffect(() => {
    if (boardBlocks.length > prevBlockCountRef.current) {
      setTab("board");
    }
    prevBlockCountRef.current = boardBlocks.length;
  }, [boardBlocks.length]);

  // Auto-switch to board tab (which contains the exercise) when a new exercise arrives.
  useEffect(() => {
    if (activeExercise) setTab("board");
  }, [activeExercise?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openExercise = async (exerciseId: string) => {
    if (activeExercise?.id === exerciseId) {
      setTab("board");
      return;
    }
    try {
      const detail = await studyApi.getExercise(sessionId, exerciseId);
      setActiveExercise(detail);
      setTab("board");
    } catch (err) {
      console.warn("Failed to load exercise", err);
    }
  };

  const handleIframeSubmit = (answers: unknown) => {
    if (!activeExercise) return;
    onSubmit({ exerciseId: activeExercise.id, answers });
  };

  const requestSubmitViaBar = () => {
    if (!activeExercise) return;
    rendererRef.current?.requestSubmit();
  };

  const submitDisabled = useMemo(() => {
    if (!activeExercise) return true;
    if (activeExercise.status === "submitted") return true;
    if (submissionStatus === "submitting") return true;
    if (submissionStatus === "awaiting_review") return true;
    return false;
  }, [activeExercise, submissionStatus]);

  const hasActiveExercise =
    activeExercise !== null && activeExercise.status !== "reviewed";

  const tabBtn = (id: Tab, icon: React.ReactNode, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        tab === id
          ? "bg-[var(--surface-muted)] text-[var(--text)]"
          : "text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="relative flex h-full w-full flex-col bg-[var(--surface)]">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        {tabBtn("board", <BookOpen className="h-3.5 w-3.5" />, "Board")}
        {tabBtn("notes", <NotebookPen className="h-3.5 w-3.5" />, "Notes")}
        {tabBtn("history", <History className="h-3.5 w-3.5" />, "Exercises")}
        {tabBtn("insights", <TrendingUp className="h-3.5 w-3.5" />, "Insights")}
        {hasActiveExercise && (
          <span className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-[var(--accent)]">
            <Puzzle className="h-3 w-3" />
            Exercise active
          </span>
        )}
      </div>

      {/* Tab panels — all always mounted; visibility toggled */}
      <div className="relative min-h-0 flex-1">

        {/* Board panel */}
        <div
          className={cn(
            "absolute inset-0 flex flex-col overflow-hidden",
            tab !== "board" && "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "board"}
        >
          {/* Active exercise sits at the top of the board panel */}
          {hasActiveExercise && activeExercise && (
            <div className="flex h-1/2 shrink-0 flex-col border-b border-[var(--border)]">
              <ExerciseRenderer
                ref={rendererRef}
                exercise={activeExercise}
                onSubmit={handleIframeSubmit}
                className="h-full w-full border-0 bg-[var(--surface)]"
              />
            </div>
          )}

          {/* Pinned blocks */}
          <div className="flex-1 overflow-y-auto p-3">
            {boardBlocks.length === 0 && !hasActiveExercise ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-muted)]">
                <BookOpen className="h-7 w-7 opacity-25" />
                <p className="text-sm">
                  Terms, examples, and key ideas pin here as your tutor
                  introduces them.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {boardBlocks.map((block, idx) => (
                  <AnimatedBlock key={block.id} block={block} index={idx} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Notes panel — always mounted so unsaved edits survive tab switches */}
        <div
          className={cn(
            "absolute inset-0",
            tab !== "notes" && "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "notes"}
        >
          <UnitNotes
            sessionId={sessionId}
            initialNotes={initialNotes}
            visible={tab === "notes"}
          />
        </div>

        {/* History panel */}
        <div
          className={cn(
            "absolute inset-0 overflow-y-auto",
            tab !== "history" && "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "history"}
        >
          <ExerciseHistory
            exercises={historyFromStore}
            activeExerciseId={activeExercise?.id ?? null}
            onSelect={(id) => void openExercise(id)}
          />
        </div>

        {/* Insights panel — calibration chart (#18) */}
        <div
          className={cn(
            "absolute inset-0 overflow-y-auto p-3",
            tab !== "insights" && "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "insights"}
        >
          <p className="mb-3 text-xs font-medium text-[var(--text)]">
            Confidence vs. correctness
          </p>
          <CalibrationChart projectId={projectId} />
        </div>
      </div>

      {/* Submit bar — visible whenever an exercise is active, on any tab */}
      {hasActiveExercise && (
        <SubmitBar
          title={activeExercise?.title ?? null}
          disabled={submitDisabled}
          onSubmit={requestSubmitViaBar}
        />
      )}
    </div>
  );
}
