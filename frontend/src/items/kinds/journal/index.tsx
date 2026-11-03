import { BarChart3, BookOpen, CalendarDays, PenLine, Sun } from "lucide-react";
import type { ComponentType } from "react";
import { useSearchParams } from "react-router-dom";

import type { ItemModule, ItemViewProps } from "@/items/types";

import { CalendarView } from "./CalendarView";
import { EditorHost } from "./Editor";
import { ReaderSheet } from "./EntryViews";
import { InsightsView } from "./Insights";
import { Onboarding } from "./Onboarding";
import { editor } from "./store";
import { TimelineView } from "./Timeline";
import { TodayView } from "./Today";
import type { JournalData } from "./types";

/*
 * Journal — replaces Day One, Journey and Reflectly. Tabs: Today (write,
 * check in, prompt of the day, streak, On this day), Timeline (search,
 * filters, reading pane on desktop), Calendar (mood month grid) and
 * Insights. The writing room (``Editor``) is an overlay any tab — or the
 * header's "Write" button — can open.
 */

function withEditor(View: ComponentType<ItemViewProps<JournalData>>) {
  return function JournalTab(props: ItemViewProps<JournalData>) {
    // ``?entry=<id>`` — a mention or a link opening one entry.
    const [params, setParams] = useSearchParams();
    const linked = params.get("entry");
    const closeLinked = () => {
      const next = new URLSearchParams(params);
      next.delete("entry");
      setParams(next, { replace: true });
    };
    return (
      <>
        <View {...props} />
        <EditorHost item={props.item} isPhone={props.isPhone} />
        {linked && <ReaderSheet entryId={linked} onClose={closeLinked} item={props.item} ask={props.ask} />}
      </>
    );
  };
}

const module: ItemModule<JournalData> = {
  kind: "journal",
  tabs: [
    { id: "today", label: "Today", icon: Sun, View: withEditor(TodayView) },
    { id: "timeline", label: "Timeline", icon: BookOpen, View: withEditor(TimelineView) },
    { id: "calendar", label: "Calendar", icon: CalendarDays, View: withEditor(CalendarView) },
    { id: "insights", label: "Insights", icon: BarChart3, View: withEditor(InsightsView) },
  ],
  primaryAction: (h) => (h.canEdit ? { label: "Write", icon: <PenLine className="h-4 w-4" />, onClick: () => editor.open() } : null),
  needsOnboarding: (d) => !d?.settings?.onboarded && !(d?.entries?.length),
  Onboarding,
};

export default module;
