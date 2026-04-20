import { useEffect, useMemo, useRef } from "react";

import { studyApi } from "@/api/study";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ThinkingBubble } from "@/components/chat/ThinkingBubble";
import { useStudyStore } from "@/store/studyStore";
import { cn } from "@/utils/cn";

interface StudyChatProps {
  /** Called when the student clicks the "Open exercise" action on an
   *  assistant message. Given the id of the exercise that was created
   *  on that turn so the parent can flip the right pane and set the
   *  active exercise in the store. */
  onOpenExercise?: (exerciseId: string) => void | Promise<void>;
}

export function StudyChat({ onOpenExercise }: StudyChatProps = {}) {
  const messages = useStudyStore((s) => s.messages);
  const streamingContent = useStudyStore((s) => s.streamingContent);
  const isStreaming = useStudyStore((s) => s.isStreaming);
  const streamError = useStudyStore((s) => s.streamError);
  const activeSessionId = useStudyStore((s) => s.activeSessionId);
  const exerciseHistory = useStudyStore((s) => s.exerciseHistory);
  const setActiveExercise = useStudyStore((s) => s.setActiveExercise);
  const endRef = useRef<HTMLDivElement | null>(null);

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
          return (
            <MessageBubble
              key={m.id}
              role={m.role}
              content={m.content}
              onOpenExercise={
                exerciseId
                  ? () => openExercise(exerciseId)
                  : undefined
              }
              exerciseReviewed={exerciseReviewed}
            />
          );
        })}

        {showStreamingBubble && (
          <MessageBubble
            role="assistant"
            content={streamingContent}
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
            {streamError}
          </div>
        )}

        <div ref={endRef} className="h-6" />
      </div>
    </div>
  );
}
