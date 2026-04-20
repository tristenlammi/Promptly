import { Link } from "react-router-dom";
import { BookOpen, MessagesSquare } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";

interface StudyDesktopOnlyProps {
  children: React.ReactNode;
}

/**
 * Gates the Study routes so that on phone-sized viewports (<768px, i.e.
 * below Tailwind's ``md`` breakpoint) the user sees a friendly
 * "use a tablet or desktop" screen instead of the cramped study UI.
 *
 * Tablets in portrait (iPad at 768px) and everything wider still get
 * the full experience — the split chat / whiteboard panel and the
 * interactive exercises need the horizontal room.
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
            Study works best on a larger screen
          </h1>
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            The Study section uses a split chat and whiteboard layout with
            interactive exercises, so it's only available on tablets and
            larger. Flip your device to landscape, grab a tablet, or jump
            back onto your laptop to keep learning.
          </p>
        </div>
        <Link
          to="/chat"
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
        >
          <MessagesSquare className="h-4 w-4" />
          Back to Chat
        </Link>
      </div>
    </div>
  );
}
