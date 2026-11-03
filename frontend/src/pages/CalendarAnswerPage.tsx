import { CalendarDays, Check, Clock, HelpCircle, Loader2, MapPin, Repeat, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import type { RsvpStatus } from "@/api/calendar";
import { inviteAnswerApi, type InviteAnswer } from "@/api/calendarReach";

type Answer = Exclude<RsvpStatus, "invited">;

const CHOICES: { value: Answer; label: string; icon: typeof Check }[] = [
  { value: "going", label: "Going", icon: Check },
  { value: "maybe", label: "Maybe", icon: HelpCircle },
  { value: "declined", label: "Can't go", icon: X },
];

const SAID: Record<Answer, string> = {
  going: "You're going — the organiser has been told.",
  maybe: "You said maybe — the organiser has been told.",
  declined: "You can't make it — the organiser has been told.",
};

/** The page an emailed invitation links to: someone without a Promptly
 *  account sees the event and answers Going / Maybe / Can't go. No sign-in
 *  — the link is the key. ``?a=going`` (the email's buttons) only
 *  pre-selects that answer: opening the page never records anything (email
 *  link scanners and prefetchers open links too) — the click does. */
export function CalendarAnswerPage() {
  const { token = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [inv, setInv] = useState<InviteAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Answer | null>(null);
  const [just, setJust] = useState<Answer | null>(null);
  const started = useRef(false);
  const preParam = params.get("a");
  const suggested = CHOICES.some((c) => c.value === preParam) ? (preParam as Answer) : null;

  const answer = async (a: Answer) => {
    setBusy(a);
    try {
      setInv(await inviteAnswerApi.answer(token, a));
      setJust(a);
      if (params.has("a")) setParams({}, { replace: true });
    } catch {
      setError("Couldn't save your answer. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        setInv(await inviteAnswerApi.get(token));
      } catch {
        setError("This invitation isn't available any more — the event may have been cancelled.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg)] px-4 py-10">
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        {!inv && !error && (
          <div className="flex justify-center py-10 text-[var(--text-muted)]">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {error && !inv && (
          <div className="py-6 text-center">
            <CalendarDays className="mx-auto mb-3 h-10 w-10 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text)]">{error}</p>
          </div>
        )}
        {inv && (
          <>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {inv.organiser ? `${inv.organiser} invited you` : "You're invited"}
            </p>
            <h1 className="mt-1 break-words text-xl font-semibold text-[var(--text)]">{inv.title}</h1>
            <div className="mt-4 flex flex-col gap-2.5 text-sm text-[var(--text)]">
              <p className="flex gap-2.5">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span>{inv.when}</span>
              </p>
              {inv.repeats && (
                <p className="flex gap-2.5 text-[var(--text-muted)]">
                  <Repeat className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Repeats</span>
                </p>
              )}
              {inv.location && (
                <p className="flex gap-2.5">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(inv.location)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-words text-[var(--accent)] hover:underline"
                  >
                    {inv.location}
                  </a>
                </p>
              )}
              {inv.description && <p className="whitespace-pre-wrap break-words text-[var(--text-muted)]">{inv.description}</p>}
            </div>

            {inv.over ? (
              <p className="mt-6 rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--text-muted)]">This event is over.</p>
            ) : (
              <div className="mt-6">
                <p className="mb-2 text-sm font-medium text-[var(--text)]">Will you come?</p>
                <div className="grid grid-cols-3 gap-2">
                  {CHOICES.map((c) => {
                    const active = inv.status === c.value;
                    // The email's link suggested this one — highlighted, not saved.
                    const pending = !active && !just && suggested === c.value;
                    const Icon = c.icon;
                    return (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => void answer(c.value)}
                        disabled={busy !== null}
                        aria-pressed={active}
                        className={`flex h-12 items-center justify-center gap-1.5 rounded-xl border text-sm font-medium transition disabled:opacity-60 ${
                          active
                            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text)]"
                            : pending
                              ? "border-dashed border-[var(--accent)] text-[var(--text)] ring-2 ring-[color-mix(in_srgb,var(--accent)_35%,transparent)] hover:bg-[var(--hover)]"
                              : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]"
                        }`}
                      >
                        {busy === c.value ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                        {c.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 min-h-5 text-sm text-[var(--text-muted)]" aria-live="polite">
                  {error
                    ? error
                    : just
                      ? SAID[just]
                      : suggested && inv.status !== suggested
                        ? `Tap ${CHOICES.find((c) => c.value === suggested)?.label} to send your answer.`
                        : inv.status !== "invited"
                          ? "You can change your answer any time."
                          : ""}
                </p>
              </div>
            )}
            <p className="mt-6 text-xs text-[var(--text-muted)]">Answering as {inv.email} · Sent from Promptly</p>
          </>
        )}
      </div>
    </div>
  );
}
