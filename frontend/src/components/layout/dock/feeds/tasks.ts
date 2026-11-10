import { useQueryClient } from "@tanstack/react-query";
import { Bell, Check } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { TodayTask } from "@/api/today";
import { itemsApi } from "@/items/api";
import { toast } from "@/store/toastStore";

import type { DockCardData, DockFeed } from "../types";
import { go, useDockToday } from "../useDockToday";
import { useNow } from "../useNow";

const SOON_MIN = 120;

/** The date, and minutes since midnight, in the person's own time zone. */
function nowIn(tz: string, now: number): { date: string; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  } catch {
    return null;
  }
}

function minutesOf(time: string | null): number | null {
  const m = time ? /^(\d{1,2}):(\d{2})/.exec(time) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function label(minutes: number): string {
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Tasks & Reminders: the next reminder due today, when it's within about
 *  two hours (or already past its time), with a tick to finish it. */
function useCards(): DockCardData[] {
  const today = useDockToday();
  const now = useNow();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tasks = today?.sections.tasks;
  if (!today || !tasks) return [];
  const here = nowIn(today.tz, now);
  if (!here) return [];

  const timed: { t: TodayTask; at: number }[] = [];
  for (const t of tasks.today) {
    const at = minutesOf(t.time);
    if (at !== null && (!t.due || t.due.slice(0, 10) === here.date) && at - here.minutes <= SOON_MIN) timed.push({ t, at });
  }
  const next = timed.sort((a, b) => a.at - b.at)[0];
  if (!next) return [];

  const away = next.at - here.minutes;
  const when = away < 0 ? `Was due at ${label(next.at)}` : away === 0 ? "Due now" : away < 60 ? `Due in ${away} min` : `Due at ${label(next.at)}`;
  const fileId = tasks.file_id;
  const taskId = next.t.id;
  return [
    {
      id: `tasks:${taskId}`,
      priority: 40,
      icon: Bell,
      tone: away <= 0 ? "accent" : "plain",
      title: next.t.title || "Reminder",
      detail: when,
      onOpen: () => go(navigate, tasks.url, "/apps/tasks"),
      actions: [
        {
          id: "done",
          label: "Tick off",
          icon: Check,
          onClick: () => {
            void itemsApi
              .action(fileId, "complete_tasks", { tasks: [taskId] })
              .then(() => {
                toast.success("Ticked off");
                return qc.invalidateQueries({ queryKey: ["today"] });
              })
              .catch(() => toast.error("That didn't work. Try again."));
          },
        },
      ],
    },
  ];
}

export const tasksFeed: DockFeed = { id: "tasks", useCards };
