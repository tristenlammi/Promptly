import { CalendarDays, Dumbbell, History as HistoryIcon, LineChart, Play } from "lucide-react";

import type { ItemModule } from "@/items/types";

import { History } from "./History";
import { Plan } from "./Plan";
import { Onboarding } from "./Profile";
import { Progress } from "./Progress";
import { Today, startWorkout, todaysSession } from "./Today";
import type { WorkoutData } from "./types";

/*
 * Workout — a Strong/Hevy-style strength log with an AI coach. Works offline:
 * the exercise library is bundled (catalogData.ts) and history is in the file.
 * Today: the day's session and the live logger (the in-progress workout is
 * kept in the file, so it survives reloads). Plan: the week, programs and
 * routines with a session editor. History: calendar + every set, editable.
 * Progress: e1RM charts, PRs, weekly sets per muscle vs landmarks.
 */
const module: ItemModule<WorkoutData> = {
  kind: "workout",
  icon: Dumbbell,
  tabs: [
    { id: "today", label: "Today", icon: Dumbbell, View: Today },
    { id: "plan", label: "Plan", icon: CalendarDays, View: Plan },
    { id: "history", label: "History", icon: HistoryIcon, View: History },
    { id: "progress", label: "Progress", icon: LineChart, View: Progress },
  ],
  primaryAction: (item, { goTo }) => {
    if (!item.canEdit || item.data.active) return null;
    const session = todaysSession(item.data);
    return {
      label: session ? `Start ${session.name}` : "Start workout",
      icon: <Play className="h-4 w-4" />,
      onClick: () => {
        startWorkout(item, { session });
        goTo("today");
      },
    };
  },
  needsOnboarding: (d) => !d.settings?.onboarded && !d.workouts?.length && !d.planned?.length && !d.active,
  Onboarding,
};

export default module;
