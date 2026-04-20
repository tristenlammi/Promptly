import { useEffect, useMemo, useRef, useState } from "react";
import { History, Pencil, Puzzle } from "lucide-react";

import { studyApi } from "@/api/study";
import { useExerciseHistoryQuery } from "@/hooks/useStudy";
import { useStudyStore } from "@/store/studyStore";
import type {
  ExcalidrawSnapshot,
  WhiteboardExerciseDetail,
} from "@/api/types";
import { cn } from "@/utils/cn";

import { ExerciseHistory } from "./ExerciseHistory";
import {
  ExerciseRenderer,
  type ExerciseRendererHandle,
} from "./ExerciseRenderer";
import { NotesCanvas, type NotesCanvasHandle } from "./NotesCanvas";
import { SubmitBar } from "./SubmitBar";

type Tab = "exercise" | "notes" | "history";

interface WhiteboardPanelProps {
  sessionId: string;
  initialSnapshot: ExcalidrawSnapshot | null;
  /** Called when the student submits. Receives the answer payload from the
   *  iframe and a (possibly-null) PNG of the current Excalidraw scene. */
  onSubmit: (args: {
    exerciseId: string;
    answers: unknown;
    snapshotPngBase64: string | null;
  }) => void;
}

export interface WhiteboardPanelHandle {
  /** Programmatically switch tabs (used when an ``exercise_ready`` event
   *  lands so the panel flips to the new exercise). */
  focusExercise: () => void;
}

/**
 * Split-pane right side. Owns three sub-views in a single panel:
 *   - Exercise: the sandboxed iframe rendering AI-authored HTML.
 *   - Notes: the Excalidraw freehand canvas.
 *   - History: list of past exercises for quick re-entry.
 *
 * Also owns the sticky SubmitBar that dispatches ``REQUEST_SUBMIT`` to the
 * active iframe.
 */
export function WhiteboardPanel({
  sessionId,
  initialSnapshot,
  onSubmit,
}: WhiteboardPanelProps) {
  const activeExercise = useStudyStore((s) => s.activeExercise);
  const historyFromStore = useStudyStore((s) => s.exerciseHistory);
  const setHistoryInStore = useStudyStore((s) => s.setExerciseHistory);
  const setActiveExercise = useStudyStore((s) => s.setActiveExercise);
  const submissionStatus = useStudyStore((s) => s.submissionStatus);

  const [tab, setTab] = useState<Tab>("notes");
  const rendererRef = useRef<ExerciseRendererHandle | null>(null);
  const notesRef = useRef<NotesCanvasHandle | null>(null);

  const exercisesQuery = useExerciseHistoryQuery(sessionId);

  // Seed the store with the list on first load / session switch.
  useEffect(() => {
    if (exercisesQuery.data) {
      setHistoryInStore(exercisesQuery.data);
    }
  }, [exercisesQuery.data, setHistoryInStore]);

  // When a new exercise arrives, jump to the Exercise tab automatically.
  useEffect(() => {
    if (activeExercise) setTab("exercise");
  }, [activeExercise?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openExercise = async (exerciseId: string) => {
    // Fast path — already the active one.
    if (activeExercise?.id === exerciseId) {
      setTab("exercise");
      return;
    }
    try {
      const detail = await studyApi.getExercise(sessionId, exerciseId);
      setActiveExercise(detail);
      setTab("exercise");
    } catch (err) {
      console.warn("Failed to load exercise", err);
    }
  };

  const handleIframeSubmit = async (answers: unknown) => {
    console.log("[promptly] handleIframeSubmit", {
      activeExerciseId: activeExercise?.id ?? null,
      answers,
    });
    if (!activeExercise) return;
    const pngBase64 = (await notesRef.current?.exportPngBase64()) ?? null;
    onSubmit({ exerciseId: activeExercise.id, answers, snapshotPngBase64: pngBase64 });
  };

  const requestSubmitViaBar = () => {
    console.log("[promptly] SubmitBar clicked", {
      hasActiveExercise: Boolean(activeExercise),
      tab,
    });
    if (!activeExercise) {
      console.warn("[promptly] requestSubmitViaBar aborted — no active exercise");
      return;
    }
    // Auto-switch to the Exercise tab if the student somehow clicked the
    // submit bar while on Notes / History. The bar is only visible on the
    // Exercise tab today, but this guards against future layouts that
    // keep it always-visible.
    if (tab !== "exercise") {
      console.warn("[promptly] requestSubmitViaBar: switching tab to exercise first");
      setTab("exercise");
    }
    rendererRef.current?.requestSubmit();
  };

  const submitDisabled = useMemo(() => {
    if (!activeExercise) return true;
    if (activeExercise.status === "submitted") return true;
    if (submissionStatus === "submitting") return true;
    if (submissionStatus === "awaiting_review") return true;
    return false;
  }, [activeExercise, submissionStatus]);

  return (
    <div className="relative flex h-full w-full flex-col bg-[var(--surface)]">
      <TabBar tab={tab} setTab={setTab} hasExercise={Boolean(activeExercise)} />

      <div className="relative min-h-0 flex-1">
        {/* Exercise iframe */}
        <div
          className={cn(
            "absolute inset-0",
            tab === "exercise" ? "visible" : "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "exercise"}
        >
          {activeExercise ? (
            <ExerciseRenderer
              ref={rendererRef}
              exercise={activeExercise}
              onSubmit={handleIframeSubmit}
              className="h-full w-full border-0 bg-[var(--surface)]"
            />
          ) : (
            <EmptyExerciseState />
          )}
        </div>

        {/* Notes/Excalidraw — ALWAYS mounted so scene state survives tab flips. */}
        <div
          className={cn(
            "absolute inset-0",
            tab === "notes" ? "visible" : "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "notes"}
        >
          <NotesCanvas
            ref={notesRef}
            sessionId={sessionId}
            initialSnapshot={initialSnapshot}
            visible={tab === "notes"}
          />
        </div>

        {/* History list */}
        <div
          className={cn(
            "absolute inset-0 overflow-y-auto",
            tab === "history" ? "visible" : "invisible pointer-events-none"
          )}
          aria-hidden={tab !== "history"}
        >
          <ExerciseHistory
            exercises={historyFromStore}
            activeExerciseId={activeExercise?.id ?? null}
            onSelect={(id) => void openExercise(id)}
            isLoading={exercisesQuery.isLoading}
          />
        </div>
      </div>

      {tab === "exercise" && (
        <SubmitBar
          title={activeExercise?.title ?? null}
          disabled={submitDisabled}
          onSubmit={requestSubmitViaBar}
        />
      )}
    </div>
  );
}

interface TabBarProps {
  tab: Tab;
  setTab: (t: Tab) => void;
  hasExercise: boolean;
}

function TabBar({ tab, setTab, hasExercise }: TabBarProps) {
  const btn = (
    id: Tab,
    icon: React.ReactNode,
    label: string,
    disabled?: boolean
  ) => (
    <button
      type="button"
      onClick={() => !disabled && setTab(id)}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        tab === id
          ? "bg-[var(--surface-muted)] text-[var(--text)]"
          : "text-[var(--text-muted)] hover:text-[var(--text)]",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
      {btn(
        "exercise",
        <Puzzle className="h-3.5 w-3.5" />,
        "Exercise",
        !hasExercise
      )}
      {btn("notes", <Pencil className="h-3.5 w-3.5" />, "Notes")}
      {btn("history", <History className="h-3.5 w-3.5" />, "History")}
    </div>
  );
}

function EmptyExerciseState() {
  return (
    <div className="flex h-full w-full items-center justify-center px-8 text-center">
      <div className="max-w-sm text-sm text-[var(--text-muted)]">
        <div className="text-base font-medium text-[var(--text)]">
          No exercise yet
        </div>
        <p className="mt-2">
          Ask the tutor for a quiz or a practice problem and it will appear
          here. Meanwhile, you can sketch in the Notes tab.
        </p>
      </div>
    </div>
  );
}

// Re-export for convenience — some callers import NotesCanvas directly.
export type { WhiteboardExerciseDetail };
