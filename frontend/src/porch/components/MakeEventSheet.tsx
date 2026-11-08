import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { CalUser } from "@/api/calendar";
import { porchApi, type PorchPost, type PorchUser } from "@/api/porch";
import { EventEditor, type EditorTarget } from "@/calendar/components/EventEditor";
import { useBootstrap } from "@/calendar/data";
import { addDays } from "@/calendar/dates";
import { parseEvent } from "@/calendar/quickadd";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * "Make this an event" on a post: the Calendar's own event editor, filled
 * in from the post — its words (a day or time in them is understood:
 * "BBQ Saturday 2pm"), its place, and a link back to it. You pick who to
 * invite, but only from the people who can see the post (the server holds
 * the same line). The event remembers the post ("From a Porch post"), which
 * only people who can see the post are shown.
 */
export function MakeEventSheet({ post, open, onClose }: { post: PorchPost; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <MakeEvent post={post} onClose={onClose} />;
}

const toCal = (u: PorchUser): CalUser => ({ id: u.id, username: u.name || u.username, avatar_url: u.avatar_url, color: u.color });

function MakeEvent({ post, onClose }: { post: PorchPost; onClose: () => void }) {
  const qc = useQueryClient();
  const boot = useBootstrap();
  const pre = useQuery({ queryKey: ["porch", "event-prefill", post.id], queryFn: () => porchApi.eventPrefill(post.id), staleTime: 0, retry: false });

  useEffect(() => {
    if (boot.isError || pre.isError) {
      toast.error(pre.isError ? apiErrorMessage(pre.error, "Couldn't open this post's event.") : "Couldn't open the calendar. Try again.");
      onClose();
    }
  }, [boot.isError, pre.isError, pre.error, onClose]);

  const target = useMemo<EditorTarget | null>(() => {
    const p = pre.data;
    if (!p) return null;
    const firstLine = p.title.trim();
    const q = parseEvent(firstLine);
    const understood = q.saw.date || q.saw.time;
    const link = `${window.location.origin}${p.url}`;
    const who = p.author ? `${p.author.name}'s` : "a";
    const description = [p.body, `From ${who} post on Porch: ${link}`].filter(Boolean).join("\n\n");
    let start: Date;
    let end: Date | undefined;
    let allDay = false;
    if (understood) {
      start = q.start;
      allDay = q.allDay;
      end = q.allDay ? addDays(q.end, -1) : q.end;
    } else {
      // The next whole hour, an hour long.
      start = new Date();
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() + 1);
    }
    const people = p.guests.map(toCal);
    return {
      mode: "new",
      start,
      allDay,
      prefill: {
        title: (understood ? q.title : firstLine) || firstLine || "Event",
        location: p.location || (understood ? q.location : ""),
        description,
        end,
        source: { kind: "porch_post", post_id: post.id },
        guestPool: {
          people,
          note:
            people.length > 0
              ? "You can invite the people who can see this post."
              : "Nobody else can see this post, so there's nobody to invite from it.",
        },
      },
    };
  }, [pre.data, post.id]);

  if (!boot.data || !target) return null;
  return (
    <EventEditor
      target={target}
      b={boot.data}
      onClose={onClose}
      onSaved={() => {
        void qc.invalidateQueries({ queryKey: ["calendar"] });
        onClose();
      }}
    />
  );
}
