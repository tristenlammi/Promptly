import type { LucideIcon } from "lucide-react";

/** A button on a dock card (Mute, Leave, Stop, Tick off). */
export interface DockAction {
  id: string;
  /** Said by screen readers and shown as the tooltip. */
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** Ends something (Leave, Stop): drawn in the danger colour. */
  danger?: boolean;
  /** A toggle that is on right now (Muted). */
  pressed?: boolean;
  /** Also shown as its own button on the collapsed rail (Mute, Leave). */
  quick?: boolean;
}

export type DockTone = "plain" | "accent" | "live" | "warn";

/** One "happening now" card. A feed returns zero or more of these. */
export interface DockCardData {
  /** Unique across all feeds (prefix it with the feed's id). */
  id: string;
  /** Higher sits nearer the top; the top three show, the rest fold away. */
  priority: number;
  icon: LucideIcon;
  tone?: DockTone;
  title: string;
  detail?: string;
  /** 0..1 draws a progress bar along the bottom. */
  progress?: number | null;
  /** When it started (ms): shows a running timer after the detail. */
  since?: number | null;
  /** Tapping the card goes back to where this is happening. */
  onOpen?: () => void;
  actions?: DockAction[];
}

/**
 * A feed: one file in ``feeds/``. ``useCards`` is a hook, so it can read
 * stores and queries. It must return [] when its app isn't set up, and it
 * is run inside an error boundary, so a broken feed shows nothing.
 */
export interface DockFeed {
  id: string;
  useCards: () => DockCardData[];
}
