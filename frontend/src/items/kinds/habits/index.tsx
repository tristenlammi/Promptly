import { BarChart3, CircleCheckBig, ListChecks, NotebookPen, Plus } from "lucide-react";

import type { ItemModule } from "@/items/types";

import "./habits.css";
import { HabitsView } from "./HabitsView";
import { Onboarding } from "./Onboarding";
import { ReviewView } from "./ReviewView";
import { StatsView } from "./StatsView";
import { TodayView } from "./TodayView";
import type { HabitsData } from "./types";
import { requestNewHabit } from "./util";

/*
 * Habits — Today (check-off), Habits (manage + reorder + settings), Stats
 * (per-habit streaks, strength, heatmap, calendar) and Review (weekly).
 * Stats are computed client-side by ./engine (a mirror of the backend's).
 */
const module: ItemModule<HabitsData> = {
  kind: "habits",
  icon: CircleCheckBig,
  tabs: [
    { id: "today", label: "Today", icon: CircleCheckBig, View: TodayView },
    { id: "habits", label: "Habits", icon: ListChecks, View: HabitsView },
    { id: "stats", label: "Stats", icon: BarChart3, View: StatsView },
    { id: "review", label: "Review", icon: NotebookPen, View: ReviewView },
  ],
  // Every tab hosts the editor and listens (requestNewHabit); from the
  // phone's Ask tab, switch to Today, which opens it on mount.
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "New habit",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            if (!requestNewHabit()) goTo("today");
          },
        }
      : null,
  needsOnboarding: (d) => !d?.settings?.onboarded && !(d?.habits?.length > 0),
  Onboarding,
};

export default module;
