import { useEffect, useMemo, useRef } from "react";

import { studyApi } from "@/api/study";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ThinkingBubble } from "@/components/chat/ThinkingBubble";
import { ConfidenceWidget } from "@/components/study/ConfidenceWidget";
import { TeachbackBanner } from "@/components/study/TeachbackBanner";
import { useStudyStore } from "@/store/studyStore";
import { cn } from "@/utils/cn";
import { extractStudyMarkers } from "@/utils/studyMarkers";

interface StudyChatProps {
  /** Called when the student clicks the "Open exercise" action on an
   *  assistant message. Given the id of the exercise that was created
   *  on that turn so the parent can flip the right pane and set the
   *  active exercise in the store. */
  onOpenExercise?: (exerciseId: string) => void | Promise<void>;
  /** Whether the tutor has already stamped teach-back on this session
   *  — toggles the teach-back banner's "passed" treatment when the
   *  LAST assistant message requested a teach-back. */
  teachbackPassed?: boolean;
  /** Whether the student has already captured confidence on this
   *  session — hides the inline confidence widget even when the
   *  tutor requested one, to avoid double-asking. */
  confidenceCaptured?: boolean;
}

export function StudyChat({
  onOpenExercise,
  teachbackPassed = false,
  confidenceCaptured = false,
}: StudyChatProps = {}) {
  const allMessages = useStudyStore((s) => s.messages);
  const streamingContent = useStudyStore((s) => s.streamingContent);
  const isStreaming = useStudyStore((s) => s.isStreaming);
  const streamError = useStudyStore((s) => s.streamError);
  const activeSessionId = useStudyStore((s) => s.activeSessionId);
  const activeExercise = useStudyStore((s) => s.activeExercise);
  const exerciseHistory = useStudyStore((s) => s.exerciseHistory);
  const setActiveExercise = useStudyStore((s) => s.setActiveExercise);
  const endRef = useRef<HTMLDivElement | null>(null);

  // ``role === "system"`` rows are internal nudges the backend writes
  // for the LLM (e.g. the mark_complete-rejected reason). They MUST
  // stay in the database so the model sees them on its next turn —
  // but they are NOT for the student. Filter them out of the
  // user-visible transcript here.
  const messages = useMemo(
    () => allMessages.filter((m) => m.role !== "system"),
    [allMessages]
  );

  // While a whiteboard exercise is open and unreviewed, the student's
  // entire attention belongs to that exercise. We suppress inline
  // chat widgets (confidence slider, teach-back banner) during that
  // window — otherwise the student sees a question in chat AND an
  // exercise on the right and has to guess which one to do first
  // (which is exactly the "I jumped ahead" trap the user reported).
  const exerciseInProgress =
    activeExercise !== null && activeExercise.status !== "reviewed";

  // A confidence rating only makes sense AFTER the student has been
  // exposed to actual unit material — rating "how confident am I?"
  // when the AI has just said hello produces a 1-5 number with
  // nothing to anchor against. Hard-floor the widget at "the
  // student has answered at least one warm-up / diagnostic reply",
  // i.e. there are at least 2 user messages on record. The system
  // prompt also tells the model not to ask this early; this is just
  // a belt-and-braces guard against rogue first-turn markers.
  const userMessageCount = useMemo(
    () => messages.filter((m) => m.role === "user").length,
    [messages]
  );
  const confidenceTooEarly = userMessageCount < 2;

  // Quick lookup: exercise id → status (so we can flip the button
  // label between "Open" and "Revisit" without an extra API round-trip).
  const exerciseStatusById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ex of exerciseHistory) map.set(ex.id, ex.status);
    return map;
  }, [exerciseHistory]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamingContent, isStreaming]);

  // Default open-exercise handler used when the parent doesn't supply
  // one. Fetches the full detail and sets it as the active exercise so
  // the WhiteboardPanel picks it up.
  const defaultOpenExercise = async (exerciseId: string) => {
    if (!activeSessionId) return;
    try {
      const detail = await studyApi.getExercise(activeSessionId, exerciseId);
      setActiveExercise(detail);
    } catch (err) {
      console.warn("Failed to open exercise from chat", err);
    }
  };

  const openExercise = onOpenExercise ?? defaultOpenExercise;

  const showStreamingBubble = isStreaming && streamingContent.length > 0;

  // Compute which marker the most-recent assistant message is asking
  // for. We only honour markers on the VERY LAST assistant message —
  // older messages with markers belong to historical turns whose
  // request was already answered (or gracefully ignored). This keeps
  // the chat from growing a stack of stale sliders.
  const lastAssistantMarkers = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const { requestConfidence, requestTeachback } = extractStudyMarkers(
        m.content
      );
      return {
        messageId: m.id,
        requestConfidence,
        requestTeachback,
      };
    }
    return null;
  }, [messages]);

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm text-sm text-[var(--text-muted)]">
          Ready to go. Say hi or tell your tutor what you want to work on
          first — they'll build a plan around it.
        </div>
      </div>
    );
  }

  return (
    <div className="promptly-scroll h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl py-2">
        {messages.map((m) => {
          const exerciseId = m.exercise_id ?? null;
          const exerciseReviewed =
            exerciseId != null &&
            exerciseStatusById.get(exerciseId) === "reviewed";
          // Assistant messages may contain marker tokens
          // (<request_confidence/>, <request_teachback/>) we need to
          // strip before rendering. User messages are passed through
          // unchanged so the student's own words are never touched.
          const rendered =
            m.role === "assistant"
              ? extractStudyMarkers(m.content).stripped
              : m.content;
          const isMarkerAnchor =
            lastAssistantMarkers?.messageId === m.id;
          return (
            <div key={m.id}>
              <MessageBubble
                role={m.role}
                content={rendered}
                onOpenExercise={
                  exerciseId
                    ? () => openExercise(exerciseId)
                    : undefined
                }
                exerciseReviewed={exerciseReviewed}
              />
              {isMarkerAnchor &&
                !exerciseInProgress &&
                lastAssistantMarkers?.requestTeachback && (
                  <div className="mx-3 mb-3 sm:mx-4">
                    <TeachbackBanner passed={teachbackPassed} />
                  </div>
                )}
              {isMarkerAnchor &&
                !exerciseInProgress &&
                !confidenceTooEarly &&
                lastAssistantMarkers?.requestConfidence &&
                !confidenceCaptured &&
                activeSessionId && (
                  <div className="mx-3 mb-3 sm:mx-4">
                    <ConfidenceWidget sessionId={activeSessionId} />
                  </div>
                )}
            </div>
          );
        })}

        {showStreamingBubble && (
          <MessageBubble
            role="assistant"
            content={extractStudyMarkers(streamingContent).stripped}
            streaming
          />
        )}

        {isStreaming && !showStreamingBubble && (
          <ThinkingBubble />
        )}

        {streamError && (
          <div
            role="alert"
            className={cn(
              "mx-4 my-3 rounded-card border px-4 py-3 text-sm",
              "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
            )}
          >
            <div className="font-medium">
              We couldn't reach the tutor.
            </div>
            <div className="mt-1 text-xs opacity-80">
              Check your connection and try sending the message again.
              If this keeps happening, the tutor model may be down —
              switch models from the picker above.
            </div>
            <div className="mt-2 text-[11px] uppercase tracking-wide opacity-60">
              Details: {streamError}
            </div>
          </div>
        )}

        <div ref={endRef} className="h-6" />
      </div>
    </div>
  );
}
