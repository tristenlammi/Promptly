import { Apple, ChartLine, NotebookPen, Plus, Target } from "lucide-react";

import type { ItemModule } from "@/items/types";

import { Diary } from "./Diary";
import { Foods } from "./Foods";
import { requestAddFood } from "./lib";
import { Onboarding, TargetsView } from "./Targets";
import { Trends } from "./Trends";
import type { MealsData } from "./types";

/*
 * Meals & Macros — a food diary with macro/micro targets and adaptive
 * coaching (MyFitnessPal + MacroFactor, Cronometer-style micros where the
 * food data has them). Diary first; Add food
 * is a sheet (search, barcode scan, quick add, describe-to-the-AI); Trends
 * reads weight from Body & Health through the kind's own endpoint.
 */

const module: ItemModule<MealsData> = {
  kind: "meals",
  tabs: [
    { id: "diary", label: "Diary", icon: NotebookPen, View: Diary },
    { id: "trends", label: "Trends", icon: ChartLine, View: Trends },
    { id: "foods", label: "Foods", icon: Apple, View: Foods },
    { id: "targets", label: "Targets", icon: Target, View: TargetsView },
  ],
  // The header's main button: jump to today's diary and open Add food.
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "Add food",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            goTo("diary");
            requestAddFood();
          },
        }
      : null,
  needsOnboarding: (d) => !d?.profile?.onboarded,
  Onboarding,
};

export default module;
