import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { InputBar } from "@/components/chat/InputBar";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { TopNav } from "@/components/layout/TopNav";
import { ExamContextPanel } from "@/components/study/ExamContextPanel";
import { ExamResultsModal } from "@/components/study/ExamResultsModal";
import { SplitPane } from "@/components/study/SplitPane";
import { StudyChat } from "@/components/study/StudyChat";
import { DiagnosticBanner } from "@/components/study/DiagnosticBanner";
import { CalibrationWarningToast } from "@/components/study/CalibrationWarningToast";
import { UnitCompletedToast } from "@/components/study/UnitCompletedToast";
import { UnitsInsertedToast } from "@/components/study/UnitsInsertedToast";
import { UnitContextPanel } from "@/components/study/UnitContextPanel";
import { ConfidenceWidget } from "@/components/study/ConfidenceWidget";
import { WhiteboardPanel } from "@/components/study/Whiteboard/WhiteboardPanel";
import { studyApi } from "@/api/study";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  useArchiveStudyProject,
  useCalibrateStudyProject,
  useExerciseHistoryQuery,
  useStudyExamQuery,
  useStudyProjectQuery,
  useStudySessionQuery,
  useStudyUnitQuery,
} from "@/hooks/useStudy";
import { useStudyStream } from "@/hooks/useStudyStream";
import { useStudyStore } from "@/store/studyStore";
import { useSelectedModel } from "@/store/modelStore";
import { cn } from "@/utils/cn";
import type { StudyMessage } from "@/api/types";

export function StudySessionPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // One-shot review-focus pointer captured from ``?review=<id>``.
  // Consumed (and cleared from the URL) by the first send so we
  // don't redundantly resend it after a tab refresh. The backend
  // is the source of truth once the session is stamped.
  const reviewFocusIdRef = useRef<string | null>(
    searchParams.get("review")
  );
  // One-shot kickoff stream id captured from ``?kickoff=<id>``. The
  // session-enter endpoint returns it for brand-new sessions so the
  // tutor can speak first; we attach exactly once per mount and
  // strip the param so a refresh doesn't try to re-consume a
  // stream key that has already been getdel'd out of redis.
  const kickoffStreamIdRef = useRef<string | null>(
    searchParams.get("kickoff")
  );
  const kickoffAttachedRef = useRef(false);

  const setActiveSession = useStudyStore((s) => s.setActiveSession);
  const setMessages = useStudyStore((s) => s.setMessages);
  const resetStream = useStudyStore((s) => s.resetStream);
  const isStreaming = useStudyStore((s) => s.isStreaming);
  const setActiveExercise = useStudyStore((s) => s.setActiveExercise);
  const setExerciseHistory = useStudyStore((s) => s.setExerciseHistory);
  const lastUnitCompleted = useStudyStore((s) => s.lastUnitCompleted);
  const lastUnitsInserted = useStudyStore((s) => s.lastUnitsInserted);
  const lastCalibrationWarning = useStudyStore((s) => s.lastCalibrationWarning);
  const lastExamGraded = useStudyStore((s) => s.lastExamGraded);
  const setLastUnitCompleted = useStudyStore((s) => s.setLastUnitCompleted);
  const setLastUnitsInserted = useStudyStore((s) => s.setLastUnitsInserted);
  const setLastCalibrationWarning = useStudyStore(
    (s) => s.setLastCalibrationWarning
  );
  const setLastExamGraded = useStudyStore((s) => s.setLastExamGraded);

  const { sendMessage, attachStream, cancel } = useStudyStream();
  const setSubmissionStatus = useStudyStore((s) => s.setSubmissionStatus);
  const setSubmissionError = useStudyStore((s) => s.setSubmissionError);
  const appendStudyMessage = useStudyStore((s) => s.appendMessage);
  const selectedModel = useSelectedModel();
  const isMobile = useIsMobile();
  const archiveMutation = useArchiveStudyProject();
  const calibrateMutation = useCalibrateStudyProject();

  const { data: session, isLoading: sessionLoading } = useStudySessionQuery(
    sessionId ?? null
  );
  const { data: project } = useStudyProjectQuery(session?.project_id ?? null);
  const { data: unit } = useStudyUnitQuery(session?.unit_id ?? null);
  const { data: exam } = useStudyExamQuery(session?.exam_id ?? null);
  // Exercise history drives both the chat "Open exercise" button labels
  // and the post-refresh auto-restore of an in-progress exercise (see
  // the effect further down). Mounted here rather than only inside
  // WhiteboardPanel so it's available even when the context panel is
  // the active right-pane view.
  const exercisesQuery = useExerciseHistoryQuery(sessionId ?? null);

  const [examResultsOpen, setExamResultsOpen] = useState(false);
  const [timeoutPending, setTimeoutPending] = useState(false);
  const [unitToastDismissed, setUnitToastDismissed] = useState<string | null>(
    null
  );
  // Id of the exercise the student explicitly re-opened from the chat
  // transcript. We use this to override the "auto-hide reviewed
  // exercises" rule below so clicking "Revisit exercise" on an old
  // message actually flips the pane back to the whiteboard.
  // Scoped to one id at a time — when a different exercise becomes
  // active (e.g. the tutor emits a new one) the override naturally
  // drops because the stored id no longer matches.
  const [manualOpenExerciseId, setManualOpenExerciseId] = useState<
    string | null
  >(null);

  const kind = session?.kind ?? "legacy";
  const completedUnits =
    project?.units.filter((u) => u.status === "completed").length ?? 0;

  // Right-pane routing for unit/exam sessions: when the tutor is actively
  // running a whiteboard exercise (the student hasn't finished reviewing
  // it yet) the whiteboard needs the full pane so they can work on it;
  // otherwise the context panel (objectives / exam timer) stays visible
  // as the default. Legacy sessions always show the whiteboard because
  // that's the only affordance they have. The third clause honours the
  // chat "Open exercise" button for already-reviewed items.
  const activeExercise = useStudyStore((s) => s.activeExercise);
  const showWhiteboard =
    kind === "legacy" ||
    (activeExercise !== null && activeExercise.status !== "reviewed") ||
    (activeExercise !== null && activeExercise.id === manualOpenExerciseId);

  // Reset the manual override whenever the session changes so stale ids
  // don't leak into a different study session.
  useEffect(() => {
    setManualOpenExerciseId(null);
  }, [sessionId]);

  useEffect(() => {
    setActiveSession(sessionId ?? null);
    return () => {
      setActiveSession(null);
      resetStream();
      setMessages([]);
      setActiveExercise(null);
      setExerciseHistory([]);
      setSubmissionStatus("idle");
      setSubmissionError(null);
      setLastUnitCompleted(null);
      setLastUnitsInserted(null);
      setLastCalibrationWarning(null);
      setLastExamGraded(null);
    };
  }, [
    sessionId,
    setActiveSession,
    resetStream,
    setMessages,
    setActiveExercise,
    setExerciseHistory,
    setSubmissionStatus,
    setSubmissionError,
    setLastUnitCompleted,
    setLastUnitsInserted,
    setLastCalibrationWarning,
    setLastExamGraded,
  ]);

  // Hydrate messages from the fetched session, but never while a stream is
  // in flight — doing so would wipe the optimistic user bubble or any
  // partial assistant content the reducer is actively building.
  useEffect(() => {
    if (!session) return;
    if (useStudyStore.getState().isStreaming) return;
    setMessages(session.messages);
  }, [session, setMessages]);

  // Attach to the AI kick-off stream the server enqueued when the
  // student opened a fresh unit session. Runs exactly once per mount
  // (guarded by ``kickoffAttachedRef``) so a re-render or a route
  // param churn doesn't re-consume a redis key that was already
  // getdel'd — the stream endpoint would just yield ``Stream not
  // found`` and the UI would look broken for no reason.
  useEffect(() => {
    if (!sessionId) return;
    if (kickoffAttachedRef.current) return;
    const streamId = kickoffStreamIdRef.current;
    if (!streamId) return;
    kickoffAttachedRef.current = true;
    kickoffStreamIdRef.current = null;

    const next = new URLSearchParams(searchParams);
    next.delete("kickoff");
    setSearchParams(next, { replace: true });

    useStudyStore.getState().setStreaming(true);
    useStudyStore.getState().setStreamError(null);
    void attachStream(sessionId, streamId);
  }, [sessionId, attachStream, searchParams, setSearchParams]);

  // Seed the exercise history store once the query resolves. This powers
  // the "Revisit exercise" vs "Open exercise" labels in chat as well as
  // the WhiteboardPanel's history tab (which reads from the store rather
  // than its own fetch so the data survives tab switches).
  useEffect(() => {
    if (exercisesQuery.data) setExerciseHistory(exercisesQuery.data);
  }, [exercisesQuery.data, setExerciseHistory]);

  // Auto-restore an in-progress exercise after a page refresh.
  //
  // On first session load we look at the history and, if the latest
  // exercise hasn't been reviewed yet (status "active" or "submitted"),
  // pull its full detail and promote it to ``activeExercise`` so the
  // whiteboard re-renders exactly where the student left off. We guard
  // this to exactly once per session: without the guard, the effect
  // would fight a live stream that's about to deliver a brand-new
  // exercise, or clobber the user manually opening an older one.
  const [restoreAttempted, setRestoreAttempted] = useState<string | null>(
    null
  );
  useEffect(() => {
    if (!sessionId) return;
    if (restoreAttempted === sessionId) return;
    if (!exercisesQuery.data) return;
    if (useStudyStore.getState().isStreaming) return;
    if (useStudyStore.getState().activeExercise) return;

    // Pick the most recent exercise that isn't fully reviewed. The
    // server already returns history newest-first, but we sort
    // defensively so a future reorder can't silently break this.
    const sorted = [...exercisesQuery.data].sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
    const unfinished = sorted.find((e) => e.status !== "reviewed");
    setRestoreAttempted(sessionId);
    if (!unfinished) return;

    void (async () => {
      try {
        const detail = await studyApi.getExercise(sessionId, unfinished.id);
        // Re-check guards in case state changed while we were fetching.
        if (useStudyStore.getState().isStreaming) return;
        if (useStudyStore.getState().activeExercise) return;
        setActiveExercise(detail);
      } catch (err) {
        // Network blip / deleted exercise — fall back silently; the
        // "Open exercise" chat button still gives the student an
        // escape hatch.
        console.warn("Failed to restore active exercise", err);
      }
    })();
  }, [
    sessionId,
    exercisesQuery.data,
    restoreAttempted,
    setActiveExercise,
  ]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!sessionId || !selectedModel) return;

      const store = useStudyStore.getState();
      const optimisticId = `optimistic-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      const optimisticMsg: StudyMessage = {
        id: optimisticId,
        session_id: sessionId,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      };
      store.setStreamError(null);
      store.setStreaming(true);
      store.appendMessage(optimisticMsg);

      // Consume the one-shot review-focus pointer on the FIRST send.
      // We clear both the ref and the URL param so the deep-link
      // doesn't linger in the address bar or refire on a refresh —
      // the backend is the source of truth from here on.
      const reviewFocus = reviewFocusIdRef.current;
      if (reviewFocus) {
        reviewFocusIdRef.current = null;
        const next = new URLSearchParams(searchParams);
        next.delete("review");
        setSearchParams(next, { replace: true });
      }

      await sendMessage(
        sessionId,
        {
          content: text,
          provider_id: selectedModel.provider_id,
          model_id: selectedModel.model_id,
          review_focus_objective_id: reviewFocus,
        },
        { optimisticUserId: optimisticId }
      );
    },
    [sessionId, selectedModel, sendMessage, searchParams, setSearchParams]
  );

  const handleExerciseSubmit = useCallback(
    async (args: { exerciseId: string; answers: unknown }) => {
      if (!sessionId) return;
      setSubmissionError(null);
      setSubmissionStatus("submitting");
      try {
        const resp = await studyApi.submitExercise(sessionId, {
          exercise_id: args.exerciseId,
          answers: args.answers,
        });
        appendStudyMessage(resp.user_message);
        setSubmissionStatus("awaiting_review");
        await attachStream(sessionId, resp.stream_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSubmissionError(msg);
        setSubmissionStatus("error");
      }
    },
    [
      sessionId,
      setSubmissionStatus,
      setSubmissionError,
      attachStream,
      appendStudyMessage,
    ]
  );

  // Triggered by the "Open exercise" button on an assistant message.
  // Fetches the full exercise detail and makes it the active one so the
  // WhiteboardPanel picks it up; also records the manual override so
  // the split-pane flips to the whiteboard even if the exercise is
  // already reviewed.
  const handleOpenExerciseFromChat = useCallback(
    async (exerciseId: string) => {
      if (!sessionId) return;
      try {
        const detail = await studyApi.getExercise(sessionId, exerciseId);
        setActiveExercise(detail);
        setManualOpenExerciseId(exerciseId);
      } catch (err) {
        console.warn("Failed to open exercise from chat", err);
      }
    },
    [sessionId, setActiveExercise]
  );

  const handleTimeout = useCallback(async () => {
    if (!exam) return;
    setTimeoutPending(true);
    try {
      await studyApi.timeoutExam(exam.id);
    } finally {
      setTimeoutPending(false);
    }
  }, [exam]);

  // Open the exam results modal as soon as we hear a grading event.
  useEffect(() => {
    if (lastExamGraded) setExamResultsOpen(true);
  }, [lastExamGraded]);

  const backTarget = session?.project_id
    ? `/study/topics/${session.project_id}`
    : "/study";

  if (!sessionId) {
    return null;
  }

  const title = unit
    ? unit.title
    : exam
    ? `Final exam · attempt ${exam.attempt_number}`
    : project?.title || "Study session";
  const subtitle = selectedModel
    ? `${selectedModel.display_name} · ${selectedModel.provider_name}`
    : "No model selected";

  return (
    <>
      <TopNav
        title={title}
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(backTarget)}
              aria-label="Back"
              title="Back"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-input border",
                "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
                "hover:bg-black/[0.03] hover:text-[var(--text)] dark:hover:bg-white/[0.04]",
                isMobile
                  ? "h-9 w-9 justify-center"
                  : "px-2.5 py-1.5 text-xs"
              )}
            >
              <ArrowLeft className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
              {!isMobile && "Back"}
            </button>
            <ModelSelector compact={isMobile} />
          </div>
        }
      />
      <div className="flex min-h-0 flex-1">
        <SplitPane
          storageKey="promptly.study.split"
          initialLeftPercent={42}
          minLeftPercent={28}
          maxLeftPercent={70}
          left={
            <div className="flex h-full min-h-0 flex-col border-r border-[var(--border)]">
              {kind === "unit" &&
                unit &&
                unit.order_index === 0 &&
                unit.status !== "completed" &&
                // Prereq units are ALWAYS post-calibration (they exist
                // because a diagnostic/insertion already ran), so the
                // warm-up banner is meaningless on them — hide it even
                // in the edge case where ``calibrated`` didn't flip.
                !unit.inserted_as_prereq &&
                project &&
                !project.calibrated && (
                  <DiagnosticBanner
                    skipping={calibrateMutation.isPending}
                    onSkip={() => {
                      if (!project) return;
                      calibrateMutation.mutate(project.id);
                    }}
                  />
                )}
              {lastUnitCompleted &&
                unit &&
                lastUnitCompleted.id === unit.id &&
                unitToastDismissed !== lastUnitCompleted.id && (
                  <UnitCompletedToast
                    event={lastUnitCompleted}
                    onDismiss={() =>
                      setUnitToastDismissed(lastUnitCompleted.id)
                    }
                    onBackToTopic={() => navigate(backTarget)}
                  />
                )}
              {lastUnitsInserted && lastUnitsInserted.units.length > 0 && (
                <UnitsInsertedToast
                  event={lastUnitsInserted}
                  onDismiss={() => setLastUnitsInserted(null)}
                  onBackToTopic={() => navigate(backTarget)}
                />
              )}
              {lastCalibrationWarning &&
                project &&
                lastCalibrationWarning.project_id === project.id && (
                  <CalibrationWarningToast
                    event={lastCalibrationWarning}
                    onDismiss={() => setLastCalibrationWarning(null)}
                    onReviewPlan={() => {
                      setLastCalibrationWarning(null);
                      navigate(backTarget);
                    }}
                  />
                )}
              <div className="min-h-0 flex-1">
                {sessionLoading ? (
                  <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                    Loading session...
                  </div>
                ) : (
                  <StudyChat
                    onOpenExercise={handleOpenExerciseFromChat}
                    teachbackPassed={Boolean(session?.teachback_passed_at)}
                    confidenceCaptured={Boolean(
                      session?.confidence_captured_at
                    )}
                  />
                )}
              </div>
              {kind === "unit" &&
                session &&
                !session.confidence_captured_at &&
                session.min_turns_required !== null &&
                session.student_turn_count >= session.min_turns_required &&
                // Don't surface the fallback strip while the student is
                // mid-exercise on the right pane — pairing two
                // interactions on screen at once is the "what am I
                // meant to do?" trap. Once they finish the exercise
                // the right pane flips back and this re-shows.
                !showWhiteboard && (
                  <FallbackConfidenceStrip sessionId={session.id} />
                )}
              <div className="px-3 pb-3 pt-1 sm:px-4 sm:pb-4">
                <InputBar
                  streaming={isStreaming}
                  disabled={!selectedModel}
                  onSend={handleSend}
                  onCancel={cancel}
                  allowAttachments={false}
                  autoFocus
                  placeholder={
                    selectedModel
                      ? kind === "exam"
                        ? "Answer the examiner..."
                        : "Ask your tutor..."
                      : "Select a model above to start chatting"
                  }
                  footer={
                    selectedModel
                      ? `Tutor model: ${selectedModel.display_name}`
                      : "No model selected"
                  }
                />
              </div>
            </div>
          }
          right={
            <div className="h-full min-h-0">
              {showWhiteboard && session ? (
                <WhiteboardPanel
                  sessionId={session.id}
                  initialNotes={session.notes_md}
                  onSubmit={handleExerciseSubmit}
                />
              ) : kind === "unit" && unit && project ? (
                <UnitContextPanel
                  unit={unit}
                  projectId={project.id}
                  projectTitle={project.title}
                  totalUnits={project.total_units}
                />
              ) : kind === "exam" && exam && project ? (
                <ExamContextPanel
                  exam={exam}
                  projectTitle={project.title}
                  totalUnits={project.total_units}
                  completedUnits={completedUnits}
                  onTimeout={handleTimeout}
                  timeoutPending={timeoutPending}
                />
              ) : null}
            </div>
          }
        />
      </div>

      <ExamResultsModal
        open={examResultsOpen}
        event={lastExamGraded}
        onClose={() => setExamResultsOpen(false)}
        onBackToTopic={() => {
          setExamResultsOpen(false);
          navigate(backTarget);
        }}
        onArchive={async () => {
          if (!project) return;
          await archiveMutation.mutateAsync(project.id);
          setExamResultsOpen(false);
          navigate("/study");
        }}
        archivePending={archiveMutation.isPending}
      />
    </>
  );
}

/** Minimal "rate your confidence" strip shown above the input bar ONLY
 *  when the unit is otherwise close to completable but the tutor has
 *  forgotten to emit ``<request_confidence/>``. Collapsed by default
 *  (single clickable link) so it doesn't compete with the chat; on
 *  click it expands the full ``ConfidenceWidget`` inline.
 *
 *  This is the fallback path — the primary path is the marker-driven
 *  widget inside ``StudyChat``. Without this fallback a model that
 *  skips the marker would hard-block the completion gate with no
 *  student-visible recovery.
 */
function FallbackConfidenceStrip({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  if (expanded) {
    return (
      <div className="px-3 pb-2 pt-1 sm:px-4">
        <ConfidenceWidget
          sessionId={sessionId}
          onCaptured={() => setDismissed(true)}
        />
      </div>
    );
  }
  return (
    <div className="px-3 pb-2 pt-1 text-[11px] text-[var(--text-muted)] sm:px-4">
      Ready to wrap this unit? Your tutor hasn't asked for a confidence
      rating yet.{" "}
      <button
        type="button"
        className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
        onClick={() => setExpanded(true)}
      >
        Rate it anyway
      </button>
      <span className="mx-1">·</span>
      <button
        type="button"
        className="text-[var(--text-muted)] hover:underline"
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </div>
  );
}
