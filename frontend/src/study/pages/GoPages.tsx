import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { studyApi, studyError } from "@/api/study";
import { TopNav } from "@/components/layout/TopNav";

import { Thinking } from "../ui/bits";
import "../study.css";

/*
 * Two addresses that only exist to be opened from a notification, the
 * Today card or a button: they start (or pick up) the sitting and hand over
 * to the lesson player.
 *
 *   /study/review                 what is due, across every subject
 *   /study/:subjectId/review      what is due in one subject
 *   /study/:subjectId/continue    the next lesson in one subject
 */

function Starting({ title, go, back }: { title: string; go: () => Promise<string>; back: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    go()
      .then((to) => navigate(to, { replace: true }))
      .catch((e) => setError(studyError(e).message));
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="study flex min-h-0 flex-1 flex-col">
      <TopNav title={title} />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {error ? (
          <>
            <p role="alert" className="max-w-sm text-[15px] text-[var(--text)]" data-testid="study-go-error">
              {error}
            </p>
            <Link to={back} className="inline-flex h-10 items-center rounded-input bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              Back to Study
            </Link>
          </>
        ) : (
          <Thinking label="Getting it ready" />
        )}
      </div>
    </div>
  );
}

/** ``/study/review`` and ``/study/:subjectId/review``. */
export function ReviewStartPage() {
  const { subjectId } = useParams();
  return (
    <Starting
      title="Review"
      back={subjectId ? `/study/${subjectId}` : "/study"}
      go={async () => {
        const se = await studyApi.startReview(subjectId);
        return subjectId ? `/study/${subjectId}/learn/${se.id}` : `/study/review/${se.id}`;
      }}
    />
  );
}

/** ``/study/:subjectId/continue``. */
export function ContinuePage() {
  const { subjectId = "" } = useParams();
  return (
    <Starting
      title="Study"
      back={`/study/${subjectId}`}
      go={async () => {
        const se = await studyApi.startSession(subjectId, {});
        return `/study/${subjectId}/learn/${se.id}`;
      }}
    />
  );
}
