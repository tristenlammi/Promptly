import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, Check, CircleHelp, ClipboardCheck, FastForward, Headphones, Lightbulb, MessageCircleQuestion, PartyPopper, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  studyApi,
  studyError,
  type AnswerReply,
  type Ask,
  type Change,
  type Concept,
  type LessonSummary,
  type PlacementSummary,
  type ReviewSummary,
  type Session,
  type Step,
} from "@/api/study";
import { Button } from "@/components/shared/Button";
import { Sheet } from "@/components/shared/Sheet";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

import { AskPanel } from "../AskPanel";
import { buildAnswer, canSayDontKnow, DONT_KNOW, draftFromAnswer, emptyDraft, isInstant, isReady, isWritten, KIND_LABEL, type Draft } from "../steps/answers";
import { StepBody } from "../steps/Renderers";
import { feedbackSpeech, speechFor } from "../steps/speech";
import { Bar, Thinking } from "../ui/bits";
import { Md } from "../ui/Md";
import { ReadAloud, readListenPref, useVoiceSupport, writeListenPref } from "../ui/Voice";
import "../study.css";

/*
 * The lesson player (and the placement check, which is the same loop with
 * the feedback turned off, and a review sitting, which is the same loop over
 * what has come due): ask the server for the step to show, render it by
 * kind, send the answer, show what it changed, repeat until done.
 */

type Phase = "loading" | "step" | "sending" | "answered" | "advancing" | "done" | "error";

const CONFIDENCE: { v: 1 | 2 | 3; label: string }[] = [
  { v: 1, label: "Guessing" },
  { v: 2, label: "Think so" },
  { v: 3, label: "Sure" },
];

const OUTCOME = {
  correct: { title: "That's right", tone: "good" },
  partial: { title: "Nearly", tone: "warn" },
  wrong: { title: "Not quite", tone: "bad" },
} as const;

export function LessonPage() {
  const params = useParams();
  const sessionId = params.sessionId ?? "";
  const navigate = useNavigate();
  const voice = useVoiceSupport();
  const [listen, setListen] = useState(readListenPref);
  const [stepSubject, setStepSubject] = useState<{ id: string; title: string } | null>(null);
  const qc = useQueryClient();
  const isPhone = useIsMobile(1023);

  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [history, setHistory] = useState<Step[]>([]);
  const [step, setStep] = useState<Step | null>(null);
  const [concept, setConcept] = useState<Concept | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [confidence, setConfidence] = useState<1 | 2 | 3 | null>(null);
  const [result, setResult] = useState<AnswerReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [turnBusy, setTurnBusy] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const stepRef = useRef<Step | null>(null);
  stepRef.current = step;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const placement = session?.kind === "placement";
  const review = session?.kind === "review";
  // A review of everything is opened from the Study home, and goes back there.
  const subjectId = params.subjectId ?? session?.subject_id ?? "";
  const mapPath = params.subjectId ? `/study/${params.subjectId}` : "/study";
  const backWords = params.subjectId ? "Back to the map" : "Back to Study";
  const title = placement ? "Quick check" : review ? "Review" : "Lesson";

  const show = useCallback((s: Step | null, c: Concept | null) => {
    setStep(s);
    setConcept(c);
    setDraft(s ? (s.status === "answered" ? draftFromAnswer(s) : emptyDraft(s)) : emptyDraft());
    setConfidence(null);
    setResult(null);
    setError(null);
    setTurnError(null);
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, []);

  const advance = useCallback(
    async (first = false) => {
      setPhase(first ? "loading" : "advancing");
      setError(null);
      try {
        const out = await studyApi.next(sessionId);
        if (!alive.current) return;
        setSession((prev) => ({ ...(prev ?? out.session), ...out.session, steps: prev?.steps }));
        setStepSubject(out.subject ?? null);
        if (out.done || !out.step) {
          show(null, null);
          setPhase("done");
          void qc.invalidateQueries({ queryKey: ["study"] });
          return;
        }
        show(out.step, out.concept);
        setPhase("step");
      } catch (e) {
        if (!alive.current) return;
        const err = studyError(e);
        if (first) {
          setLoadError(err.message);
          setPhase("error");
        } else {
          setError(err.message);
          setPhase(stepRef.current ? "answered" : "error");
          if (!stepRef.current) setLoadError(err.message);
        }
      }
    },
    [sessionId, show, qc]
  );

  const load = useCallback(async () => {
    setPhase("loading");
    setLoadError(null);
    try {
      const se = await studyApi.session(sessionId);
      if (!alive.current) return;
      setSession(se);
      setHistory((se.steps ?? []).filter((s) => s.status !== "pending"));
      if (se.status === "done") {
        setPhase("done");
        return;
      }
      await advance(true);
    } catch (e) {
      if (!alive.current) return;
      setLoadError(studyError(e).message);
      setPhase("error");
    }
  }, [sessionId, advance]);

  useEffect(() => {
    void load();
    // Only when the lesson changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const send = async (answer: Record<string, unknown>, conf: 1 | 2 | 3 | null) => {
    if (!step || phase !== "step") return;
    setPhase("sending");
    setError(null);
    try {
      const out = await studyApi.answer(step.id, answer, conf);
      if (!alive.current) return;
      setHistory((h) => [...h.filter((s) => s.id !== out.step.id), out.step]);
      setStep(out.step);
      setConcept(out.concept);
      setDraft(draftFromAnswer(out.step));
      setResult(out);
      void qc.invalidateQueries({ queryKey: ["study"] });
      // Nothing to read after "Got it" or a placement question: straight on.
      if (out.step.kind === "explain" || out.step.role === "placement") {
        await advance();
        return;
      }
      setPhase("answered");
      requestAnimationFrame(() => {
        feedbackRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        feedbackRef.current?.focus?.({ preventScroll: true });
      });
    } catch (e) {
      if (!alive.current) return;
      const err = studyError(e);
      if (err.code === "answered") {
        await advance();
        return;
      }
      setError(err.message);
      setPhase("step");
    }
  };

  const check = () => {
    if (step && isReady(step, draft)) void send(buildAnswer(step, draft), step.graded && !placement ? confidence : null);
  };

  const hint = async () => {
    if (!step || hintBusy || step.hints_left <= 0) return;
    setHintBusy(true);
    setError(null);
    try {
      const out = await studyApi.hint(step.id);
      if (alive.current) setStep((s) => (s && s.id === step.id ? { ...s, hints_shown: [...s.hints_shown, out.hint], hints_left: out.hints_left } : s));
    } catch (e) {
      if (alive.current) setError(studyError(e).message);
    } finally {
      if (alive.current) setHintBusy(false);
    }
  };

  const turn = async (text: string) => {
    if (!step || turnBusy) return;
    setTurnBusy(true);
    setTurnError(null);
    try {
      const out = await studyApi.turn(step.id, text);
      if (alive.current) setStep(out);
    } catch (e) {
      if (alive.current) setTurnError(studyError(e).message);
    } finally {
      if (alive.current) setTurnBusy(false);
    }
  };

  const leave = () => navigate(mapPath);

  const endNow = async () => {
    try {
      await studyApi.end(sessionId);
    } catch {
      // Leaving anyway: the lesson can be picked up or ended later.
    }
    void qc.invalidateQueries({ queryKey: ["study"] });
    navigate(mapPath);
  };

  const keepGoing = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const se = await studyApi.startSession(subjectId, {});
      navigate(`/study/${subjectId}/learn/${se.id}`, { replace: true });
    } catch (e) {
      setError(studyError(e).message);
    } finally {
      setStarting(false);
    }
  };

  // Number keys pick a choice; Enter checks or carries on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || (askOpen && isPhone)) return;
      if (!step) return;
      if (phase === "step" && /^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        const pub = step.public as { options?: { id: string }[]; lines?: { id: string }[] };
        const option = pub.options?.[i]?.id;
        const line = pub.lines?.[i]?.id;
        if ((step.kind === "mcq" || step.kind === "predict") && option) setDraft((d) => ({ ...d, optionId: option }));
        if (step.kind === "spot_error" && line) setDraft((d) => ({ ...d, lineId: line }));
      }
      // Enter on a choice (or the how-sure row) checks, as it would in a form;
      // on any other button it presses that button.
      const onChoice = t?.getAttribute?.("role") === "radio";
      if (e.key === "Enter" && (onChoice || (t?.tagName !== "BUTTON" && t?.tagName !== "SUMMARY" && t?.tagName !== "A"))) {
        if (phase === "step" && isReady(step, draft)) {
          e.preventDefault();
          check();
        } else if (phase === "answered") {
          e.preventDefault();
          void advance();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (phase === "error" && !step) {
    return (
      <Shell onLeave={leave} title={title} backWords={backWords}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p role="alert" className="max-w-sm text-[15px] text-[var(--text)]">
            {loadError ?? "This lesson couldn't be opened."}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void load()} leftIcon={<RotateCcw className="h-4 w-4" />}>
              Try again
            </Button>
            <Button onClick={leave}>{backWords}</Button>
          </div>
        </div>
      </Shell>
    );
  }

  if (phase === "done" && session) {
    return (
      <Shell onLeave={leave} title={title} backWords={backWords} rail={<Rail session={session} history={history} current={null} />}>
        <div ref={bodyRef} className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-xl px-4 py-8">
            {placement ? (
              <PlacementDone summary={session.summary as PlacementSummary | null} onGo={() => navigate(mapPath, { replace: true })} />
            ) : review ? (
              <ReviewDone summary={session.summary as ReviewSummary | null} onBack={() => navigate(mapPath)} backWords={backWords} />
            ) : (
              <LessonDone
                summary={session.summary as LessonSummary | null}
                history={history}
                onMap={() => navigate(mapPath)}
                onMore={keepGoing}
                onReport={() => navigate(`/study/${subjectId}/report`)}
                starting={starting}
                error={error}
              />
            )}
          </div>
        </div>
      </Shell>
    );
  }

  if (phase === "loading" || !step || !session) {
    return (
      <Shell onLeave={leave} title={title} backWords={backWords}>
        <div className="flex flex-1 items-center justify-center">
          <Thinking label={sessionId ? "Getting your next step ready" : "Loading"} />
        </div>
      </Shell>
    );
  }

  const answered = step.status === "answered";
  const busy = phase === "sending" || phase === "advancing";
  const ready = isReady(step, draft);
  const quiet = step.role === "placement";
  const showAsk = !quiet;
  const before = result?.changes.find((c): c is Extract<Change, { type: "mastery" }> => c.type === "mastery" && c.concept_id === step.concept_id);

  const askPanel = <AskPanel step={step} onAsks={(asks: Ask[]) => setStep((s) => (s ? { ...s, asks } : s))} />;
  // Read aloud: the step while it waits, what the teacher said once it's answered.
  const spoken = answered ? (step.kind === "explain" || quiet ? "" : feedbackSpeech(step)) : speechFor(step);
  const canDictate = voice.speak && isWritten(step.kind);

  return (
    <Shell
      onLeave={leave}
      onEnd={quiet ? undefined : endNow}
      title={title}
      backWords={backWords}
      rail={<Rail session={session} history={history} current={step} />}
      voice={
        voice.listen ? (
          <>
            <button
              type="button"
              onClick={() => {
                writeListenPref(!listen);
                setListen(!listen);
              }}
              aria-pressed={listen}
              aria-label="Read every step to me"
              title={listen ? "Reading every step to you. Tap to stop." : "Read every step to me"}
              data-testid="study-listen"
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
                listen ? "bg-[var(--st-soft)] text-[var(--st-accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
              )}
            >
              <Headphones className="h-5 w-5" aria-hidden />
            </button>
            <ReadAloud text={spoken} speakKey={`${step.id}:${step.status}`} auto={listen} />
          </>
        ) : undefined
      }
      action={
        showAsk ? (
          <button
            type="button"
            onClick={() => setAskOpen((o) => !o)}
            aria-expanded={askOpen}
            className={cn(
              "flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
              askOpen ? "bg-[var(--st-soft)] text-[var(--st-accent-text)]" : "text-[var(--st-accent-text)] hover:bg-[var(--st-soft)]"
            )}
          >
            <MessageCircleQuestion className="h-5 w-5" />
            <span className="hidden sm:inline">Ask the teacher</span>
            <span className="sm:hidden">Ask</span>
            {step.asks.length > 0 && <span className="sr-only">({step.asks.length / 2} asked)</span>}
          </button>
        ) : undefined
      }
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={bodyRef} className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
            <div key={step.id} data-testid="study-step" data-step={step.id} data-kind={step.kind} data-status={step.status} className="study-in mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-8 pt-5 sm:px-6">
              <ConceptLine step={step} concept={concept} quiet={quiet} before={before?.before} subject={review && !params.subjectId ? stepSubject?.title : undefined} />
              <StepBody step={step} draft={draft} setDraft={setDraft} locked={answered || busy} onTurn={turn} sending={turnBusy} turnError={turnError} canDictate={canDictate} />

              {step.hints_shown.length > 0 && !answered && (
                <ul className="flex flex-col gap-2" aria-label="Hints">
                  {step.hints_shown.map((h, i) => (
                    <li key={i} className="study-in flex gap-2 rounded-xl border border-[var(--st-warn-border)] bg-[var(--st-warn-bg)] px-3 py-2 text-[15px] text-[var(--text)]">
                      <Lightbulb aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--st-warn)]" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              )}

              {phase === "sending" && !isInstant(step.kind) && step.kind !== "explain" && <Thinking label="The teacher is reading your answer" />}

              {answered && step.grade && !quiet && step.kind !== "explain" && (
                <div ref={feedbackRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
                  <Feedback step={step} />
                  {result && <Changes changes={result.changes} concept={step.role === "capstone" ? null : concept} />}
                </div>
              )}

              {answered && step.void && (
                // Scrolled into view like feedback is: it is what happened.
                <div ref={feedbackRef} tabIndex={-1} className="outline-none">
                  <p role="status" data-testid="study-void" className="study-in rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-[15px] text-[var(--text)]">
                    That task had a fault in it, so it didn't count. On to the next one.
                  </p>
                </div>
              )}

              {phase === "advancing" && <Thinking label={quiet ? "Next question" : "The teacher is getting your next step ready"} />}

              {error && (
                <p role="alert" className="rounded-xl border border-[var(--st-bad-border)] bg-[var(--st-bad-bg)] px-3 py-2.5 text-sm text-[var(--st-bad)]">
                  {error}
                </p>
              )}
            </div>
          </div>

          {/* The action bar. */}
          <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-2.5">
              {!answered && step.graded && !quiet && step.kind !== "teach_student" && ready && (
                <div className="study-in flex flex-wrap items-center gap-2" role="radiogroup" aria-label="How sure are you?">
                  <span className="text-sm text-[var(--text-muted)]">How sure are you?</span>
                  {CONFIDENCE.map((c) => (
                    <button
                      key={c.v}
                      type="button"
                      role="radio"
                      aria-checked={confidence === c.v}
                      disabled={busy}
                      onClick={() => setConfidence(confidence === c.v ? null : c.v)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
                        confidence === c.v ? "border-[var(--st-accent)] bg-[var(--st-soft)] font-medium text-[var(--st-accent-text)]" : "border-[var(--border)] text-[var(--text)] hover:border-[var(--st-accent)]"
                      )}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                {!answered && step.graded && !quiet && step.hints_left > 0 && (
                  <Button variant="ghost" onClick={() => void hint()} loading={hintBusy} disabled={busy} leftIcon={<Lightbulb className="h-4 w-4" />}>
                    Hint
                    <span className="sr-only"> ({step.hints_left} left)</span>
                  </Button>
                )}
                {!answered && step.graded && canSayDontKnow(step.kind) && (
                  <Button variant="ghost" onClick={() => void send({ ...DONT_KNOW }, null)} disabled={busy} leftIcon={<CircleHelp className="h-4 w-4" />}>
                    I don't know
                  </Button>
                )}
                <span className="flex-1" />
                {answered ? (
                  <Button variant="primary" size="lg" onClick={() => void advance()} loading={phase === "advancing"} rightIcon={<ArrowRight className="h-4 w-4" />} data-testid="study-continue" autoFocus={!isPhone}>
                    Continue
                  </Button>
                ) : (
                  <Button variant="primary" size="lg" onClick={check} disabled={!ready || phase === "advancing"} loading={phase === "sending"} data-testid="study-check">
                    {step.kind === "explain" ? "Got it" : step.kind === "teach_student" ? "Finish" : "Check"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Ask the teacher: beside the step on a wide screen, a sheet on a phone. */}
        {showAsk && askOpen && !isPhone && (
          <aside aria-label="Ask the teacher" className="study-in flex w-[360px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] pl-4 pr-2">
              <h2 className="text-sm font-semibold text-[var(--text)]">Ask the teacher</h2>
              <button type="button" onClick={() => setAskOpen(false)} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            {askPanel}
          </aside>
        )}
      </div>
      {showAsk && isPhone && (
        <Sheet open={askOpen} onClose={() => setAskOpen(false)} title="Ask the teacher" size="md">
          <div className="study -mx-4 flex h-[62vh] flex-col">{askPanel}</div>
        </Sheet>
      )}
    </Shell>
  );
}

// ------------------------------------------------------------------ parts

function Shell({
  children,
  onLeave,
  onEnd,
  title,
  rail,
  action,
  voice,
  backWords = "Back to the map",
}: {
  children: React.ReactNode;
  onLeave: () => void;
  onEnd?: () => void;
  title: string;
  rail?: React.ReactNode;
  action?: React.ReactNode;
  voice?: React.ReactNode;
  backWords?: string;
}) {
  return (
    <div className="study flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 pt-safe pl-safe pr-safe sm:px-4">
        <button type="button" onClick={onLeave} aria-label={backWords === "Back to the map" ? "Leave and go back to the map. Your place is kept." : "Leave and go back to Study. Your place is kept."} title={backWords} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
          <X className="h-5 w-5" />
        </button>
        <h1 className="sr-only">{title}</h1>
        <div className="min-w-0 flex-1 pr-2">{rail}</div>
        {onEnd && (
          <button type="button" onClick={onEnd} className="hidden h-10 shrink-0 rounded-full px-3 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] sm:block">
            Finish for now
          </button>
        )}
        {voice}
        {action}
      </header>
      {children}
    </div>
  );
}

/** Where you are in the lesson: one segment per step, coloured by how it went. */
function Rail({ session, history, current }: { session: Session; history: Step[]; current: Step | null }) {
  const lesson = session.kind !== "placement";
  const done = history.filter((s) => s.status === "answered" || s.status === "skipped");
  const total = lesson ? Math.max(session.target_steps, done.length + (current && current.status === "pending" ? 1 : 0)) : 0;
  if (!lesson) {
    const n = done.length + (current && current.status === "pending" ? 1 : 0);
    return (
      <p className="truncate text-sm font-medium text-[var(--text)]" aria-live="polite">
        Quick check{n > 0 ? ` · question ${n}` : ""}
      </p>
    );
  }
  const segs = Array.from({ length: total }, (_, i) => {
    const s = done[i];
    if (s) return s.status === "skipped" ? "skip" : !s.grade ? "seen" : s.grade.outcome;
    return i === done.length && current?.status === "pending" ? "now" : "todo";
  });
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done.length} aria-label={`Step ${Math.min(total, done.length + 1)} of ${total}`} className="flex items-center gap-1" data-testid="study-rail">
      {segs.map((s, i) => (
        <span
          key={i}
          className={cn(
            "h-2 min-w-0 flex-1 rounded-full transition-colors duration-300",
            s === "correct" && "bg-[var(--st-good)]",
            s === "partial" && "bg-[var(--st-warn)]",
            s === "wrong" && "bg-[var(--st-bad)]",
            s === "seen" && "bg-[var(--st-accent)] opacity-60",
            s === "skip" && "bg-[var(--st-line)]",
            s === "now" && "bg-[var(--st-accent)]",
            s === "todo" && "bg-[var(--hover-strong)]"
          )}
        />
      ))}
    </div>
  );
}

function ConceptLine({ step, concept, quiet, before, subject }: { step: Step; concept: Concept | null; quiet: boolean; before?: number; subject?: string }) {
  // Start the bar where it was, then let it move to where it is now.
  const [shown, setShown] = useState(before ?? concept?.mastery ?? 0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(concept?.mastery ?? 0));
    return () => cancelAnimationFrame(id);
  }, [concept?.mastery]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-full bg-[var(--st-soft)] px-2.5 py-0.5 text-xs font-semibold text-[var(--st-accent-text)]">{KIND_LABEL[step.kind]}</span>
        {step.role === "recall" && <span className="rounded-full bg-[var(--hover-strong)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">From earlier</span>}
        {step.role === "test_out" && <span className="rounded-full bg-[var(--hover-strong)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">Show you know it</span>}
        {step.role === "review" && <span className="rounded-full bg-[var(--hover-strong)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">Review</span>}
        {subject && <span className="min-w-0 truncate text-xs text-[var(--text-muted)]">{subject}</span>}
        {concept?.origin === "gap" && <span className="rounded-full bg-[var(--st-gap-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--st-gap)]">Added for you</span>}
      </div>
      {concept && !quiet && step.role !== "capstone" && (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">{concept.title}</p>
          <span className="w-24 shrink-0">
            <Bar value={shown} label={`How well you know ${concept.title}`} color={concept.state === "mastered" || concept.state === "known" ? "var(--st-good)" : "var(--st-accent)"} />
          </span>
        </div>
      )}
    </div>
  );
}

function Feedback({ step }: { step: Step }) {
  const g = step.grade;
  if (!g) return null;
  const o = OUTCOME[g.outcome] ?? OUTCOME.wrong;
  const dontKnow = (step.answer as { dont_know?: boolean } | null)?.dont_know === true;
  return (
    <section
      aria-label="How you did"
      data-testid="study-feedback"
      data-outcome={g.outcome}
      className={cn(
        "study-in rounded-2xl border p-4",
        dontKnow && "border-[var(--border)] bg-[var(--surface)]",
        !dontKnow && o.tone === "good" && "border-[var(--st-good-border)] bg-[var(--st-good-bg)]",
        !dontKnow && o.tone === "warn" && "border-[var(--st-warn-border)] bg-[var(--st-warn-bg)]",
        !dontKnow && o.tone === "bad" && "border-[var(--st-bad-border)] bg-[var(--st-bad-bg)]"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "study-pop flex h-7 w-7 items-center justify-center rounded-full text-white",
            dontKnow ? "bg-[var(--st-accent)]" : o.tone === "good" ? "bg-[var(--st-good)]" : o.tone === "warn" ? "bg-[var(--st-warn)]" : "bg-[var(--st-bad)]"
          )}
        >
          {dontKnow ? <Lightbulb className="h-4 w-4" /> : o.tone === "good" ? <Check className="h-4 w-4" /> : o.tone === "warn" ? <span className="text-sm font-bold">~</span> : <X className="h-4 w-4" />}
        </span>
        <h2 className="text-base font-semibold text-[var(--text)]">{dontKnow ? "No problem. Here's how it goes" : o.title}</h2>
      </div>
      {g.feedback_md && !isInstant(step.kind) && <Md text={g.feedback_md} compact className="mt-2" />}
      {g.misconception && (
        <p className="mt-3 rounded-xl bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]">
          <span className="font-semibold">The mix-up: </span>
          {g.misconception}
        </p>
      )}
    </section>
  );
}

/** What this answer changed: the moment the course adapts, said out loud. */
function Changes({ changes, concept }: { changes: Change[]; concept: Concept | null }) {
  const shown = changes.filter((c) => c.type !== "mastery");
  const mastery = changes.find((c): c is Extract<Change, { type: "mastery" }> => c.type === "mastery" && c.concept_id === concept?.id);
  if (!shown.length && !mastery) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="What changed" data-testid="study-changes">
      {mastery && !shown.some((c) => c.type === "mastered" && c.concept_id === mastery.concept_id) && Math.round(mastery.after * 100) !== Math.round(mastery.before * 100) && (
        <li className="flex items-center gap-2 px-1 text-sm text-[var(--text-muted)]">
          <span>
            {concept?.title}: {Math.round(mastery.before * 100)}% → <span className="font-semibold text-[var(--text)]">{Math.round(mastery.after * 100)}%</span>
          </span>
        </li>
      )}
      {shown.map((c, i) => {
        if (c.type === "mastered")
          return (
            <li key={i} className="study-in flex items-start gap-3 rounded-2xl border border-[var(--st-good-border)] bg-[var(--st-good-bg)] p-3.5" data-change="mastered">
              <span aria-hidden className="study-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--st-good)] text-white">
                {c.by === "test_out" ? <FastForward className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              </span>
              <p className="text-[15px] text-[var(--text)]">
                <span className="font-semibold">{c.by === "test_out" ? `Skipping ahead: ${c.title}.` : `You've got it: ${c.title}.`}</span>{" "}
                {c.by === "test_out" ? "You clearly know this already, so it's marked as learned." : "It's marked as learned on your map."}
              </p>
            </li>
          );
        if (c.type === "gap_added")
          return (
            <li key={i} className="study-in flex items-start gap-3 rounded-2xl border border-[var(--st-gap-border)] bg-[var(--st-gap-bg)] p-3.5" data-change="gap_added">
              <span aria-hidden className="study-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--st-gap)] text-white">
                <Plus className="h-5 w-5" />
              </span>
              <p className="text-[15px] text-[var(--text)]">
                <span className="font-semibold">Added to your map: {c.title}.</span> {c.reason} It comes next.
              </p>
            </li>
          );
        if (c.type === "relearn")
          return (
            <li key={i} className="study-in flex items-start gap-3 rounded-2xl border border-[var(--st-warn-border)] bg-[var(--st-warn-bg)] p-3.5" data-change="relearn">
              <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--st-warn)] text-white">
                <RotateCcw className="h-4 w-4" />
              </span>
              <p className="text-[15px] text-[var(--text)]">
                <span className="font-semibold">{c.title} has slipped.</span> It's going back on your list for another go.
              </p>
            </li>
          );
        if (c.type === "review")
          return c.next_days == null ? null : (
            <li key={i} className="flex items-center gap-2 px-1 text-sm text-[var(--text-muted)]" data-change="review">
              <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
              <span>{c.next_days <= 1 ? "It comes back tomorrow." : `It comes back in ${c.next_days} days.`}</span>
            </li>
          );
        if (c.type === "capstone")
          return (
            <li
              key={i}
              className={cn("study-in flex items-start gap-3 rounded-2xl border p-3.5", c.status === "passed" ? "border-[var(--st-good-border)] bg-[var(--st-good-bg)]" : "border-[var(--st-warn-border)] bg-[var(--st-warn-bg)]")}
              data-change="capstone"
              data-status={c.status}
            >
              <span aria-hidden className={cn("study-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white", c.status === "passed" ? "bg-[var(--st-good)]" : "bg-[var(--st-warn)]")}>
                <ClipboardCheck className="h-4 w-4" />
              </span>
              <p className="text-[15px] text-[var(--text)]">
                <span className="font-semibold">
                  {c.status === "passed"
                    ? c.scope === "final"
                      ? "Final task done."
                      : `Unit task done: ${c.title}.`
                    : c.status === "closed"
                      ? "We'll leave this task here."
                      : "Not there yet on this task."}
                </span>{" "}
                {c.status === "passed"
                  ? "You used the ideas together, which is the real test."
                  : c.status === "closed"
                    ? "You've had a few goes. The course moves on, and your report says what to look at again."
                    : c.reopened.length > 0
                      ? "The parts that were missing go back on your list first, then you get a new task."
                      : "You get a fresh task next lesson."}
              </p>
            </li>
          );
        if (c.type === "subject_complete")
          return (
            <li key={i} className="study-in flex items-start gap-3 rounded-2xl border border-[var(--st-good-border)] bg-[var(--st-good-bg)] p-3.5" data-change="subject_complete">
              <span aria-hidden className="study-pop flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--st-good)] text-white">
                <PartyPopper className="h-4 w-4" />
              </span>
              <p className="text-[15px] font-semibold text-[var(--text)]">That's the whole subject. Your report is ready.</p>
            </li>
          );
        return null;
      })}
    </ul>
  );
}

function BigTick({ icon }: { icon?: React.ReactNode }) {
  return (
    <span className="relative mx-auto mb-4 flex h-20 w-20 items-center justify-center" aria-hidden>
      <span className="study-burst absolute inset-0 rounded-full bg-[var(--st-accent)]" />
      <span className="study-pop relative flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white">{icon ?? <Check className="h-9 w-9" />}</span>
    </span>
  );
}

function ReviewDone({ summary, onBack, backWords }: { summary: ReviewSummary | null; onBack: () => void; backWords: string }) {
  const n = summary?.reviewed ?? 0;
  return (
    <div className="study-in" data-testid="study-review-done">
      <div className="text-center">
        <BigTick />
        <h2 className="text-2xl font-semibold text-[var(--text)]">Review done</h2>
        <p className="mt-1 text-[15px] text-[var(--text-muted)]">
          {n === 0 ? "Nothing was answered this time." : `${summary?.remembered ?? 0} of ${n} remembered`}
          {summary && summary.left > 0 ? ` · ${summary.left} left for later` : ""}
        </p>
      </div>
      <div className="mt-6 flex flex-col gap-3">
        {summary && summary.reopened.length > 0 && (
          <SummaryList tone="warn" icon={<RotateCcw className="h-4 w-4" />} title="Going back on your list" items={summary.reopened} note="These have slipped, so your next lesson teaches them again. That's what reviews are for." />
        )}
        {summary && summary.slipped > 0 && summary.reopened.length === 0 && (
          <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-[15px] text-[var(--text)]">The ones you missed come back sooner, so they get another go.</p>
        )}
      </div>
      <div className="mt-6 flex justify-center">
        <Button size="lg" variant="primary" onClick={onBack}>
          {backWords}
        </Button>
      </div>
    </div>
  );
}

function PlacementDone({ summary, onGo }: { summary: PlacementSummary | null; onGo: () => void }) {
  const known = summary?.known ?? 0;
  const likely = summary?.likely ?? 0;
  return (
    <div className="study-in text-center" data-testid="study-placement-done">
      <BigTick />
      <h2 className="text-2xl font-semibold text-[var(--text)]">Your course is set</h2>
      <p className="mx-auto mt-2 max-w-sm text-[15px] text-[var(--text-muted)]">
        {known > 0
          ? `You already know ${known} of the ${summary?.total} ideas, so ${known === 1 ? "that one is" : "those are"} skipped.`
          : "We'll start from the beginning, which is exactly the right place."}
        {likely > 0 && ` ${likely} more look familiar, so we'll move through ${likely === 1 ? "it" : "them"} quickly.`}
      </p>
      <Button variant="primary" size="lg" className="mt-6" onClick={onGo} rightIcon={<ArrowRight className="h-4 w-4" />}>
        See your map
      </Button>
    </div>
  );
}

function LessonDone({
  summary,
  history,
  onMap,
  onMore,
  onReport,
  starting,
  error,
}: {
  summary: LessonSummary | null;
  history: Step[];
  onMap: () => void;
  onMore: () => void;
  onReport: () => void;
  starting: boolean;
  error: string | null;
}) {
  const graded = summary?.graded ?? history.filter((s) => s.grade).length;
  const correct = summary?.correct ?? history.filter((s) => s.grade?.outcome === "correct").length;
  const complete = summary?.subject_complete === true;
  return (
    <div className="study-in" data-testid="study-lesson-done">
      <div className="text-center">
        <BigTick icon={complete ? <PartyPopper className="h-9 w-9" /> : undefined} />
        <h2 className="text-2xl font-semibold text-[var(--text)]">{complete ? "You've finished the subject" : "Lesson done"}</h2>
        <p className="mt-1 text-[15px] text-[var(--text-muted)]">
          {graded > 0 ? `${correct} of ${graded} right` : "A short one"}
          {summary ? ` · ${summary.steps} ${summary.steps === 1 ? "step" : "steps"}` : ""}
        </p>
      </div>
      <div className="mt-6 flex flex-col gap-3">
        {summary && summary.mastered.length > 0 && (
          <SummaryList tone="good" icon={<Sparkles className="h-4 w-4" />} title={`Learned ${summary.mastered.length === 1 ? "this" : "these"}`} items={summary.mastered} />
        )}
        {summary?.capstones && summary.capstones.length > 0 && (
          <SummaryList
            tone={summary.capstones.every((c) => c.outcome === "correct") ? "good" : "warn"}
            icon={<ClipboardCheck className="h-4 w-4" />}
            title={summary.capstones.length === 1 ? "A task that put it together" : "Tasks that put it together"}
            items={summary.capstones.map((c) => `${c.scope === "final" ? "The final task" : c.title}: ${c.outcome === "correct" ? "done" : c.outcome === "partial" ? "partly there" : "another go to come"}`)}
          />
        )}
        {summary && summary.gaps_added.length > 0 && <SummaryList tone="gap" icon={<Plus className="h-4 w-4" />} title="Added to your map, to fill a gap" items={summary.gaps_added} />}
        {summary && summary.parked.length > 0 && <SummaryList tone="warn" icon={<RotateCcw className="h-4 w-4" />} title="Put aside for next time" items={summary.parked} note="These were hard going. A fresh start next time usually does it." />}
        {summary?.next && !complete && (
          <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-[15px] text-[var(--text)]">
            <span className="text-[var(--text-muted)]">Next up: </span>
            <span className="font-medium">{summary.next}</span>
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--st-bad)]">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        {!complete && summary?.next && (
          <Button variant="primary" size="lg" onClick={onMore} loading={starting} rightIcon={<ArrowRight className="h-4 w-4" />}>
            Keep going
          </Button>
        )}
        {complete && (
          <Button variant="primary" size="lg" onClick={onReport} rightIcon={<ArrowRight className="h-4 w-4" />} data-testid="study-see-report">
            See your report
          </Button>
        )}
        <Button size="lg" variant={!complete && !summary?.next ? "primary" : "secondary"} onClick={onMap}>
          Back to the map
        </Button>
      </div>
    </div>
  );
}

function SummaryList({ tone, icon, title, items, note }: { tone: "good" | "gap" | "warn"; icon: React.ReactNode; title: string; items: string[]; note?: string }) {
  return (
    <section
      className={cn(
        "rounded-2xl border p-3.5",
        tone === "good" && "border-[var(--st-good-border)] bg-[var(--st-good-bg)]",
        tone === "gap" && "border-[var(--st-gap-border)] bg-[var(--st-gap-bg)]",
        tone === "warn" && "border-[var(--st-warn-border)] bg-[var(--st-warn-bg)]"
      )}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <span aria-hidden className={cn(tone === "good" && "text-[var(--st-good)]", tone === "gap" && "text-[var(--st-gap)]", tone === "warn" && "text-[var(--st-warn)]")}>
          {icon}
        </span>
        {title}
      </h3>
      <ul className="mt-1.5 flex flex-col gap-0.5 pl-6 text-[15px] text-[var(--text)]">
        {items.map((t, i) => (
          <li key={i} className="list-disc">
            {t}
          </li>
        ))}
      </ul>
      {note && <p className="mt-1.5 pl-6 text-sm text-[var(--text-muted)]">{note}</p>}
    </section>
  );
}
