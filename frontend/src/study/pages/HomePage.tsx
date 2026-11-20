import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, GraduationCap, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { studyApi, studyError, type Subject } from "@/api/study";
import { formatRelativeTime } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Skeleton } from "@/components/shared/Skeleton";
import { cn } from "@/utils/cn";

import { Ring } from "../ui/bits";
import "../study.css";

/* Study home: your subjects, how far along each is, and "New subject". */

export function HomePage() {
  const q = useQuery({
    queryKey: ["study", "subjects"],
    queryFn: studyApi.subjects,
    staleTime: 5_000,
    // A course being built finishes while you look at the list.
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "building") ? 3000 : false),
  });
  const [showAway, setShowAway] = useState(false);
  const all = q.data ?? [];
  const live = all.filter((s) => !s.archived);
  const away = all.filter((s) => s.archived);

  return (
    <div className="study flex min-h-0 flex-1 flex-col">
      <TopNav
        title="Study"
        actions={
          all.length > 0 ? (
            <Link
              to="/study/new"
              className="inline-flex h-10 items-center gap-1.5 rounded-input bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New subject
            </Link>
          ) : undefined
        }
      />
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 pb-24 sm:px-6">
          {q.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-busy aria-label="Loading your subjects">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-32 w-full rounded-3xl" />
              ))}
            </div>
          ) : q.isError ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p role="alert" className="text-[15px] text-[var(--text)]">
                {studyError(q.error).message}
              </p>
              <Button variant="primary" onClick={() => void q.refetch()} leftIcon={<RotateCcw className="h-4 w-4" />}>
                Try again
              </Button>
            </div>
          ) : all.length === 0 ? (
            <Welcome />
          ) : (
            <>
              {live.length === 0 && <p className="py-6 text-center text-[15px] text-[var(--text-muted)]">Everything is put away. Start something new, or bring one back.</p>}
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="study-subjects">
                {live.map((s) => (
                  <li key={s.id}>
                    <SubjectCard s={s} />
                  </li>
                ))}
              </ul>
              {away.length > 0 && (
                <section>
                  <button type="button" onClick={() => setShowAway((v) => !v)} aria-expanded={showAway} className="rounded-md px-1 py-1 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
                    Put away ({away.length})
                  </button>
                  {showAway && (
                    <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                      {away.map((s) => (
                        <li key={s.id}>
                          <SubjectCard s={s} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="study-in mx-auto flex max-w-md flex-col items-center px-2 py-10 text-center" data-testid="study-welcome">
      <span className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--st-soft)] text-[var(--st-accent-text)]" aria-hidden>
        <GraduationCap className="h-10 w-10" />
      </span>
      <h2 className="text-2xl font-semibold text-[var(--text)]">Learn anything, properly</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-muted)]">
        Pick a subject. Your teacher plans the course, finds out what you already know, and changes it as you go: quicker where you're strong, more help where you're not.
      </p>
      <ul className="mt-5 flex flex-col gap-2 text-left text-[15px] text-[var(--text)]">
        {["Short lessons that mix explaining, predicting, fixing mistakes and teaching it back", "It notices what you've mixed up and sorts that out first", "Ask the teacher anything, any time"].map((t) => (
          <li key={t} className="flex gap-2.5">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--st-accent-text)]" aria-hidden />
            {t}
          </li>
        ))}
      </ul>
      <Link
        to="/study/new"
        className="mt-7 inline-flex h-12 items-center gap-2 rounded-full bg-[var(--accent-strong)] px-6 text-base font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
      >
        Start your first subject
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

function statusLine(s: Subject): string {
  if (s.status === "building") return "Building your course…";
  if (s.status === "failed") return "Couldn't be built. Open to try again";
  if (s.status === "placement") return "Ready. Open to start";
  if (s.status === "complete") return "All learned";
  if (s.next_concept) return `Next: ${s.next_concept.title}`;
  return "Open to carry on";
}

function SubjectCard({ s }: { s: Subject }) {
  const done = s.status === "complete";
  const building = s.status === "building";
  const value = building ? s.build.progress / 100 : s.progress.percent / 100;
  return (
    <Link
      to={`/study/${s.id}`}
      className={cn(
        "group flex h-full items-center gap-4 rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--st-accent)] hover:shadow-[var(--shadow-md)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
        s.archived && "opacity-70"
      )}
      data-testid="study-subject-card"
      data-status={s.status}
    >
      <Ring value={value} size={64} stroke={6} color={done ? "var(--st-good)" : s.status === "failed" ? "var(--st-bad)" : "var(--st-accent)"}>
        {done ? (
          <Check className="h-6 w-6 text-[var(--st-good)]" aria-hidden />
        ) : building ? (
          <span className="study-dots text-[var(--st-accent-text)]" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        ) : (
          <span className="text-sm font-bold tabular-nums text-[var(--text)]">{s.progress.percent}%</span>
        )}
      </Ring>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-base font-semibold leading-snug text-[var(--text)]">{s.title}</span>
        <span className={cn("mt-0.5 block truncate text-sm", s.status === "failed" ? "text-[var(--st-bad)]" : "text-[var(--text-muted)]")}>{statusLine(s)}</span>
        {(s.status === "active" || s.status === "complete") && (
          <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
            {s.progress.done} of {s.progress.total} ideas{s.last_studied_at ? ` · ${formatRelativeTime(s.last_studied_at)}` : ""}
          </span>
        )}
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}
