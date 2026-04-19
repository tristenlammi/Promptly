import { create } from "zustand";

import type {
  StudyMessage,
  WhiteboardExerciseDetail,
  WhiteboardExerciseSummary,
} from "@/api/types";

interface StudyState {
  /** The session currently open in the split-pane view. */
  activeSessionId: string | null;
  messages: StudyMessage[];
  streamingContent: string;
  isStreaming: boolean;
  streamError: string | null;

  /** Exercise currently shown on the whiteboard — set from the `exercise_ready`
   *  SSE event or when the user picks one from the history panel. */
  activeExercise: WhiteboardExerciseDetail | null;
  /** Latest summary list for the History tab. Kept separate so we don't have
   *  to refetch the heavy `html` body every time a new one lands. */
  exerciseHistory: WhiteboardExerciseSummary[];
  /** Submission lifecycle state for the sticky SubmitBar. */
  submissionStatus: "idle" | "submitting" | "awaiting_review" | "error";
  submissionError: string | null;

  setActiveSession: (id: string | null) => void;
  setMessages: (messages: StudyMessage[]) => void;
  appendMessage: (message: StudyMessage) => void;
  /** Swap a message (matched by id) for a new one. Used to reconcile an
   *  optimistic client-side user message with the server-persisted copy. */
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
}));
