import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ClipboardCheck, Plus, Printer, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { studyApi, studyError, type Capstone, type Report } from "@/api/study";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Skeleton } from "@/components/shared/Skeleton";
import { safeHref } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { Bar } from "../ui/bits";
import "../study.css";

/*
 * The subject's report (``/study/:subjectId/report``): what you now know,
 * what is shaky, what was added for you, the tasks, the sources and what
 * could come next. Worked out from your progress each time it is opened,
 * so it is right part-way through a subject too. It prints cleanly.
 */

const capWords = (c: Capstone | null): string => {
  if (!c) return "Not reached yet";
  if (c.status === "passed") return `Done (${c.met} of ${c.points} points)`;
  if (c.status === "closed") return `Left after ${c.tries} goes (${c.met} of ${c.points} points)`;
  return `Another go to come (${c.met} of ${c.points} points so far)`;
};

export function ReportPage() {
  const { subjectId = "" } = useParams();
  const q = useQuery({ queryKey: ["study", "report", subjectId], queryFn: () => studyApi.report(subjectId), staleTime: 5_000 });
  const r = q.data;
  return (
    <div className="study study-report flex min-h-0 flex-1 flex-col">
      <div className="print:hidden">
        <TopNav
          title={
            <span className="flex min-w-0 items-center gap-1">
              <Link to={`/study/${subjectId}`} aria-label="Back to the map" className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <span className="truncate text-base font-semibold text-[var(--text)]">Report</span>
            </span>
          }
          actions={
            r ? (
              <Button onClick={() => window.print()} leftIcon={<Printer className="h-4 w-4" />}>
                Print
              </Button>
            ) : undefined
          }
        />
      </div>
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto print:overflow-visible">
        {q.isLoading ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : q.isError || !r ? (
          <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <p role="alert" className="max-w-sm text-[15px] text-[var(--text)]">
              {studyError(q.error).status === 404 ? "This subject isn't here any more." : studyError(q.error).message}
            </p>
            <Button variant="primary" onClick={() => void q.refetch()} leftIcon={<RotateCcw className="h-4 w-4" />}>
              Try again
            </Button>
          </div>
        ) : (
          <Body r={r} />
        )}
      </div>
    </div>
  );
}

function Section({ title, icon, children, tone }: { title: string; icon: React.ReactNode; children: React.ReactNode; tone?: "warn" | "gap" }) {
  return (
    <section
      className={cn(
        "rounded-2xl border p-4 print:break-inside-avoid",
        tone === "warn" ? "border-[var(--st-warn-border)] bg-[var(--st-warn-bg)]" : tone === "gap" ? "border-[var(--st-gap-border)] bg-[var(--st-gap-bg)]" : "border-[var(--border)] bg-[var(--surface)]"
      )}
    >
      <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
        <span aria-hidden className="text-[var(--st-accent-text)]">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Body({ r }: { r: Report }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const s = r.subject;
  const solid = r.units.reduce((n, u) => n + u.solid.length, 0);
  const when = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  const suggest = async () => {
    setAsking(true);
    try {
      await studyApi.suggestNext(s.id);
      await qc.invalidateQueries({ queryKey: ["study", "report", s.id] });
    } catch (e) {
      toast.error(studyError(e).message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5 pb-16" data-testid="study-report" data-finished={r.finished}>
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--st-accent-text)]">{r.finished ? "Finished" : "So far"} · {when}</p>
        <h1 className="mt-1 text-2xl font-semibold leading-tight text-[var(--text)]">{s.title}</h1>
        {s.goal && <p className="mt-1 text-[15px] text-[var(--text-muted)]">Why: {s.goal}</p>}
        <div className="mt-3 flex items-center gap-3">
          <Bar value={s.progress.percent / 100} color={r.finished ? "var(--st-good)" : "var(--st-accent)"} label="Ideas learned" />
          <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--text)]">{s.progress.percent}%</span>
        </div>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          {s.progress.done} of {r.totals.concepts} ideas learned
          {r.totals.known_before > 0 ? ` (${r.totals.known_before} you already knew)` : ""} · {r.totals.lessons} {r.totals.lessons === 1 ? "lesson" : "lessons"} · {r.totals.steps} steps
        </p>
      </header>

      <Section title={`What you know (${solid})`} icon={<Check className="h-4 w-4" />}>
        {solid === 0 ? (
          <p className="text-[15px] text-[var(--text-muted)]">Nothing solid yet. It fills in as you go.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {r.units
              .filter((u) => u.solid.length > 0)
              .map((u) => (
                <div key={u.id}>
                  <h3 className="text-sm font-semibold text-[var(--text)]">{u.title}</h3>
                  <ul className="mt-1 flex flex-col gap-1">
                    {u.solid.map((c) => (
                      <li key={c.id} className="flex gap-2 text-[15px] text-[var(--text)]">
                        <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--st-good)]" aria-hidden />
                        <span>
                          <span className="font-medium">{c.title}</span>
                          {c.state === "known" && <span className="text-[var(--text-muted)]"> · knew it already</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </Section>

      {r.shaky.length > 0 && (
        <Section title={`Worth another look (${r.shaky.length})`} icon={<TriangleAlert className="h-4 w-4" />} tone="warn">
          <ul className="flex flex-col gap-1.5" data-testid="study-report-shaky">
            {r.shaky.map((c) => (
              <li key={c.id} className="text-[15px] text-[var(--text)]">
                <span className="font-medium">{c.title}</span>
                <span className="block text-sm text-[var(--text-muted)]">{c.why}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {r.added.length > 0 && (
        <Section title="Added for you along the way" icon={<Plus className="h-4 w-4" />} tone="gap">
          <ul className="flex flex-col gap-1.5">
            {r.added.map((c) => (
              <li key={c.id} className="text-[15px] text-[var(--text)]">
                <span className="font-medium">{c.title}</span>
                {c.for && <span className="text-[var(--text-muted)]"> · before {c.for}</span>}
                {c.reason && <span className="block text-sm text-[var(--text-muted)]">{c.reason}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="The tasks" icon={<ClipboardCheck className="h-4 w-4" />}>
        <ul className="flex flex-col gap-1 text-[15px] text-[var(--text)]">
          {r.units.map((u) => (
            <li key={u.id} className="flex flex-wrap justify-between gap-x-3">
              <span>{u.title}</span>
              <span className="text-sm text-[var(--text-muted)]">{capWords(u.capstone)}</span>
            </li>
          ))}
          <li className="flex flex-wrap justify-between gap-x-3 font-medium">
            <span>The final task</span>
            <span className="text-sm font-normal text-[var(--text-muted)]">{capWords(r.capstone)}</span>
          </li>
        </ul>
      </Section>

      {(r.finished || r.next.length > 0) && (
        <Section title="What could come next" icon={<Sparkles className="h-4 w-4" />}>
          {r.next.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="study-report-next">
              {r.next.map((n) => (
                <li key={n.title} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 text-[15px] text-[var(--text)]">
                    <span className="font-medium">{n.title}</span>
                    <span className="block text-sm text-[var(--text-muted)]">{n.why}</span>
                  </span>
                  <Link
                    to={`/study/new?title=${encodeURIComponent(n.title)}`}
                    className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-sm font-medium text-[var(--st-accent-text)] hover:border-[var(--st-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] print:hidden"
                  >
                    Start this
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-start gap-2 print:hidden">
              <p className="text-[15px] text-[var(--text-muted)]">Ask your teacher what would follow well from this.</p>
              <Button onClick={() => void suggest()} loading={asking}>
                Suggest what to learn next
              </Button>
            </div>
          )}
        </Section>
      )}

      {r.sources.length > 0 && (
        <Section title="Taught from" icon={<Check className="h-4 w-4" />}>
          <ol className="flex flex-col gap-1 text-sm text-[var(--text)]">
            {r.sources.map((x) => (
              <li key={x.n} className="flex gap-2">
                <span className="w-5 shrink-0 text-right text-[var(--text-muted)]">{x.n}.</span>
                {x.kind === "web" && x.url ? (
                  <a href={safeHref(x.url)} target="_blank" rel="noreferrer noopener" className="min-w-0 break-words underline decoration-[var(--st-line)] underline-offset-2 hover:decoration-[var(--st-accent)]">
                    {x.title || x.url}
                  </a>
                ) : (
                  <span>
                    {x.title} <span className="text-[var(--text-muted)]">({x.kind === "file" ? "your file" : "your note"})</span>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}
