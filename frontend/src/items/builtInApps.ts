import { CalendarDays, ClipboardList, House, KeyRound, Lightbulb, Mail, MessageCircle, Navigation, type LucideIcon } from "lucide-react";

// Plain data, no stores or API client: the Passwords page's copy of the
// sidebar (passwords/ui/PromptlyNav.tsx) reads it too.

/** An app that can sit in the sidebar: a built-in one or an added Item Store app. */
export interface NavApp {
  id: string;
  name: string;
  icon: string;
  /** The line icon used when the sidebar shows simple icons. */
  glyph: LucideIcon;
  to: string;
}

/** Apps that are part of Promptly itself (not file-backed items). */
export const BUILT_IN_APPS: NavApp[] = [
  { id: "rooms", name: "Rooms", icon: "/item-icons/rooms-192.png", glyph: MessageCircle, to: "/rooms" },
  { id: "calendar", name: "Calendar", icon: "/item-icons/calendar-192.png", glyph: CalendarDays, to: "/calendar" },
  { id: "maps", name: "Maps", icon: "/item-icons/maps-192.png", glyph: Navigation, to: "/maps" },
  { id: "mail", name: "Mail", icon: "/item-icons/mail-192.png", glyph: Mail, to: "/mail" },
  // Its own page: the route in App.tsx turns this into a full page load.
  { id: "passwords", name: "Passwords", icon: "/item-icons/passwords-192.png", glyph: KeyRound, to: "/passwords" },
  // Forms: a home page of your forms (each form is a file in Files).
  { id: "forms", name: "Forms", icon: "/item-icons/forms-192.png", glyph: ClipboardList, to: "/forms" },
  // Notes (Keep-style notes and lists).
  { id: "notes", name: "Notes", icon: "/item-icons/notes-192.png", glyph: Lightbulb, to: "/notes" },
  // Porch (shown only to people it's turned on for: useBuiltInApps)
  { id: "porch", name: "Porch", icon: "/item-icons/porch-192.png", glyph: House, to: "/porch" },
];
