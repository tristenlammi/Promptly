import { cn } from "@/utils/cn";

/**
 * Three dots that "bounce" in sequence — reads as a conversational typing
 * indicator, similar to Claude / iMessage. Uses a custom keyframe (declared
 * in ``frontend/src/index.css``) with staggered delays so the wave is
 * clearly sequential rather than in-phase.
 */
export function LoadingDots({ className }: { className?: string }) {
  return (
    <div
      className={cn("inline-flex items-center gap-1", className)}
      role="status"
      aria-label="Assistant is thinking"
    >
      <span className="promptly-thinking-dot h-1.5 w-1.5 rounded-full bg-current [animation-delay:0ms]" />
      <span className="promptly-thinking-dot h-1.5 w-1.5 rounded-full bg-current [animation-delay:150ms]" />
      <span className="promptly-thinking-dot h-1.5 w-1.5 rounded-full bg-current [animation-delay:300ms]" />
    </div>
  );
}
