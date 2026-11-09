import {
  BookOpen,
  CalendarDays,
  CircleCheckBig,
  Contact,
  Dices,
  Dumbbell,
  HeartPulse,
  Layers,
  LayoutGrid,
  ListChecks,
  ListTodo,
  Plane,
  Salad,
  Wallet,
  type LucideIcon,
} from "lucide-react";

// Plain data, no stores or API client: the Passwords page's copy of the
// sidebar (passwords/ui/PromptlyNav.tsx) reads it too.

/** Icons named by the backend spec (``icon``), for the Store, New and Files. */
const ICONS: Record<string, LucideIcon> = {
  dumbbell: Dumbbell,
  "heart-pulse": HeartPulse,
  salad: Salad,
  "calendar-days": CalendarDays,
  "circle-check-big": CircleCheckBig,
  wallet: Wallet,
  contact: Contact,
  plane: Plane,
  "book-open": BookOpen,
  dices: Dices,
  layers: Layers,
  "list-checks": ListChecks,
  "list-todo": ListTodo,
};

export function itemIcon(name: string | null | undefined): LucideIcon {
  return (name && ICONS[name]) || LayoutGrid;
}
