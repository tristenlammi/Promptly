import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  MapPin,
  Plus,
  Users,
  Video,
  X,
} from "lucide-react";

import { emailApi, type CalendarEvent } from "@/api/email";
import { cn } from "@/utils/cn";

/**
 * Compact weekly calendar strip for the Email inbox (Phase 12 — E.3/E.4a).
 *
 * Shows upcoming events in a horizontal scroll strip. Also exposes a
 * "New event" form for creating events directly in Google Calendar.
 *
 * Accepts an optional ``prefill`` prop so the reading pane can pre-populate
 * the form when the user clicks "Add to calendar" on an email.
 */
interface NewEventPrefill {
  title: string;
  date: string;       // YYYY-MM-DD
  startTime: string;  // HH:MM
}

interface CalendarStripProps {
  prefill?: NewEventPrefill | null;
  onPrefillConsumed?: () => void;
}

export function CalendarStrip({ prefill, onPrefillConsumed }: CalendarStripProps) {
  const qc = useQueryClient();
  const { data: events = [], isLoading } = useQuery({
    queryKey: ["email", "calendar", "events"],
    queryFn: () => emailApi.listCalendarEvents(7),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  // Open form with prefill when parent provides one
  if (prefill && !formOpen) {
    setFormOpen(true);
    onPrefillConsumed?.();
  }

  const createMutation = useMutation({
    mutationFn: emailApi.createCalendarEvent,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email", "calendar", "events"] });
      setFormOpen(false);
    },
  });

  if (isLoading) return null;

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <Calendar className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="text-xs font-semibold text-[var(--text-muted)]">
            UPCOMING — next 7 days
          </span>
          {events.length > 0 && (
            <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
              {events.length}
            </span>
          )}
          <span className="text-[var(--text-muted)]">
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          title="New event"
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition",
            formOpen
              ? "bg-[var(--accent)]/10 text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          New event
        </button>
      </div>

      {/* New event form */}
      {formOpen && (
        <NewEventForm
          prefill={prefill}
          onSubmit={(data) => createMutation.mutate(data)}
          onClose={() => setFormOpen(false)}
          submitting={createMutation.isPending}
          error={createMutation.error instanceof Error ? createMutation.error.message : null}
        />
      )}

      {/* Event chips */}
      {!collapsed && events.length > 0 && (
        <div className="promptly-scroll flex gap-2 overflow-x-auto px-4 pb-2">
          {events.map((ev) => (
            <EventChip
              key={ev.id}
              event={ev}
              expanded={expandedId === ev.id}
              onToggle={() => setExpandedId((prev) => (prev === ev.id ? null : ev.id))}
            />
          ))}
        </div>
      )}

      {!collapsed && events.length === 0 && !formOpen && (
        <p className="px-4 pb-2 text-xs text-[var(--text-muted)]">
          No upcoming events — your calendar will appear here once synced.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ //
// New event form                                                       //
// ------------------------------------------------------------------ //

function NewEventForm({
  prefill,
  onSubmit,
  onClose,
  submitting,
  error,
}: {
  prefill?: NewEventPrefill | null;
  onSubmit: (data: {
    title: string;
    start_at: string;
    end_at: string;
    all_day: boolean;
    location?: string;
  }) => void;
  onClose: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [date, setDate] = useState(prefill?.date ?? today);
  const [startTime, setStartTime] = useState(prefill?.startTime ?? "09:00");
  const [endTime, setEndTime] = useState(() => {
    if (prefill?.startTime) {
      const [h, m] = prefill.startTime.split(":").map(Number);
      const end = new Date(0, 0, 0, h + 1, m);
      return `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    }
    return "10:00";
  });
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    let start_at: string;
    let end_at: string;

    if (allDay) {
      start_at = `${date}T00:00:00Z`;
      end_at = `${date}T23:59:59Z`;
    } else {
      start_at = `${date}T${startTime}:00Z`;
      end_at = `${date}T${endTime}:00Z`;
    }

    onSubmit({
      title: title.trim(),
      start_at,
      end_at,
      all_day: allDay,
      location: location.trim() || undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-[var(--border)] bg-[var(--bg)] px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-muted)]">New event</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {/* Title — full width */}
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event title"
          required
          className="col-span-2 rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />

        {/* Date */}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
          className="rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />

        {/* All-day toggle */}
        <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          All day
        </label>

        {/* Times — hidden when all-day */}
        {!allDay && (
          <>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </>
        )}

        {/* Location — full width */}
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location (optional)"
          className="col-span-2 rounded-input border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
      </div>

      {error && (
        <p className="mt-1.5 text-xs text-red-500">{error}</p>
      )}

      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Calendar className="h-3 w-3" />
          )}
          {submitting ? "Creating…" : "Create event"}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ //
// Event chip                                                           //
// ------------------------------------------------------------------ //

function EventChip({
  event,
  expanded,
  onToggle,
}: {
  event: CalendarEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const start = event.start_at ? new Date(event.start_at) : null;
  const end = event.end_at ? new Date(event.end_at) : null;

  const dayStr = start
    ? start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
    : "";
  const timeStr = start && !event.all_day
    ? start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "All day";
  const endTimeStr = end && !event.all_day
    ? end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const isNow =
    start && end ? start <= new Date() && new Date() <= end : false;

  const otherAttendees = event.attendees.filter((a) => !a.self);

  return (
    <div
      className={cn(
        "shrink-0 rounded-lg border transition-all",
        isNow
          ? "border-[var(--accent)]/50 bg-[var(--accent)]/5"
          : "border-[var(--border)] bg-[var(--bg)]",
        expanded ? "w-64" : "w-44"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left"
      >
        <div className="flex w-full items-center gap-1.5">
          {isNow && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">
            {event.title || "(No title)"}
          </span>
          {event.meet_link && (
            <Video className="h-3 w-3 shrink-0 text-[var(--accent)]" />
          )}
        </div>
        <span className="text-[10px] text-[var(--text-muted)]">
          {dayStr} · {timeStr}
          {endTimeStr && ` – ${endTimeStr}`}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]">
          {event.location && (
            <p className="flex items-start gap-1 truncate">
              <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
              {event.location}
            </p>
          )}
          {otherAttendees.length > 0 && (
            <p className="mt-1 flex items-start gap-1">
              <Users className="mt-0.5 h-3 w-3 shrink-0" />
              {otherAttendees
                .slice(0, 3)
                .map((a) => a.name || a.email)
                .join(", ")}
              {otherAttendees.length > 3 && ` +${otherAttendees.length - 3}`}
            </p>
          )}
          {event.meet_link && (
            <a
              href={event.meet_link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 flex items-center gap-1 text-[var(--accent)] hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <Video className="h-3 w-3" />
              Join meeting
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
