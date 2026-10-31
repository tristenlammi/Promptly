import { ClipboardList, HeartPulse, LineChart, Pill, Plus } from "lucide-react";

import type { ItemModule } from "@/items/types";

import { MedsView } from "./MedsTab";
import { Onboarding } from "./Onboarding";
import { openQuickLog } from "./QuickLog";
import { RecordsView } from "./Records";
import { TodayView } from "./Today";
import { TrendsView } from "./Trends";
import type { HealthData } from "./types";

/*
 * Body & Health — weight and vitals with a real trend, sleep, mood,
 * symptoms and cycle, medicines with a dose checklist, appointments, labs
 * and vaccinations. Tabs: Today (quick log + meds due), Trends, Meds,
 * Records (visits, labs, symptoms, vaccines, cycle, history, profile).
 */

const module: ItemModule<HealthData> = {
  kind: "health",
  icon: HeartPulse,
  tabs: [
    { id: "today", label: "Today", icon: HeartPulse, View: TodayView },
    { id: "trends", label: "Trends", icon: LineChart, View: TrendsView },
    { id: "meds", label: "Meds", icon: Pill, View: MedsView },
    { id: "records", label: "Records", icon: ClipboardList, View: RecordsView },
  ],
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "Log",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            goTo("today");
            openQuickLog();
          },
        }
      : null,
  needsOnboarding: (d) => !d?.settings?.onboarded,
  Onboarding,
};

export default module;
