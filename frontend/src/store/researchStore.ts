import { create } from "zustand";

export type ResearchStep =
  | "idle"
  | "decomposing"
  | "searching"
  | "reading"
  | "gap_check"
  | "synthesizing"
  | "done"
  | "error";

export interface SubQuestion {
  question: string;
  search_query: string;
  status: "queued" | "searching" | "reading" | "done";
  sources_found: number;
}

interface ResearchState {
  /** Conversation this research run belongs to. */
  conversationId: string | null;
  step: ResearchStep;
  query: string;
  subquestions: SubQuestion[];
  /** Incrementally-built synthesis text (streaming). */
  streamingReport: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  sourceCount: number;
  error: string | null;

  /** Proactive suggestion chip state. */
  suggestion: {
    conversationId: string;
    query: string;
    visible: boolean;
  } | null;

  // ── Actions ───────────────────────────────────────────────────────
  startResearch(conversationId: string, query: string): void;
  setDecomposed(subquestions: Array<{ question: string; search_query: string }>): void;
  setSearching(index: number): void;
  setSearched(index: number, sourcesFound: number): void;
  setReading(index: number): void;
  setQuestionDone(index: number): void;
  setSynthesizing(): void;
  appendReportDelta(delta: string): void;
  finishResearch(opts: {
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    sourceCount: number;
  }): void;
  setError(message: string): void;
  reset(): void;

  showSuggestion(conversationId: string, query: string): void;
  dismissSuggestion(): void;
}

export const useResearchStore = create<ResearchState>((set) => ({
  conversationId: null,
  step: "idle",
  query: "",
  subquestions: [],
  streamingReport: "",
  costUsd: 0,
  promptTokens: 0,
  completionTokens: 0,
  sourceCount: 0,
  error: null,
  suggestion: null,

  startResearch(conversationId, query) {
    set({
      conversationId,
      query,
      step: "decomposing",
      subquestions: [],
      streamingReport: "",
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      sourceCount: 0,
      error: null,
    });
  },

  setDecomposed(sqs) {
    set({
      step: "searching",
      subquestions: sqs.map((sq) => ({
        question: sq.question,
        search_query: sq.search_query,
        status: "queued",
        sources_found: 0,
      })),
    });
  },

  setSearching(index) {
    set((s) => ({
      subquestions: s.subquestions.map((sq, i) =>
        i === index ? { ...sq, status: "searching" } : sq
      ),
    }));
  },

  setSearched(index, sourcesFound) {
    set((s) => ({
      subquestions: s.subquestions.map((sq, i) =>
        i === index ? { ...sq, sources_found: sourcesFound } : sq
      ),
    }));
  },

  setReading(index) {
    set((s) => ({
      step: "reading",
      subquestions: s.subquestions.map((sq, i) =>
        i === index ? { ...sq, status: "reading" } : sq
      ),
    }));
  },

  setQuestionDone(index) {
    set((s) => ({
      subquestions: s.subquestions.map((sq, i) =>
        i === index ? { ...sq, status: "done" } : sq
      ),
    }));
  },

  setSynthesizing() {
    set({ step: "synthesizing" });
  },

  appendReportDelta(delta) {
    set((s) => ({ streamingReport: s.streamingReport + delta }));
  },

  finishResearch({ costUsd, promptTokens, completionTokens, sourceCount }) {
    set({ step: "done", costUsd, promptTokens, completionTokens, sourceCount });
  },

  setError(message) {
    set({ step: "error", error: message });
  },

  reset() {
    set({
      conversationId: null,
      step: "idle",
      query: "",
      subquestions: [],
      streamingReport: "",
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      sourceCount: 0,
      error: null,
    });
  },

  showSuggestion(conversationId, query) {
    set({ suggestion: { conversationId, query, visible: true } });
  },

  dismissSuggestion() {
    set((s) =>
      s.suggestion ? { suggestion: { ...s.suggestion, visible: false } } : {}
    );
  },
}));

/** Helper: is research actively running for a given conversation? */
export function isResearchActive(
  state: Pick<ResearchState, "conversationId" | "step">,
  conversationId: string | null
) {
  return (
    state.conversationId === conversationId &&
    state.step !== "idle" &&
    state.step !== "done" &&
    state.step !== "error"
  );
}

