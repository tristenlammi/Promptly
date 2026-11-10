import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { CalUser } from "@/api/calendar";
import { porchApi, type PorchGroup } from "@/api/porch";
import { EventEditor, type EditorTarget } from "@/calendar/components/EventEditor";
import { useBootstrap } from "@/calendar/data";
import { toast } from "@/store/toastStore";

import { LISTS, groupEventsKey, membersKey } from "../cache";

/**
 * "Plan an event in a group" (WP-P3.2): the Calendar's own event editor in
 * group mode. It goes in your calendar, the group is invited (on by default
 * for your own groups, off for Everyone — decision E1), and a post in the
 * group carries its card, which anyone in the group can answer.
 */
export function PlanGroupEventSheet({
  group,
  open,
  onClose,
  body,
  onPosted,
}: {
  group: Pick<PorchGroup, "id" | "name" | "kind" | "member_count">;
  open: boolean;
  onClose: () => void;
  /** Words for the post (from the composer). */
  body?: string;
  onPosted?: (postId: string) => void;
}) {
  if (!open) return null;
  return <Plan group={group} onClose={onClose} body={body} onPosted={onPosted} />;
}

function Plan({ group, onClose, body, onPosted }: { group: Pick<PorchGroup, "id" | "name" | "kind" | "member_count">; onClose: () => void; body?: string; onPosted?: (postId: string) => void }) {
  const qc = useQueryClient();
  const boot = useBootstrap();
  const everyone = group.kind === "everyone";
  // Everyone's members aren't listed one by one; the toggle still says how many.
  const members = useQuery({ queryKey: membersKey(group.id), queryFn: () => porchApi.members(group.id), staleTime: 30_000, enabled: !everyone });

  useEffect(() => {
    if (boot.isError) {
      toast.error("Couldn't open the calendar. Try again.");
      onClose();
    }
  }, [boot.isError, onClose]);

  const target = useMemo<EditorTarget | null>(() => {
    if (!everyone && !members.data) return null;
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const people: CalUser[] = (members.data ?? []).map((m) => ({ id: m.id, username: m.name || m.username, avatar_url: m.avatar_url, color: m.color }));
    return {
      mode: "new",
      start,
      allDay: false,
      prefill: {
        porchGroup: {
          id: group.id,
          name: group.name,
          members: people,
          count: group.member_count,
          inviteAll: !everyone,
          body,
          onPosted: (postId) => {
            void qc.invalidateQueries({ queryKey: LISTS });
            void qc.invalidateQueries({ queryKey: groupEventsKey(group.id) });
            onPosted?.(postId);
          },
        },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.data, everyone]);

  if (!boot.data || !target) return null;
  return <EventEditor target={target} b={boot.data} onClose={onClose} onSaved={onClose} />;
}
