import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, ArrowRight, BookOpen, CalendarClock, Check, ClipboardCheck, FastForward, FileText, Globe, Lock, PartyPopper, Play, Plus, RotateCcw, ScrollText, Settings2, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { studyApi, studyError, type BuildStage, type Concept, type Level, type Source, type SubjectFull } from "@/api/study";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Sheet } from "@/components/shared/Sheet";
import { Skeleton } from "@/components/shared/Skeleton";
import { safeHref } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { CourseMap } from "../map/CourseMap";
import { BAND_WORDS, bandOf, isDone } from "../map/layout";
import { Bar, LEVEL_WORDS, Thinking } from "../ui/bits";
import { reviewWhen } from "../ui/words";
import "../study.css";

/* One subject: being built, the placement offer, then the map. */

export function SubjectPage() {
  const { subjectId = "" } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["study", "subject", subjectId], queryFn: () => studyApi.subject(subjectId), staleTime: 5_000 });
  const s = q.data;
  const reload = () => qc.invalidateQueries({ queryKey: ["study"] });

  return (
    <div className="study flex min-h-0 flex-1 flex-col">
      <TopNav
        title={
          <span className="flex min-w-0 items-center gap-1">
            <Link to="/study" aria-label="All subjects" className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <span className="truncate text-base font-semibold text-[var(--text)]">{s?.title ?? "Study"}</span>
          </span>
        }
      />
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-3xl" />
          </div>
        ) : q.isError || !s ? (
          <Missing message={studyError(q.error).status === 404 ? "This subject isn't here any more." : studyError(q.error).message} onRetry={() => void q.refetch()} />
        ) : s.status === "building" ? (
          <Building subject={s} onDone={reload} />
        ) : s.status === "failed" ? (
          <Failed subject={s} onChange={reload} />
        ) : s.status === "placement" ? (
          <PlacementOffer subject={s} onChange={reload} />
        ) : (
          <Course subject={s} onChange={reload} />
        )}
      </div>
    </div>
  );
}

function Missing({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <p role="alert" className="max-w-sm text-[15px] text-[var(--text)]">
        {message}
      </p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={onRetry} leftIcon={<RotateCcw className="h-4 w-4" />}>
          Try again
        </Button>
        <Link to="/study" className="inline-flex h-10 items-center rounded-input border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
          All subjects
        </Link>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- building

const STAGES: { key: BuildStage; label: string; doing: string }[] = [
  { key: "sources", label: "Reading up", doing: "Reading up on it, so what you're taught is right" },
  { key: "plan", label: "Planning your course", doing: "Working out the ideas, and which ones build on which" },
  { key: "saving", label: "Laying out the map", doing: "Laying out your map" },
];
const ORDER: BuildStage[] = ["queued", "sources", "plan", "saving", "done"];

export function Building({ subject, onDone }: { subject: SubjectFull; onDone: () => void }) {
  const [stalled, setStalled] = useState(false);
  const poll = useQuery({
    queryKey: ["study", "build", subject.id],
    queryFn: () => studyApi.build(subject.id),
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "building" ? false : 1500),
    refetchIntervalInBackground: false,
  });
  const b = poll.data ?? { status: "building" as const, ...subject.build };
  useEffect(() => {
    if (poll.data && poll.data.status !== "building") onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data?.status]);
  // A build that sits on one number for a long time has probably lost its server.
  useEffect(() => {
    setStalled(false);
    const t = window.setTimeout(() => setStalled(true), 4 * 60_000);
    return () => window.clearTimeout(t);
  }, [b.progress, b.stage]);

  const at = Math.max(0, ORDER.indexOf(b.stage));
  const doing = STAGES.find((x) => x.key === b.stage)?.doing ?? "Getting started";
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-12 text-center" data-testid="study-building">
      <span className="relative mb-6 flex h-20 w-20 items-center justify-center" aria-hidden>
        <span className="study-halo absolute inset-2 rounded-full" />
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--st-soft)] text-[var(--st-accent-text)]">
          <BookOpen className="h-9 w-9" />
        </span>
      </span>
      <h2 className="text-xl font-semibold text-[var(--text)]">Building your course</h2>
      <p className="mt-1 text-[15px] text-[var(--text-muted)]" aria-live="polite">
        {doing}…
      </p>
      <Bar value={b.progress / 100} className="mt-6" label="Building your course" />
      <ol className="mt-6 flex w-full flex-col gap-2 text-left">
        {STAGES.map((st) => {
          const i = ORDER.indexOf(st.key);
          const state = i < at ? "done" : i === at ? "now" : "todo";
          return (
            <li key={st.key} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px]", state === "now" ? "bg-[var(--st-soft)] text-[var(--text)]" : state === "done" ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", state === "done" ? "bg-[var(--st-good)] text-white" : state === "now" ? "text-[var(--st-accent-text)]" : "border border-[var(--st-line)]")}>
                {state === "done" ? <Check className="h-3.5 w-3.5" aria-hidden /> : state === "now" ? <span className="study-dots" aria-hidden><span /><span /><span /></span> : null}
              </span>
              <span className="flex-1">{st.label}</span>
              <span className="sr-only">{state === "done" ? "done" : state === "now" ? "happening now" : "to do"}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-6 text-sm text-[var(--text-muted)]">This usually takes under two minutes. You can leave and come back: it carries on.</p>
      {poll.isError && <p className="mt-3 text-sm text-[var(--st-bad)]">Can't check on it just now. Still trying…</p>}
      {stalled && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <p className="text-sm text-[var(--text-muted)]">This is taking longer than it should.</p>
          <RetryButton id={subject.id} onDone={onDone} label="Start it again" />
        </div>
      )}
    </div>
  );
}

function RetryButton({ id, onDone, label = "Try again" }: { id: string; onDone: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      loading={busy}
      leftIcon={<RotateCcw className="h-4 w-4" />}
      onClick={async () => {
        setBusy(true);
        try {
          await studyApi.retry(id);
          onDone();
        } catch (e) {
          toast.error(studyError(e).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

function Failed({ subject, onChange }: { subject: SubjectFull; onChange: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-14 text-center" data-testid="study-failed">
      <h2 className="text-xl font-semibold text-[var(--text)]">The course couldn't be built</h2>
      <p role="alert" className="mt-2 text-[15px] text-[var(--text-muted)]">
        {subject.build.error || "Something went wrong while it was being put together."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <RetryButton id={subject.id} onDone={onChange} />
        <Button
          leftIcon={<Trash2 className="h-4 w-4" />}
          onClick={async () => {
            if (!(await confirm({ title: "Delete this subject?", message: "It goes to the trash, where it stays for 30 days.", confirmLabel: "Delete", danger: true }))) return;
            try {
              await studyApi.remove(subject.id);
              onChange();
              navigate("/study", { replace: true });
            } catch (e) {
              toast.error(studyError(e).message);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- placement

function PlacementOffer({ subject, onChange }: { subject: SubjectFull; onChange: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"check" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = subject.units.reduce((n, u) => n + u.concepts.length, 0);

  const start = async () => {
    setBusy("check");
    setError(null);
    try {
      const out = await studyApi.startPlacement(subject.id);
      navigate(`/study/${subject.id}/learn/${out.session.id}`);
    } catch (e) {
      setError(studyError(e).message);
      setBusy(null);
    }
  };
  const skip = async () => {
    setBusy("skip");
    setError(null);
    try {
      await studyApi.skipPlacement(subject.id);
      onChange();
    } catch (e) {
      setError(studyError(e).message);
      setBusy(null);
    }
  };

  return (
    <div className="study-in mx-auto flex w-full max-w-lg flex-col px-5 py-8" data-testid="study-placement-offer">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--st-accent-text)]">Your course is ready</p>
      <h2 className="mt-1 text-2xl font-semibold leading-tight text-[var(--text)]">{subject.title}</h2>
      {subject.summary && <p className="mt-2 text-[15px] leading-relaxed text-[var(--text)]">{subject.summary}</p>}
      <p className="mt-3 text-sm text-[var(--text-muted)]">
        {total} ideas in {subject.units.length} parts{subject.sources.length > 0 ? `, drawn from ${subject.sources.length} ${subject.sources.length === 1 ? "source" : "sources"}` : ""}.
      </p>
      <ol className="mt-4 flex flex-col gap-1.5">
        {[...subject.units]
          .sort((a, b) => a.position - b.position)
          .map((u, i) => (
            <li key={u.id} className="flex items-baseline gap-2.5 text-[15px] text-[var(--text)]">
              <span aria-hidden className="w-5 shrink-0 text-right text-xs font-bold text-[var(--st-accent-text)]">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">{u.title}</span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">{u.concepts.length} ideas</span>
            </li>
          ))}
      </ol>

      <div className="mt-7 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-base font-semibold text-[var(--text)]">Where should we start?</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">A few quick questions show what you already know, so you don't sit through it again.</p>
        {busy === "check" && <Thinking label="Writing your questions" className="mt-3" />}
        {error && (
          <p role="alert" className="mt-3 text-sm text-[var(--st-bad)]">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="primary" size="lg" onClick={() => void start()} loading={busy === "check"} disabled={busy !== null} rightIcon={<ArrowRight className="h-4 w-4" />}>
            Quick check (2 minutes)
          </Button>
          <Button size="lg" onClick={() => void skip()} loading={busy === "skip"} disabled={busy !== null}>
            I'm new to this. Start at the beginning
          </Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ course

function Course({ subject, onChange }: { subject: SubjectFull; onChange: () => void }) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<Concept | null>(null);
  const [settings, setSettings] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const complete = subject.status === "complete";
  const concepts = useMemo(() => subject.units.flatMap((u) => u.concepts), [subject.units]);
  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  const nextId = subject.next_concept?.id ?? null;
  const gaps = concepts.filter((c) => c.origin === "gap");
  const open = subject.misconceptions.filter((m) => !m.resolved);
  // Keep the open sheet showing the newest version of its concept.
  const pickedNow = picked ? (byId.get(picked.id) ?? picked) : null;

  const start = async (key: string, body: { concept_id?: string; test_out?: boolean }) => {
    if (starting) return;
    setStarting(key);
    try {
      const se = await studyApi.startSession(subject.id, body);
      navigate(`/study/${subject.id}/learn/${se.id}`);
    } catch (e) {
      toast.error(studyError(e).message);
      setStarting(null);
    }
  };

  // Bring the next stop into view when the map opens.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="study-stop"][data-next]');
    if (el && subject.progress.done > 0) el.scrollIntoView?.({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.id]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-3 pb-2 pt-4 sm:px-4">
      <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Your progress">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {subject.summary && <p className="text-sm leading-relaxed text-[var(--text-muted)]">{subject.summary}</p>}
          </div>
          <button type="button" onClick={() => setSettings(true)} aria-label="Subject settings" className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
            <Settings2 className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Bar value={subject.progress.percent / 100} color={complete ? "var(--st-good)" : "var(--st-accent)"} label="Ideas learned" />
          <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text)]">{subject.progress.percent}%</span>
        </div>
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          {subject.progress.done} of {subject.progress.total} ideas learned
          {subject.progress.learning > 0 ? ` · ${subject.progress.learning} under way` : ""}
          {gaps.length > 0 ? ` · ${gaps.length} added for you` : ""}
        </p>
        {complete && (
          <p className="mt-3 flex items-center gap-2 rounded-xl bg-[var(--st-good-bg)] px-3 py-2 text-sm font-medium text-[var(--text)]">
            <PartyPopper className="h-4 w-4 text-[var(--st-good)]" aria-hidden />
            You've finished this subject: every idea, and the tasks that put them together.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {subject.due_count > 0 && (
            <Link
              to={`/study/${subject.id}/review`}
              data-testid="study-review-subject"
              className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
            >
              <CalendarClock className="h-4 w-4" aria-hidden />
              Review {subject.due_count} {subject.due_count === 1 ? "idea" : "ideas"}
            </Link>
          )}
          <Link
            to={`/study/${subject.id}/report`}
            data-testid="study-report-link"
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] hover:border-[var(--st-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
          >
            <ScrollText className="h-4 w-4" aria-hidden />
            {complete ? "Your report" : "How you're doing"}
          </Link>
        </div>
      </section>

      {open.length > 0 && (
        <section className="rounded-2xl border border-[var(--st-gap-border)] bg-[var(--st-gap-bg)] p-3.5" aria-label="Mix-ups the teacher is working on">
          <h2 className="text-sm font-semibold text-[var(--text)]">Mix-ups we're sorting out</h2>
          <ul className="mt-1.5 flex flex-col gap-1">
            {open.slice(0, 4).map((m) => (
              <li key={m.id} className="text-sm text-[var(--text)]">
                <span className="font-medium">{m.label}</span>
                {byId.get(m.concept_id) && <span className="text-[var(--text-muted)]"> · in {byId.get(m.concept_id)?.title}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <CourseMap subject={subject} nextId={complete ? null : nextId} onPick={setPicked} />

      <Legend />

      {subject.sources.length > 0 && (
        <details className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--text)] focus:outline-none focus-visible:underline">
            What this course is built from ({subject.sources.length})
          </summary>
          <SourceList sources={subject.sources} className="mt-3" />
        </details>
      )}

      {/* The one big button. */}
      {!complete && (
        <div className="pointer-events-none sticky bottom-0 z-20 flex min-w-0 justify-center px-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
          <Button
            variant="primary"
            size="lg"
            className="pointer-events-auto h-14 min-w-0 max-w-md flex-1 rounded-full px-6 text-base shadow-lg"
            onClick={() => void start("go", {})}
            loading={starting === "go"}
            disabled={starting !== null}
            leftIcon={<Play className="h-5 w-5" />}
            data-testid="study-continue-course"
          >
            <span className="min-w-0 truncate">
              {subject.active_session ? "Carry on with your lesson" : subject.progress.done + subject.progress.learning > 0 ? "Continue" : "Start learning"}
              {subject.active_session
                ? ""
                : subject.next_concept
                  ? `: ${subject.next_concept.title}`
                  : subject.next_capstone
                    ? subject.next_capstone.scope === "final"
                      ? ": the final task"
                      : `: a task on ${subject.next_capstone.title}`
                    : ""}
            </span>
          </Button>
        </div>
      )}

      <ConceptSheet
        concept={pickedNow}
        subject={subject}
        byId={byId}
        onClose={() => setPicked(null)}
        starting={starting}
        onLearn={(c) => void start(`learn:${c.id}`, { concept_id: c.id })}
        onTestOut={(c) => void start(`test:${c.id}`, { concept_id: c.id, test_out: true })}
      />
      <SettingsSheet open={settings} onClose={() => setSettings(false)} subject={subject} onChange={onChange} />
    </div>
  );
}

function Legend() {
  const items: { icon: React.ReactNode; label: string; cls: string }[] = [
    { icon: <Play className="h-3 w-3" />, label: "Up next", cls: "bg-[var(--accent-strong)] text-white" },
    { icon: <Check className="h-3 w-3" />, label: "Learned", cls: "bg-[var(--st-good)] text-white" },
    { icon: <FastForward className="h-3 w-3" />, label: "Knew it already", cls: "bg-[var(--st-good)] text-white" },
    { icon: <Plus className="h-3 w-3" />, label: "Added for you", cls: "bg-[var(--st-gap-bg)] text-[var(--st-gap)]" },
    { icon: <CalendarClock className="h-3 w-3" />, label: "Due for review", cls: "bg-[var(--accent-strong)] text-white" },
    { icon: <ClipboardCheck className="h-3 w-3" />, label: "Unit task", cls: "bg-[var(--st-soft)] text-[var(--st-accent-text)]" },
    { icon: <Lock className="h-3 w-3" />, label: "Comes later", cls: "bg-[var(--hover-strong)] text-[var(--text-muted)]" },
  ];
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 px-2" aria-label="What the map shows">
      {items.map((x) => (
        <li key={x.label} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span aria-hidden className={cn("flex h-5 w-5 items-center justify-center rounded-full", x.cls)}>
            {x.icon}
          </span>
          {x.label}
        </li>
      ))}
    </ul>
  );
}

export function SourceList({ sources, className }: { sources: Source[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-1.5", className)}>
      {sources.map((s) => {
        const Icon = s.kind === "web" ? Globe : s.kind === "file" ? FileText : StickyNote;
        const inner = (
          <>
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2">{s.title || s.url || "Source"}</span>
              {s.kind === "web" && s.url && <span className="block truncate text-xs text-[var(--text-muted)]">{hostOf(s.url)}</span>}
              {s.kind !== "web" && <span className="block text-xs text-[var(--text-muted)]">{s.kind === "file" ? "Your file" : "Your note"}</span>}
            </span>
          </>
        );
        const cls = "flex items-start gap-2 rounded-lg px-1.5 py-1 text-sm text-[var(--text)]";
        return (
          <li key={s.n}>
            {s.kind === "web" && s.url ? (
              <a href={safeHref(s.url)} target="_blank" rel="noreferrer noopener" className={cn(cls, "hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]")}>
                {inner}
              </a>
            ) : s.kind === "file" && s.file_id ? (
              <Link to={`/files/f/${s.file_id}`} className={cn(cls, "hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]")}>
                {inner}
              </Link>
            ) : (
              <span className={cls}>{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------ concept sheet

function ConceptSheet({
  concept: c,
  subject,
  byId,
  onClose,
  onLearn,
  onTestOut,
  starting,
}: {
  concept: Concept | null;
  subject: SubjectFull;
  byId: Map<string, Concept>;
  onClose: () => void;
  onLearn: (c: Concept) => void;
  onTestOut: (c: Concept) => void;
  starting: string | null;
}) {
  if (!c) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const band = bandOf(c);
  const done = isDone(c);
  const builds = c.prereqs.map((id) => byId.get(id)).filter((x): x is Concept => !!x);
  const needs = builds.filter((x) => !isDone(x));
  const gapFor = c.gap_for ? byId.get(c.gap_for) : null;
  const sources = subject.sources.filter((s) => c.sources.includes(s.n));
  const mixups = subject.misconceptions.filter((m) => m.concept_id === c.id);
  return (
    <Sheet
      open
      onClose={onClose}
      title={c.title}
      footer={
        done ? undefined : (
          <div className="flex w-full flex-col gap-2 sm:flex-row-reverse">
            {!c.locked && (
              <Button variant="primary" size="lg" className="flex-1" onClick={() => onLearn(c)} loading={starting === `learn:${c.id}`} disabled={starting !== null} leftIcon={<Play className="h-4 w-4" />}>
                {c.steps_done > 0 ? "Carry on with this" : "Learn this"}
              </Button>
            )}
            <Button size="lg" className="flex-1" onClick={() => onTestOut(c)} loading={starting === `test:${c.id}`} disabled={starting !== null} leftIcon={<FastForward className="h-4 w-4" />}>
              I know this already
            </Button>
          </div>
        )
      }
    >
      <div className="study flex flex-col gap-4" data-testid="study-concept-sheet">
        <div>
          <div className="flex items-center gap-3">
            <Bar value={done ? 1 : c.mastery} color={done ? "var(--st-good)" : c.origin === "gap" ? "var(--st-gap)" : "var(--st-accent)"} label="How well you know this" />
            <span className="shrink-0 text-sm font-medium text-[var(--text)]">{BAND_WORDS[band]}</span>
          </div>
          {c.steps_done > 0 && !done && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {c.steps_done} {c.steps_done === 1 ? "step" : "steps"} done so far
            </p>
          )}
          {done && c.due_at && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]" data-testid="study-concept-review">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {c.due ? "Due for a quick review now." : `Comes back for review ${reviewWhen(c.due_at)}.`}
              {c.lapses > 0 ? ` It has slipped ${c.lapses === 1 ? "once" : `${c.lapses} times`}.` : ""}
            </p>
          )}
        </div>

        {c.origin === "gap" && (
          <div className="rounded-xl border border-[var(--st-gap-border)] bg-[var(--st-gap-bg)] p-3 text-sm text-[var(--text)]">
            <p className="font-semibold text-[var(--st-gap)]">Added for you{gapFor ? `, before ${gapFor.title}` : ""}</p>
            {c.reason && <p className="mt-0.5">{c.reason}</p>}
          </div>
        )}

        {c.summary && <p className="text-[15px] leading-relaxed text-[var(--text)]">{c.summary}</p>}

        {c.objectives.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">By the end you</h3>
            <ul className="flex flex-col gap-1">
              {c.objectives.map((o, i) => (
                <li key={i} className="flex gap-2 text-[15px] text-[var(--text)]">
                  <Check className={cn("mt-0.5 h-4 w-4 shrink-0", done ? "text-[var(--st-good)]" : "text-[var(--st-line)]")} aria-hidden />
                  {o}
                </li>
              ))}
            </ul>
          </div>
        )}

        {c.locked && needs.length > 0 && (
          <div className="rounded-xl bg-[var(--hover)] p-3 text-sm text-[var(--text)]">
            <p className="flex items-center gap-1.5 font-semibold">
              <Lock className="h-3.5 w-3.5" aria-hidden /> Comes after
            </p>
            <ul className="mt-1 list-disc pl-5">
              {needs.map((n) => (
                <li key={n.id}>{n.title}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[var(--text-muted)]">Already know it? "I know this already" lets you prove it and skip ahead.</p>
          </div>
        )}

        {!c.locked && builds.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Builds on</h3>
            <ul className="flex flex-col gap-0.5">
              {builds.map((n) => (
                <li key={n.id} className="flex items-center gap-2 text-sm text-[var(--text)]">
                  <Check className={cn("h-3.5 w-3.5 shrink-0", isDone(n) ? "text-[var(--st-good)]" : "text-[var(--st-line)]")} aria-hidden />
                  {n.title}
                </li>
              ))}
            </ul>
          </div>
        )}

        {mixups.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Mix-ups spotted here</h3>
            <ul className="flex flex-col gap-1.5">
              {mixups.map((m) => (
                <li key={m.id} className="text-sm text-[var(--text)]">
                  <span className={cn("font-medium", m.resolved && "line-through decoration-[var(--st-line)]")}>{m.label}</span>
                  {m.resolved && <span className="ml-1.5 text-xs text-[var(--st-good)]">sorted</span>}
                  {m.detail && <span className="block text-[var(--text-muted)]">{m.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {sources.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Taught from</h3>
            <SourceList sources={sources} />
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- settings

function SettingsSheet({ open, onClose, subject, onChange }: { open: boolean; onClose: () => void; subject: SubjectFull; onChange: () => void }) {
  const navigate = useNavigate();
  const prefs = useQuery({ queryKey: ["study", "prefs"], queryFn: studyApi.prefs, staleTime: 60_000, enabled: open });
  const levelLocked = prefs.data?.level_locked === true;
  const [title, setTitle] = useState(subject.title);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTitle(subject.title);
  }, [open, subject.title]);

  const patch = async (body: { title?: string; archived?: boolean; level?: Level }, done?: string) => {
    setBusy(true);
    try {
      await studyApi.patch(subject.id, body);
      onChange();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(studyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Subject settings">
      <div className="study flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-[var(--text)]">Name</span>
          <span className="flex gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 200))}
              className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[16px] text-[var(--text)] focus:border-[var(--st-accent)] focus:outline-none"
            />
            <Button onClick={() => void patch({ title: title.trim() }, "Renamed")} disabled={busy || title.trim().length < 2 || title.trim() === subject.title}>
              Save
            </Button>
          </span>
        </label>

        <fieldset>
          <legend className="text-sm font-medium text-[var(--text)]">Who is learning</legend>
          <p className="mb-2 text-xs text-[var(--text-muted)]">{levelLocked ? "This is set for your account. An admin can change it." : "Changes how the teacher talks from the next step on."}</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Who is learning">
            {(Object.keys(LEVEL_WORDS) as Level[]).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={subject.level === l}
                disabled={busy || levelLocked}
                onClick={() => subject.level !== l && void patch({ level: l })}
                className={cn(
                  "rounded-xl border px-2 py-2.5 text-center text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
                  subject.level === l ? "border-[var(--st-accent)] bg-[var(--st-soft)] font-semibold text-[var(--st-accent-text)]" : "border-[var(--border)] text-[var(--text)] hover:border-[var(--st-accent)]"
                )}
              >
                {LEVEL_WORDS[l].name}
                <span className="block text-[11px] font-normal text-[var(--text-muted)]">{LEVEL_WORDS[l].detail}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
          <Button
            leftIcon={<Archive className="h-4 w-4" />}
            disabled={busy}
            onClick={async () => {
              await patch({ archived: !subject.archived }, subject.archived ? "Back in your subjects" : "Put away");
              onClose();
            }}
          >
            {subject.archived ? "Bring back from put-away" : "Put away (keeps your progress)"}
          </Button>
          <Button
            variant="ghost"
            className="text-[var(--danger)]"
            leftIcon={<Trash2 className="h-4 w-4" />}
            disabled={busy}
            onClick={async () => {
              if (!(await confirm({ title: `Delete "${subject.title}"?`, message: "The course and your progress in it go to the trash. You can put it back from there for 30 days.", confirmLabel: "Delete", danger: true }))) return;
              try {
                await studyApi.remove(subject.id);
                onChange();
                toast.success("Moved to the trash");
                navigate("/study", { replace: true });
              } catch (e) {
                toast.error(studyError(e).message);
              }
            }}
          >
            Delete this subject
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
