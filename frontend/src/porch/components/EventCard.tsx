import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CalendarX2, Check, HelpCircle, MapPin, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { calendarApi } from "@/api/calendar";
import { porchApi, type PorchPost, type PostEvent } from "@/api/porch";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { putPost } from "../cache";

type Live = Extract<PostEvent, { cancelled: false }>;

function parseDay(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** "Saturday 14 Nov · 2:00 – 5:00 pm", "All day", in your own time zone. */
function whenLine(ev: Live): string {
  if (ev.all_day) {
    const s = parseDay(ev.start);
    const e = parseDay(ev.end);
    const day = s.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    if (s.getTime() === e.getTime()) return `${day} · All day`;
    return `${day} – ${e.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
  }
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const day = s.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = s.toDateString() === e.toDateString();
  return `${day} · ${t(s)} – ${sameDay ? t(e) : `${e.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${t(e)}`}`;
}

/** "Mum, Sam and 4 others are going". */
function goingLine(ev: Live): string | null {
  const names = ev.going.map((u) => u.name.split(" ")[0]);
  const n = ev.going_count;
  if (!n) return ev.maybe_count ? `${ev.maybe_count} maybe` : null;
  const shown = names.slice(0, 2);
  const others = n - shown.length;
  const who = others > 0 ? `${shown.join(", ")} and ${others} ${others === 1 ? "other" : "others"}` : shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0];
  return `${who} ${n === 1 ? "is" : "are"} going${ev.maybe_count ? ` · ${ev.maybe_count} maybe` : ""}`;
}

const ANSWERS = [
  { status: "going", label: "Going", icon: Check },
  { status: "maybe", label: "Maybe", icon: HelpCircle },
  { status: "declined", label: "Can't go", icon: X },
] as const;

/**
 * A post's event (WP-P3.2): date block, title, time, place (opens P Maps),
 * who's going, Going · Maybe · Can't go, and Open in Calendar — read live
 * from the event. Anyone who can see the post can answer, and answering
 * puts it on their calendar. Once the event's deleted: "Cancelled: …".
 */
export function EventCard({ post, className }: { post: PorchPost; className?: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const ev = post.event;
  if (!ev) return null;
  if (ev.cancelled) {
    return (
      <div className={cn("mx-4 flex items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] px-3 py-3 text-sm text-[var(--text-muted)] md:mx-0", className)}>
        <CalendarX2 className="h-5 w-5 shrink-0" aria-hidden />
        <span>
          <b className="font-semibold text-[var(--text)]">Cancelled:</b> {ev.title}
        </span>
      </div>
    );
  }
  const start = ev.all_day ? parseDay(ev.start) : new Date(ev.start);
  const answer = async (status: "going" | "maybe" | "declined") => {
    setBusy(status);
    try {
      await calendarApi.rsvp(ev.event_id, status);
      putPost(qc, post.id, await porchApi.post(post.id));
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      void qc.invalidateQueries({ queryKey: ["porch", "group-events"] });
      toast.success(status === "declined" ? "Answered: can't go." : ev.my_status || ev.invited ? "Answer saved." : "Answered. It's in your calendar now.");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save your answer. Try again."));
    } finally {
      setBusy(null);
    }
  };
  const going = goingLine(ev);
  return (
    <section
      aria-label={`Event: ${ev.title}`}
      data-event-card={ev.event_id}
      className={cn("mx-4 flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-1,var(--surface))] p-3 md:mx-0", className)}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_14%,var(--surface))] text-[var(--text)]"
          aria-hidden
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text)]">{start.toLocaleDateString(undefined, { month: "short" })}</span>
          <span className="text-xl font-bold leading-none">{start.getDate()}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-[var(--text)]">{ev.title}</p>
          <p className="text-sm text-[var(--text-muted)]">
            {ev.past ? "Was " : ""}
            {whenLine(ev)}
            {ev.repeats ? " · repeats" : ""}
          </p>
          {ev.location && (
            <Link to={`/maps?q=${encodeURIComponent(ev.location)}`} className="mt-0.5 inline-flex max-w-full items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
              <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{ev.location}</span>
            </Link>
          )}
          {going && <p className="mt-0.5 text-sm text-[var(--text)]">{going}</p>}
        </div>
      </div>
      {!ev.past && !ev.organiser && (
        <div role="group" aria-label="Your answer" className="grid grid-cols-3 gap-2">
          {ANSWERS.map(({ status, label, icon: Icon }) => {
            const on = ev.my_status === status;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                disabled={!!busy}
                onClick={() => void answer(status)}
                className={cn(
                  "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:opacity-60",
                  on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
      )}
      {ev.organiser && !ev.past && <p className="text-xs text-[var(--text-muted)]">You're organising this. People answer here or in their calendar.</p>}
      <Link
        to={`/calendar/?event=${ev.event_id}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-[var(--accent-text)] hover:underline"
      >
        <CalendarDays className="h-4 w-4" aria-hidden /> Open in Calendar
      </Link>
    </section>
  );
}
