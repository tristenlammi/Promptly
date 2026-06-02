import { Link } from "react-router-dom";
import { BookOpen, MessagesSquare } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";

interface StudyDesktopOnlyProps {
  children: React.ReactNode;
}

/**
 * Gates individual Study routes (currently just the live session page)
 * that require the split chat + whiteboard layout. On phone-sized
 * viewports (<768px / below Tailwind ``md``) those pages are unusable —
 * the user sees a friendly redirect screen instead.
 *
 * Study home, topic detail, and the daily review loop are NOT wrapped
 * in this component — they are fully mobile-friendly.
 */
export function StudyDesktopOnly({ children }: StudyDesktopOnlyProps) {
  const isMobile = useIsMobile();
  if (!isMobile) return <>{children}</>;

  return (
    <div className="flex h-full flex-1 items-center justify-center px-6 py-10">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent)]/10 text-[var(--accent)]">
          <BookOpen className="h-7 w-7" />
        </div>
        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-[var(--text)]">
            Live classroom needs more room
          </h1>
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            The live session uses a side-by-side chat and lesson board with
            interactive exercises — it needs a tablet or larger screen to work
            well. Your daily review and topic overview are still accessible on
            this device.
          </p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Link
            to="/study"
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
          >
            <BookOpen className="h-4 w-4" />
            Go to Study home
          </Link>
          <Link
            to="/chat"
            className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <MessagesSquare className="h-4 w-4" />
            Back to Chat
          </Link>
        </div>
      </div>
    </div>
  );
}
