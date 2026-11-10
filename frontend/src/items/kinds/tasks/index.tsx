import { CalendarRange, List, ListTodo, Plus, Settings2, Sun } from "lucide-react";
import type { ComponentType } from "react";
import { useSearchParams } from "react-router-dom";

import type { ItemModule, ItemViewProps } from "@/items/types";

import "./tasks.css";

import { ListsView } from "./ListsView";
import { requestQuickAdd } from "./parts";
import { SettingsView } from "./SettingsView";
import { TaskEditor } from "./TaskEditor";
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
/** ``?task=<id>`` — a link or mention opening one task, on any tab. */
function withLinkedTask(View: ComponentType<ItemViewProps<TasksData>>) {
  return function TasksTab(props: ItemViewProps<TasksData>) {
    const [params, setParams] = useSearchParams();
    const linked = params.get("task");
    const close = () => {
      const next = new URLSearchParams(params);
      next.delete("task");
      setParams(next, { replace: true });
    };
    return (
      <>
        <View {...props} />
        {linked && <TaskEditor item={props.item} taskId={linked} onClose={close} />}
      </>
    );
  };
}

const module: ItemModule<TasksData> = {
  kind: "tasks",
  icon: ListTodo,
  tabs: [
    { id: "today", label: "Today", icon: Sun, View: withLinkedTask(TodayView) },
    { id: "upcoming", label: "Upcoming", icon: CalendarRange, View: withLinkedTask(UpcomingView) },
    { id: "lists", label: "Lists", icon: List, View: withLinkedTask(ListsView) },
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
