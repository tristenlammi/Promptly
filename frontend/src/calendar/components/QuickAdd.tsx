import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock, CornerDownLeft, Loader2, MapPin, Repeat as RepeatIcon, SlidersHorizontal, Sparkles, UserRound } from "lucide-react";
import { forwardRef, useEffect, useMemo, useState, type ReactNode } from "react";

import { calendarApi, type CalEvent, type CalendarBootstrap, type CalUser } from "@/api/calendar";
import { roomsApi } from "@/api/rooms";
import { extractError } from "@/components/files/helpers";
import { ItemButton, Sheet, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { addUsers, useCalUsers, useRefreshEvents } from "../data";
import { addDays, localZone, shortDay, shortTime, timeRange, ymd } from "../dates";
import { describeRepeat } from "../model";
import { parseEvent, type QuickEvent } from "../quickadd";

const PLACEHOLDER = "Add an event — e.g. Lunch with Sam tomorrow 1pm";

/** What quick add understood from ``text`` (null while it's empty). */
function useQuickParse(text: string, b: CalendarBootstrap): QuickEvent | null {
  const calUsers = useCalUsers((s) => s.users);
  // Everyone on the server, once someone is named ("with …").
  const wantsPeople = /\bwith\s+\S/i.test(text);
  const { data: people } = useQuery({ queryKey: ["rooms", "people", ""], queryFn: () => roomsApi.people(""), staleTime: 60_000, enabled: wantsPeople });
  const users = useMemo(() => {
    const m = new Map<string, CalUser>();
    for (const u of [...Object.values(b.users), ...Object.values(calUsers), ...(people ?? [])]) m.set(u.id, u);
    return [...m.values()];
  }, [b.users, calUsers, people]);
  return useMemo(() => (text.trim() ? parseEvent(text, { users, meId: b.me.id }) : null), [text, users, b.me.id]);
}

/** "Fri 6 Nov, 7pm" / "Fri 6 Nov". */
export function quickWhen(q: { allDay: boolean; start: Date }): string {
  return q.allDay ? shortDay(q.start) : `${shortDay(q.start)}, ${shortTime(q.start)}`;
}

/** Make the event on my personal calendar (the server adds my default reminders). */
async function createQuick(q: QuickEvent, b: CalendarBootstrap): Promise<CalEvent> {
  const personal = b.calendars.find((c) => c.personal) ?? null;
  const r = await calendarApi.create({
    title: q.title,
    all_day: q.allDay,
    ...(q.allDay ? { start: ymd(q.start), end: ymd(addDays(q.end, -1)) } : { start: q.start.toISOString(), end: q.end.toISOString() }),
    tz: localZone(),
    calendar_id: personal?.id ?? null,
    repeat: q.repeat,
    location: q.location,
    guests: q.guests.map((g) => g.id),
  });
  addUsers(r.users);
  return r.event;
}

/** The understood bits, as small chips. */
function QuickPreview({ q, className }: { q: QuickEvent; className?: string }) {
  const chip = (icon: ReactNode, text: string, key: string, muted = false) => (
    <span
      key={key}
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        muted ? "border-dashed border-[var(--border)] text-[var(--text-muted)]" : "border-[color-mix(in_srgb,var(--item-accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--item-accent)_9%,var(--surface))] text-[var(--text)]",
      )}
    >
      <span className="shrink-0 text-[var(--item-accent)]">{icon}</span>
      <span className="truncate">{text}</span>
    </span>
  );
  const allDayLast = addDays(q.end, -1);
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {chip(<CalendarDays className="h-3.5 w-3.5" />, q.allDay && allDayLast > q.start ? `${shortDay(q.start)} – ${shortDay(allDayLast)}` : shortDay(q.start), "d", !q.saw.date)}
      {chip(<Clock className="h-3.5 w-3.5" />, q.allDay ? "All day" : timeRange(q.start, q.end), "t", !q.saw.time && !q.allDay)}
      {q.repeat && chip(<RepeatIcon className="h-3.5 w-3.5" />, describeRepeat(q.repeat, q.start), "r")}
      {q.location && chip(<MapPin className="h-3.5 w-3.5" />, q.location, "l")}
      {q.guests.map((g) => chip(<UserRound className="h-3.5 w-3.5" />, g.username, `g${g.id}`))}
    </div>
  );
}

function useQuickAdd(b: CalendarBootstrap, onOpen: (ev: CalEvent) => void, done?: () => void) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const q = useQuickParse(text, b);
  const refresh = useRefreshEvents();
  const submit = async () => {
    if (!q || saving) return;
    if (!q.title) {
      toast.error("Give the event a title.");
      return;
    }
    setSaving(true);
    try {
      const ev = await createQuick(q, b);
      refresh();
      setText("");
      toast.success(`Added · ${quickWhen(q)}${q.guests.length ? " — guests invited" : ""}`, { action: { label: "Open", onClick: () => onOpen(ev) } });
      done?.();
    } catch (err) {
      toast.error(extractError(err) || "Couldn't add the event.");
    } finally {
      setSaving(false);
    }
  };
  return { text, setText, q, saving, submit };
}

/** Desktop: the quick-add box in the header, with what it understood below. */
export const QuickAddBar = forwardRef<
  HTMLInputElement,
  { b: CalendarBootstrap; onOpen: (ev: CalEvent) => void; onMore: (q: QuickEvent | null, text: string) => void; className?: string }
>(function QuickAddBar({ b, onOpen, onMore, className }, ref) {
  const { text, setText, q, saving, submit } = useQuickAdd(b, onOpen);
  const [focused, setFocused] = useState(false);
  const show = focused && !!q;
  return (
    <div className={cn("relative", className)}>
      <div className="relative">
        <Sparkles className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--item-accent)]" />
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              if (text) setText("");
              else e.currentTarget.blur();
            }
          }}
          placeholder={PLACEHOLDER}
          aria-label="Quick add an event"
          title="Quick add (q)"
          maxLength={300}
          className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)]"
        />
        {saving && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--text-muted)]" />}
      </div>
      {show && q && (
        <div
          // Clicks in here mustn't blur the box first.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-full z-40 mt-1.5 flex flex-col gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-3 shadow-[var(--shadow-lg)] animate-[fadeIn_100ms_ease-out]"
        >
          <div className="truncate text-sm font-semibold text-[var(--text)]">{q.title || <span className="font-normal text-[var(--text-muted)]">Add a title…</span>}</div>
          <QuickPreview q={q} />
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2.5">
            <button
              type="button"
              onClick={() => {
                onMore(q, text);
                setText("");
              }}
              className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              More options
            </button>
            <ItemButton size="sm" variant="primary" disabled={!q.title || saving} onClick={() => void submit()} icon={<CornerDownLeft className="h-3.5 w-3.5" />}>
              Add
            </ItemButton>
          </div>
        </div>
      )}
    </div>
  );
});

/** Phone (and narrow desktop): a compact sheet with the box focused. */
export function QuickAddSheet({
  open,
  onClose,
  b,
  onOpen,
  onMore,
}: {
  open: boolean;
  onClose: () => void;
  b: CalendarBootstrap;
  onOpen: (ev: CalEvent) => void;
  onMore: (q: QuickEvent | null, text: string) => void;
}) {
  const { text, setText, q, saving, submit } = useQuickAdd(b, onOpen, onClose);
  useEffect(() => {
    if (!open) setText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New event"
      size="sm"
      footer={
        <>
          <ItemButton
            block
            icon={<SlidersHorizontal className="h-4 w-4" />}
            onClick={() => {
              onClose();
              onMore(q, text);
            }}
          >
            More options
          </ItemButton>
          <ItemButton block variant="primary" disabled={!q?.title || saving} onClick={() => void submit()}>
            {saving ? "Adding…" : "Add"}
          </ItemButton>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextInput
          data-autofocus
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Dinner with Sam Fri 7–9pm"
          aria-label="Quick add an event"
          enterKeyHint="done"
          maxLength={300}
          className="!h-12 !text-base"
        />
        {q ? (
          <QuickPreview q={q} />
        ) : (
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">Type it how you'd say it — the day, a time like “7–9pm”, “every Monday”, “at Mum's”, “with Sam”.</p>
        )}
      </form>
    </Sheet>
  );
}
