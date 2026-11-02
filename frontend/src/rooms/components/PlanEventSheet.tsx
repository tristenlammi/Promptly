import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { CalUser } from "@/api/calendar";
import type { RoomUser } from "@/api/rooms";
import { EventEditor, type EditorTarget } from "@/calendar/components/EventEditor";
import { useBootstrap } from "@/calendar/data";
import { toast } from "@/store/toastStore";

/**
 * "Plan an event" from a room: the Calendar's own event editor in room mode.
 * Everyone in the room is invited, and the event's card is posted here (the
 * server does both on create). Waits for the calendar bootstrap, which the
 * editor needs for the calendars list.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  /** ``name`` as people read it: "#general", or a DM's title. */
  room: { id: string; name: string };
  members: RoomUser[];
  meId: string;
}

export function PlanEventSheet(props: Props) {
  // Mounted only while open, so a room view doesn't fetch the calendar for nothing.
  if (!props.open) return null;
  return <PlanEvent {...props} />;
}

function PlanEvent({ open, onClose, room, members, meId }: Props) {
  const qc = useQueryClient();
  const boot = useBootstrap();

  useEffect(() => {
    if (open && boot.isError) {
      toast.error("Couldn't open the calendar. Try again.");
      onClose();
    }
  }, [open, boot.isError, onClose]);

  // Fixed when it opens: the next whole hour, an hour long.
  const target = useMemo<EditorTarget | null>(() => {
    if (!open) return null;
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    // Rooms' and Calendar's people are the same shape.
    const guests: CalUser[] = members.filter((u) => u.id !== meId).map((u) => ({ id: u.id, username: u.username, avatar_url: u.avatar_url, color: u.color }));
    return { mode: "new", start, allDay: false, prefill: { room, guests } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !boot.data) return null;
  return (
    <EventEditor
      target={target}
      b={boot.data}
      onClose={onClose}
      onSaved={() => {
        void qc.invalidateQueries({ queryKey: ["calendar", "room-upcoming", room.id] });
        onClose();
      }}
    />
  );
}
