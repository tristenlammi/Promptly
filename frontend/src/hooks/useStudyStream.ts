import { useCallback, useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { studyApi, type StudySendMessagePayload } from "@/api/study";

/** After any stream finishes, refresh all query surfaces that could
 *  have changed — the session detail, the full project list, both
 *  the active and archived project lists, exercise history, plus
 *  every project-detail and unit query currently mounted. Over-
 *  invalidating is cheap and keeps the UI honest. */
function invalidateStudy(qc: QueryClient, sessionId: string): void {
  qc.invalidateQueries({ queryKey: ["study", "session", sessionId] });
  qc.invalidateQueries({ queryKey: ["study", "projects"] });
  qc.invalidateQueries({ queryKey: ["study", "exercises", sessionId] });
  // Project detail + unit + exam queries share the ["study", ...] prefix.
  qc.invalidateQueries({ queryKey: ["study", "project"] });
  qc.invalidateQueries({ queryKey: ["study", "unit"] });
  qc.invalidateQueries({ queryKey: ["study", "exam"] });
}
import { authHeader } from "@/api/client";
import { useStudyStore } from "@/store/studyStore";
import type {
  StudyMessage,
  WhiteboardExerciseDetail,
  WhiteboardExerciseSummary,
} from "@/api/types";

/** Re-used SSE parser. Mirrors the one in useStreamingChat. */
async function* iterateSSE(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sepIndex);
        buf = buf.slice(sepIndex + 2);

        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length > 0) {
          yield dataLines.join("\n");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface ExerciseReadyPayload {
  id: string;
  session_id: string;
  message_id: string | null;
  title: string | null;
  html: string;
  status: "active" | "submitted" | "reviewed";
  created_at: string;
}

interface UnitCompletedPayload {
  id: string;
  status: string;
  mastery_score: number | null;
  mastery_summary: string | null;
  completed_at: string | null;
}

interface UnitsInsertedPayload {
  units: Array<{
    id: string;
    title: string;
    order_index: number;
    inserted_as_prereq: boolean;
  }>;
  reason: string | null;
  before_unit_id: string | null;
}

interface ExamGradedPayload {
  id: string;
  status: "pending" | "in_progress" | "passed" | "failed";
  passed: boolean | null;
  score: number | null;
  summary: string | null;
  weak_unit_ids: string[];
  strong_unit_ids: string[];
  ended_at: string | null;
}

interface SSEPayload {
  event?: string;
  delta?: string;
  done?: boolean;
  error?: string;
  message_id?: string;
  created_at?: string;
  stream_id?: string;
  exercise?: ExerciseReadyPayload;
  exercise_id?: string;
  kind?: string;
  unit?: UnitCompletedPayload;
  exam?: ExamGradedPayload;
  units?: UnitsInsertedPayload["units"];
  reason?: string | null;
  before_unit_id?: string | null;
  project_id?: string;
  batch_id?: string | null;
  /** Keys of learner state that changed this turn, so we know which
   *  query caches to invalidate rather than blasting all of them. */
  changes?: string[];
  /** List of unmet completion-gate conditions returned when the AI
   *  tried ``mark_complete`` prematurely. Shown to the student as a
   *  subtle hint strip so they understand why the unit isn't closing. */
  unmet?: string[];
  session_id?: string;
}

interface SendMessageOptions {
  /** If set, the store already contains an optimistic user message with this
   *  id. The POST's persisted user_message is swapped into the same slot
   *  instead of being appended, avoiding React key churn. */
  optimisticUserId?: string;
}

interface UseStudyStreamResult {
  sendMessage: (
    sessionId: string,
    payload: StudySendMessagePayload,
    options?: SendMessageOptions
  ) => Promise<void>;
  /** Attach to an existing `stream_id` (used by the submit-evaluation flow
   *  where the enqueue happened via a different HTTP call). */
  attachStream: (sessionId: string, streamId: string) => Promise<void>;
  cancel: () => void;
}

export function useStudyStream(): UseStudyStreamResult {
  const qc = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  // Shared consumer for the streaming response body. Once the SendMessage or
  // SubmitExercise call has set up the user message + redis ctx, both paths
  // end up running the same SSE reader here.
  const consumeStream = useCallback(
    async (sessionId: string, streamId: string, ac: AbortController) => {
      const store = useStudyStore.getState();
      const resp = await fetch(studyApi.streamUrl(sessionId, streamId), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...authHeader(),
        },
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        const body = resp.body ? await resp.text() : "";
        throw new Error(
          `Stream failed: ${resp.status} ${resp.statusText}${body ? ` — ${body}` : ""}`
        );
      }

      let finalMessage: StudyMessage | null = null;

      for await (const raw of iterateSSE(resp.body, ac.signal)) {
        let data: SSEPayload;
        try {
          data = JSON.parse(raw) as SSEPayload;
        } catch {
          continue;
        }

        if (data.error && !data.event) {
          store.setStreamError(data.error);
          continue;
        }

        if (data.event === "exercise_ready" && data.exercise) {
          const ex = data.exercise;
          const detail: WhiteboardExerciseDetail = {
            id: ex.id,
            session_id: ex.session_id,
            message_id: ex.message_id,
            title: ex.title,
            status: ex.status,
            created_at: ex.created_at,
            submitted_at: null,
            html: ex.html,
            answer_payload: null,
            ai_feedback: null,
          };
          const summary: WhiteboardExerciseSummary = {
            id: ex.id,
            session_id: ex.session_id,
            message_id: ex.message_id,
            title: ex.title,
            status: ex.status,
            created_at: ex.created_at,
            submitted_at: null,
          };
          store.setActiveExercise(detail);
          store.upsertExerciseSummary(summary);
          continue;
        }

        if (data.event === "exercise_reviewed" && data.exercise_id) {
          store.markExerciseReviewed(data.exercise_id);
          continue;
        }

        if (data.event === "project_calibrated") {
          // The tutor just closed the Unit-1 diagnostic. Invalidate
          // the project-detail query so the skip banner reads the
          // fresh ``calibrated`` flag on its next render.
          qc.invalidateQueries({ queryKey: ["study", "project"] });
          continue;
        }

        if (data.event === "calibration_warning" && data.project_id) {
          // Honesty nudge: the student skipped the warm-up and the
          // tutor has now found a gap that would have been caught.
          // Store once; the session page pops a toast on next render.
          store.setLastCalibrationWarning({
            project_id: data.project_id,
            reason: data.reason ?? null,
            batch_id: data.batch_id ?? null,
          });
          continue;
        }

        if (data.event === "units_inserted" && data.units) {
          store.setLastUnitsInserted({
            units: data.units,
            reason: data.reason ?? null,
            before_unit_id: data.before_unit_id ?? null,
          });
          // Eagerly invalidate the project-detail query so the topic
          // page picks up the new rows the next time the student
          // steps back — and so any "already open in another tab"
          // instance refreshes. The final ``invalidateStudy`` in the
          // finally block will run again at stream end.
          qc.invalidateQueries({ queryKey: ["study", "project"] });
          continue;
        }

        if (data.event === "unit_completed" && data.unit) {
          store.setLastUnitCompleted({
            id: data.unit.id,
            mastery_score: data.unit.mastery_score,
            mastery_summary: data.unit.mastery_summary,
            completed_at: data.unit.completed_at,
          });
          continue;
        }

        if (data.event === "study_state_updated") {
          // Fine-grained invalidation driven by the ``changes`` list
          // the server emits. Falls back to a broad invalidation if
          // the list is absent so a shape mismatch never leaves the
          // UI stale.
          const changes = new Set(data.changes ?? []);
          if (changes.size === 0 || changes.has("learner_profile")) {
            qc.invalidateQueries({ queryKey: ["study", "learner-profile"] });
          }
          if (changes.size === 0 || changes.has("objective_mastery")) {
            qc.invalidateQueries({ queryKey: ["study", "objective-mastery"] });
            qc.invalidateQueries({ queryKey: ["study", "review-queue"] });
          }
          if (changes.size === 0 || changes.has("misconceptions")) {
            qc.invalidateQueries({ queryKey: ["study", "misconceptions"] });
          }
          if (changes.size === 0 || changes.has("reflections")) {
            qc.invalidateQueries({ queryKey: ["study", "project"] });
          }
          // The session itself almost always advances too (teachback /
          // confidence flags), so refresh that here rather than
          // waiting for the post-stream sweep.
          qc.invalidateQueries({ queryKey: ["study", "session"] });
          continue;
        }

        if (data.event === "mark_complete_rejected") {
          // The server refused the tutor's mark_complete emission —
          // the AI is already receiving the unmet list as a synthetic
          // system message and will self-correct. We still invalidate
          // the session query so any surfaced counters (turn count,
          // teachback flag) update for the student.
          qc.invalidateQueries({ queryKey: ["study", "session"] });
          continue;
        }

        if (data.event === "exam_graded" && data.exam) {
          store.setLastExamGraded({
            id: data.exam.id,
            status: data.exam.status,
            passed: data.exam.passed,
            score: data.exam.score,
            summary: data.exam.summary,
            weak_unit_ids: data.exam.weak_unit_ids,
            strong_unit_ids: data.exam.strong_unit_ids,
            ended_at: data.exam.ended_at,
          });
          continue;
        }

        if (data.delta) {
          store.appendStreamingDelta(data.delta);
        }
        if (data.done) {
          const content = useStudyStore.getState().streamingContent;
          if (data.message_id && data.created_at) {
            finalMessage = {
              id: data.message_id,
              session_id: sessionId,
              role: "assistant",
              content,
              created_at: data.created_at,
            };
          }
          break;
        }
      }

      if (finalMessage) store.appendMessage(finalMessage);
    },
    [qc]
  );

  const sendMessage = useCallback(
    async (
      sessionId: string,
      payload: StudySendMessagePayload,
      options?: SendMessageOptions
    ) => {
      const store = useStudyStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      store.resetStream();
      store.setStreaming(true);

      try {
        const { stream_id, user_message } = await studyApi.sendMessage(
          sessionId,
          payload
        );
        if (options?.optimisticUserId) {
          store.replaceMessage(options.optimisticUserId, user_message);
        } else {
          store.appendMessage(user_message);
        }
        await consumeStream(sessionId, stream_id, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useStudyStore.getState().setStreaming(false);
        invalidateStudy(qc, sessionId);
        useStudyStore.setState({ streamingContent: "" });
      }
    },
    [cancel, qc, consumeStream]
  );

  const attachStream = useCallback(
    async (sessionId: string, streamId: string) => {
      const store = useStudyStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      store.resetStream();
      store.setStreaming(true);

      try {
        await consumeStream(sessionId, streamId, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useStudyStore.getState().setStreaming(false);
        invalidateStudy(qc, sessionId);
        useStudyStore.setState({ streamingContent: "" });
      }
    },
    [cancel, qc, consumeStream]
  );

  return { sendMessage, attachStream, cancel };
}
