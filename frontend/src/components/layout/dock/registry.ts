/**
 * The "happening now" feeds. To add one: write ``feeds/<name>.ts`` exporting
 * a ``DockFeed`` (see ``types.ts``) and list it here. The order here doesn't
 * matter: cards sort by their own ``priority``.
 */
import { calendarFeed } from "./feeds/calendar";
import { callFeed } from "./feeds/call";
import { mailFeed } from "./feeds/mail";
import { mapsFeed } from "./feeds/maps";
import { notesFeed } from "./feeds/notes";
import { photosFeed } from "./feeds/photos";
import { tasksFeed } from "./feeds/tasks";
import { uploadsFeed } from "./feeds/uploads";
import { voiceFeed } from "./feeds/voice";
import type { DockFeed } from "./types";

export const DOCK_FEEDS: DockFeed[] = [
  voiceFeed,
  callFeed,
  uploadsFeed,
  mailFeed,
  mapsFeed,
  calendarFeed,
  tasksFeed,
  notesFeed,
  photosFeed,
];
