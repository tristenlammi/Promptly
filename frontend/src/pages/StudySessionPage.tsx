import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { InputBar } from "@/components/chat/InputBar";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { TopNav } from "@/components/layout/TopNav";
import { SplitPane } from "@/components/study/SplitPane";
import { StudyChat } from "@/components/study/StudyChat";
import { WhiteboardPanel } from "@/components/study/Whiteboard/WhiteboardPanel";
import { studyApi } from "@/api/study";
import { useStudyProjectQuery, useStudySessionQuery } from "@/hooks/useStudy";
import { useStudyStream } from "@/hooks/useStudyStream";
import { useStudyStore } from "@/store/studyStore";
import { useSelectedModel } from "@/store/modelStore";
import { cn } from "@/utils/cn";
import type { StudyMessage } from "@/api/types";

export function StudySessionPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const setActiveSession = useStudyStore((s) => s.setActiveSession);
  const setMessages = useStudyStore((s) => s.setMessages);
  const resetStream = useStudyStore((s) => s.resetStream);
  const isStreaming = useStudyStore((s) => s.isStreaming);
  const setActiveExercise = useStudyStore((s) => s.setActiveExercise);
  const setExerciseHistory = useStudyStore((s) => s.setExerciseHistory);

  const { sendMessage, attachStream, cancel } = useStudyStream();
  const setSubmissionStatus = useStudyStore((s) => s.setSubmissionStatus);
  const setSubmissionError = useStudyStore((s) => s.setSubmissionError);
  const appendStudyMessage = useStudyStore((s) => s.appendMessage);
  const selectedModel = useSelectedModel();

  const { data: session, isLoading: sessionLoading } = useStudySessionQuery(
    sessionId ?? null
  );
  const { data: project } = useStudyProjectQuery(
    session?.project_id ?? null
  );

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
  ]);

  // Hydrate messages from the fetched session, but never while a stream is
  // in flight — doing so would wipe the optimistic user bubble or any
  // partial assistant content the reducer is actively building.
  useEffect(() => {
    if (!session) return;
    if (useStudyStore.getState().isStreaming) return;
    setMessages(session.messages);
  }, [session, setMessages]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!sessionId || !selectedModel) return;

      // Optimistic bubble + thinking indicator, instantly, so the UI never
      // looks frozen while the send POST is in flight.
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

      await sendMessage(
        sessionId,
        {
          content: text,
          provider_id: selectedModel.provider_id,
          model_id: selectedModel.model_id,
        },
        { optimisticUserId: optimisticId }
      );
    },
    [sessionId, selectedModel, sendMessage]
  );

  const handleExerciseSubmit = useCallback(
    async (args: {
      exerciseId: string;
      answers: unknown;
      snapshotPngBase64: string | null;
    }) => {
      if (!sessionId) return;
      setSubmissionError(null);
      setSubmissionStatus("submitting");
      try {
        const resp = await studyApi.submitExercise(sessionId, {
          exercise_id: args.exerciseId,
          answers: args.answers,
          excalidraw_snapshot_b64: args.snapshotPngBase64,
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

  if (!sessionId) {
    return null;
  }

  const title = project?.title || "Study session";
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
              onClick={() => navigate("/study")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-input border px-2.5 py-1.5 text-xs",
                "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
                "hover:bg-black/[0.03] hover:text-[var(--text)] dark:hover:bg-white/[0.04]"
              )}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Study
            </button>
            <ModelSelector />
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
              <div className="min-h-0 flex-1">
                {sessionLoading ? (
                  <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                    Loading session...
                  </div>
                ) : (
                  <StudyChat />
                )}
              </div>
              <InputBar
                streaming={isStreaming}
                disabled={!selectedModel}
                onSend={handleSend}
                onCancel={cancel}
                allowAttachments={false}
                placeholder={
                  selectedModel
                    ? "Ask your tutor..."
                    : "Select a model above to start chatting"
                }
                footer={
                  selectedModel
                    ? `Tutor model: ${selectedModel.display_name}`
                    : "No model selected"
                }
              />
            </div>
          }
          right={
            <div className="h-full min-h-0">
              {session && (
                <WhiteboardPanel
                  sessionId={session.id}
                  initialSnapshot={session.excalidraw_snapshot}
                  onSubmit={handleExerciseSubmit}
                />
              )}
            </div>
          }
        />
      </div>
    </>
  );
}
