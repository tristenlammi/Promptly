import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bell, CalendarClock, Check, GraduationCap, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { studyApi, studyError, type StudyStats, type Subject } from "@/api/study";
import { formatRelativeTime } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Sheet } from "@/components/shared/Sheet";
import { Skeleton } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { Ring } from "../ui/bits";
import { statsWords } from "../ui/words";
import "../study.css";

/* Study home: your subjects, how far along each is, and "New subject". */

export function HomePage() {
  const q = useQuery({
    queryKey: ["study", "home"],
    queryFn: studyApi.home,
    staleTime: 5_000,
    // A course being built finishes while you look at the list.
    refetchInterval: (query) => (query.state.data?.subjects.some((s) => s.status === "building") ? 3000 : false),
  });
  const [showAway, setShowAway] = useState(false);
  const [remind, setRemind] = useState(false);
  const all = q.data?.subjects ?? [];
  const due = q.data?.due_total ?? 0;
  const live = all.filter((s) => !s.archived);
  const away = all.filter((s) => s.archived);

  return (
    <div className="study flex min-h-0 flex-1 flex-col">
      <TopNav
        title="Study"
        actions={
          all.length > 0 ? (
            <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setRemind(true)}
              aria-label="Daily reminder"
              title="Daily reminder"
              className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
            >
              <Bell className="h-5 w-5" aria-hidden />
            </button>
            <Link
              to="/study/new"
              className="inline-flex h-10 items-center gap-1.5 rounded-input bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New subject
            </Link>
            </span>
          ) : undefined
        }
      />
      <RemindSheet open={remind} onClose={() => setRemind(false)} />
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
              {due > 0 && (
                <Link
                  to="/study/review"
                  data-testid="study-review-banner"
                  className="study-in group flex items-center gap-3 rounded-3xl border border-[var(--st-accent)] bg-[var(--st-soft)] p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
                >
                  <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white">
                    <CalendarClock className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-[var(--text)]">{due === 1 ? "1 idea to review" : `${due} ideas to review`}</span>
                    <span className="block text-sm text-[var(--text-muted)]">A few quick questions, so what you've learned stays learned.</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[var(--accent-strong)] px-4 py-2 text-sm font-medium text-white">Review</span>
                </Link>
              )}
              {q.data && <StatsLine stats={q.data.stats} />}
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
  if (s.next_capstone) return s.next_capstone.scope === "final" ? "Next: the final task" : `Next: a task on ${s.next_capstone.title}`;
  return "Open to carry on";
}

function StatsLine({ stats }: { stats: StudyStats }) {
  const words = statsWords(stats);
  if (!words) return null;
  return (
    <p className="px-1 text-sm text-[var(--text-muted)]" data-testid="study-stats">
      {words}
    </p>
  );
}

/** The optional daily nudge: on or off, and when. */
function RemindSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ["study", "prefs"], queryFn: studyApi.prefs, staleTime: 60_000, enabled: open });
  const [on, setOn] = useState(false);
  const [time, setTime] = useState("17:00");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && prefs.data) {
      setOn(prefs.data.remind.on);
      setTime(prefs.data.remind.time);
    }
  }, [open, prefs.data]);
  const save = async () => {
    setBusy(true);
    try {
      await studyApi.setRemind({ on, time });
      await qc.invalidateQueries({ queryKey: ["study", "prefs"] });
      toast.success(on ? `You'll get a nudge at ${time}` : "Reminder off");
      onClose();
    } catch (e) {
      toast.error(studyError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Daily reminder"
      footer={
        <Button variant="primary" size="lg" className="w-full" onClick={() => void save()} loading={busy} disabled={!prefs.data}>
          Save
        </Button>
      }
    >
      <div className="study flex flex-col gap-4" data-testid="study-remind">
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span>
            <span className="block text-[15px] font-medium text-[var(--text)]">Remind me to study</span>
            <span className="block text-sm text-[var(--text-muted)]">One notification a day at most, and only when there's something to do: ideas to review, or a subject you're part-way through. Nothing on days you've already studied.</span>
          </span>
        </label>
        <label className={cn("flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5", !on && "opacity-60")}>
          <span className="text-[15px] font-medium text-[var(--text)]">At</span>
          <input
            type="time"
            value={time}
            disabled={!on}
            onChange={(e) => e.target.value && setTime(e.target.value.slice(0, 5))}
            className="h-10 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-[16px] text-[var(--text)] focus:border-[var(--st-accent)] focus:outline-none"
          />
        </label>
        <p className="text-xs text-[var(--text-muted)]">It arrives as a reminder, so the Reminders switch in Account → Notifications, and each device's own switch, apply to it.</p>
      </div>
    </Sheet>
  );
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
            {s.due_count > 0 && <span className="font-semibold text-[var(--st-accent-text)]"> · {s.due_count} to review</span>}
          </span>
        )}
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}
