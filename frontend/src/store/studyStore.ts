import { create } from "zustand";

import type {
  StudyExamSummary,
  StudyMessage,
  StudyUnitSummary,
  WhiteboardExerciseDetail,
  WhiteboardExerciseSummary,
} from "@/api/types";

/** Lightweight snapshot of a unit-completion event the stream handler
 *  surfaces so the UI can pop a "Unit complete!" celebration toast. */
export interface UnitCompletedEvent {
  id: string;
  mastery_score: number | null;
  mastery_summary: string | null;
  completed_at: string | null;
}

/** Snapshot of an ``insert_prerequisites`` action — the tutor just
 *  spliced new bridge units into the plan ahead of the current one.
 *  The UnitSession page shows a non-blocking banner so the student
 *  knows what happened but is free to keep chatting. */
export interface UnitsInsertedEvent {
  units: Array<{
    id: string;
    title: string;
    order_index: number;
    inserted_as_prereq: boolean;
  }>;
  reason: string | null;
  before_unit_id: string | null;
}

/** Snapshot of the one-shot ``calibration_warning`` SSE event — fires
 *  when the tutor inserts prerequisites on a project whose calibration
 *  came from a skip. The backend guarantees only ONE firing per
 *  project, so this slot is effectively write-once until the project
 *  is regenerated. */
export interface CalibrationWarningEvent {
  project_id: string;
  reason: string | null;
  batch_id: string | null;
}

export interface ExamGradedEvent {
  id: string;
  status: StudyExamSummary["status"];
  passed: boolean | null;
  score: number | null;
  summary: string | null;
  weak_unit_ids: string[];
  strong_unit_ids: string[];
  ended_at: string | null;
}

interface StudyState {
  /** The session currently open in the split-pane view. */
  activeSessionId: string | null;
  messages: StudyMessage[];
  streamingContent: string;
  isStreaming: boolean;
  streamError: string | null;

  /** Exercise currently shown on the whiteboard. */
  activeExercise: WhiteboardExerciseDetail | null;
  exerciseHistory: WhiteboardExerciseSummary[];
  submissionStatus: "idle" | "submitting" | "awaiting_review" | "error";
  submissionError: string | null;

  /** Live unit snapshot so the UnitSession page can react to
   *  `unit_completed` SSE events without re-fetching. */
  activeUnit: StudyUnitSummary | null;
  lastUnitCompleted: UnitCompletedEvent | null;
  lastUnitsInserted: UnitsInsertedEvent | null;
  /** One-shot honesty nudge fired by the stream when the tutor finds
   *  a gap on a project the student skipped calibration for. The
   *  session page reads this and pops a ``CalibrationWarningToast``. */
  lastCalibrationWarning: CalibrationWarningEvent | null;

  /** Live exam snapshot for the Exam page. */
  activeExam: StudyExamSummary | null;
  lastExamGraded: ExamGradedEvent | null;

  setActiveSession: (id: string | null) => void;
  setMessages: (messages: StudyMessage[]) => void;
  appendMessage: (message: StudyMessage) => void;
  replaceMessage: (id: string, message: StudyMessage) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamingDelta: (delta: string) => void;
  setStreamError: (err: string | null) => void;
  resetStream: () => void;

  setActiveExercise: (exercise: WhiteboardExerciseDetail | null) => void;
  setExerciseHistory: (history: WhiteboardExerciseSummary[]) => void;
  upsertExerciseSummary: (exercise: WhiteboardExerciseSummary) => void;
  markExerciseReviewed: (exerciseId: string) => void;
  setSubmissionStatus: (status: StudyState["submissionStatus"]) => void;
  setSubmissionError: (err: string | null) => void;

  setActiveUnit: (unit: StudyUnitSummary | null) => void;
  setLastUnitCompleted: (event: UnitCompletedEvent | null) => void;
  setLastUnitsInserted: (event: UnitsInsertedEvent | null) => void;
  setLastCalibrationWarning: (event: CalibrationWarningEvent | null) => void;

  setActiveExam: (exam: StudyExamSummary | null) => void;
  setLastExamGraded: (event: ExamGradedEvent | null) => void;
}

export const useStudyStore = create<StudyState>((set) => ({
  activeSessionId: null,
  messages: [],
  streamingContent: "",
  isStreaming: false,
  streamError: null,

  activeExercise: null,
  exerciseHistory: [],
  submissionStatus: "idle",
  submissionError: null,

  activeUnit: null,
  lastUnitCompleted: null,
  lastUnitsInserted: null,
  lastCalibrationWarning: null,

  activeExam: null,
  lastExamGraded: null,

  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  setMessages: (messages) => set({ messages }),
  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  replaceMessage: (id, message) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? message : m)),
    })),
  setStreaming: (isStreaming) => set({ isStreaming }),
  appendStreamingDelta: (delta) =>
    set((state) => ({ streamingContent: state.streamingContent + delta })),
  setStreamError: (streamError) => set({ streamError }),
  resetStream: () =>
    set({
      streamingContent: "",
      isStreaming: false,
      streamError: null,
    }),

  setActiveExercise: (activeExercise) => set({ activeExercise }),
  setExerciseHistory: (exerciseHistory) => set({ exerciseHistory }),
  upsertExerciseSummary: (exercise) =>
    set((state) => {
      const next = state.exerciseHistory.filter((e) => e.id !== exercise.id);
      return { exerciseHistory: [exercise, ...next] };
    }),
  markExerciseReviewed: (exerciseId) =>
    set((state) => ({
      exerciseHistory: state.exerciseHistory.map((e) =>
        e.id === exerciseId ? { ...e, status: "reviewed" } : e
      ),
      activeExercise:
        state.activeExercise && state.activeExercise.id === exerciseId
          ? { ...state.activeExercise, status: "reviewed" }
          : state.activeExercise,
      submissionStatus: "idle",
    })),
  setSubmissionStatus: (submissionStatus) => set({ submissionStatus }),
  setSubmissionError: (submissionError) => set({ submissionError }),

  setActiveUnit: (activeUnit) => set({ activeUnit }),
  setLastUnitCompleted: (lastUnitCompleted) => set({ lastUnitCompleted }),
  setLastUnitsInserted: (lastUnitsInserted) => set({ lastUnitsInserted }),
  setLastCalibrationWarning: (lastCalibrationWarning) =>
    set({ lastCalibrationWarning }),

  setActiveExam: (activeExam) => set({ activeExam }),
  setLastExamGraded: (lastExamGraded) => set({ lastExamGraded }),
}));
