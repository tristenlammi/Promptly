import { CalendarRange, List, ListTodo, Plus, Settings2, Sun } from "lucide-react";

import type { ItemModule } from "@/items/types";

import { ListsView } from "./ListsView";
import { requestQuickAdd } from "./parts";
import { SettingsView } from "./SettingsView";
import { TodayView } from "./TodayView";
import type { TasksData } from "./types";
import { UpcomingView } from "./UpcomingView";

/*
 * Tasks & reminders — Today (overdue + today + done today), Upcoming (two
 * weeks day by day, then by month, then undated), Lists (each list in your
 * own order, High priority, Completed, search) and Settings. Quick add
 * parses plain words (./quickadd); repeats roll forward client-side
 * (./recur, a mirror of the backend's), so ticking off works offline.
 */
const module: ItemModule<TasksData> = {
  kind: "tasks",
  icon: ListTodo,
  tabs: [
    { id: "today", label: "Today", icon: Sun, View: TodayView },
    { id: "upcoming", label: "Upcoming", icon: CalendarRange, View: UpcomingView },
    { id: "lists", label: "Lists", icon: List, View: ListsView },
    { id: "settings", label: "Settings", icon: Settings2, View: SettingsView },
  ],
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "New task",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            if (!requestQuickAdd()) goTo("today");
          },
        }
      : null,
};

export default module;
