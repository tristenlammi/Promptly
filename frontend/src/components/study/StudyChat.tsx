import { useEffect, useRef } from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import { ThinkingBubble } from "@/components/chat/ThinkingBubble";
import { useStudyStore } from "@/store/studyStore";
import { cn } from "@/utils/cn";

export function StudyChat() {
  const messages = useStudyStore((s) => s.messages);
  const streamingContent = useStudyStore((s) => s.streamingContent);
  const isStreaming = useStudyStore((s) => s.isStreaming);
  const streamError = useStudyStore((s) => s.streamError);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamingContent, isStreaming]);

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
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            role={m.role}
            content={m.content}
          />
        ))}

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
