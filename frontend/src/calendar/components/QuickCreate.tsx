import { useState } from "react";

import { calendarApi, type CalEvent, type CalendarBootstrap } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { ItemButton, Select, Sheet, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { addUsers, useRefreshEvents } from "../data";
import { addDays, localZone, shortDay, timeRange, ymd } from "../dates";
import { Popover } from "./ui";

/** A slot picked on the grid: ``end`` is exclusive (the day after, for all-day). */
export interface NewSlot {
  start: Date;
  end: Date;
  allDay: boolean;
  anchor: DOMRect | null;
}

/** What "More options" hands to the full editor. */
export interface SlotDraft {
  title: string;
  calendarId: string;
}

function slotWhen(s: NewSlot): string {
  if (!s.allDay) return `${shortDay(s.start)}, ${timeRange(s.start, s.end)}`;
  const last = addDays(s.end, -1);
  return last > s.start ? `${shortDay(s.start)} – ${shortDay(last)}` : `${shortDay(s.start)}, all day`;
}

/**
 * The small "what is it?" card beside a slot just clicked or drawn on the
 * grid: a title, the time, which calendar, and a way into the full editor.
 */
export function QuickCreate({
  slot,
  b,
  phone,
  onClose,
  onMore,
  onSaved,
}: {
  slot: NewSlot;
  b: CalendarBootstrap;
  phone: boolean;
  onClose: () => void;
  onMore: (slot: NewSlot, d: SlotDraft) => void;
  onSaved: (ev: CalEvent) => void;
}) {
  const writable = b.calendars.filter((c) => c.role === "owner" || c.role === "editor");
  const [title, setTitle] = useState("");
  const [calendarId, setCalendarId] = useState(() => b.calendars.find((c) => c.personal)?.id ?? writable[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const refresh = useRefreshEvents();

  const save = async () => {
    if (saving) return;
    if (!title.trim()) {
      toast.error("Give the event a title.");
      return;
    }
    setSaving(true);
    try {
      const r = await calendarApi.create({
        title: title.trim(),
        all_day: slot.allDay,
        ...(slot.allDay ? { start: ymd(slot.start), end: ymd(addDays(slot.end, -1)) } : { start: slot.start.toISOString(), end: slot.end.toISOString() }),
        tz: localZone(),
        calendar_id: calendarId || null,
      });
      addUsers(r.users);
      refresh();
      toast.success("Event saved", { action: { label: "Open", onClick: () => onSaved(r.event) } });
      onClose();
    } catch (err) {
      toast.error(extractError(err) || "Couldn't add the event.");
      setSaving(false);
    }
  };

  const form = (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextInput data-autofocus autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add title" aria-label="Title" maxLength={200} className="font-semibold" />
      <p className="text-sm text-[var(--text-muted)]">{slotWhen(slot)}</p>
      {writable.length > 1 && (
        <Select value={calendarId} onChange={(e) => setCalendarId(e.target.value)} aria-label="Calendar">
          {writable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.personal ? `${c.name} (personal)` : c.name}
            </option>
          ))}
        </Select>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        <ItemButton variant="ghost" onClick={() => onMore(slot, { title: title.trim(), calendarId })}>
          More options
        </ItemButton>
        <ItemButton variant="primary" type="submit" disabled={saving || !title.trim()}>
          {saving ? "Saving…" : "Save"}
        </ItemButton>
      </div>
    </form>
  );

  if (phone || !slot.anchor) {
    return (
      <Sheet open onClose={onClose} title="New event" size="sm">
        <div className="pb-2 pt-1">{form}</div>
      </Sheet>
    );
  }
  return (
    <Popover anchor={slot.anchor} onClose={onClose} width={320}>
      <div className="p-4">{form}</div>
    </Popover>
  );
}
