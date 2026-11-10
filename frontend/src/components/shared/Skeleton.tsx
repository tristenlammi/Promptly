import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/utils/cn";

/**
 * A single shimmering placeholder block. Compose several to mock the
 * shape of the content that's loading (a row, a card, a line of text)
 * so the first paint reads as "loading this layout" rather than a bare
 * spinner. Decorative, so it's hidden from assistive tech — pair the
 * surrounding container with an `aria-busy`/`aria-live` hint where the
 * loading state matters to screen-reader users.
 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn("promptly-skeleton rounded-md", className)}
    />
  );
}

/* ----------------------------------------------------------------------
   Skeleton presets (UI plan A4). Use these in place of "Loading…" text
   and lone spinners, so the page keeps its shape while data arrives:

     if (isLoading) return <SkeletonRows count={8} />;

   Pick the one that looks like what's coming:
     SkeletonRows        a list: icon + two lines (+ a right-hand bit)
     SkeletonAvatarRows  people: round avatar + name + a line
     SkeletonCardGrid    cards: picture on top, two lines under
     SkeletonTileGrid    square tiles: photos, album covers, app icons
     SkeletonMessages    a conversation: bubbles left and right
     SkeletonText        a paragraph: a few lines of text

   All of them: ``count`` (how many), ``className`` (spacing / padding on
   the wrapper), ``label`` (what screen readers hear; default "Loading").
   Each announces itself once as a polite status and hides the blocks, so
   don't add your own "Loading…" beside it. Widths vary by row from a fixed
   pattern (not random), so re-renders don't make it jitter.
   ---------------------------------------------------------------------- */

interface PresetProps {
  /** How many rows / cards / tiles. */
  count?: number;
  className?: string;
  /** Read out once by screen readers. Default "Loading". */
  label?: string;
}

function Busy({ label = "Loading", className, style, children }: { label?: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className} style={style}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

const WIDTHS = ["62%", "48%", "71%", "40%", "56%", "66%", "44%"];
const SUB_WIDTHS = ["34%", "46%", "28%", "40%", "31%", "25%", "38%"];
const range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

/** List rows: a leading icon block, a title line and a smaller line. */
export function SkeletonRows({
  count = 6,
  className,
  label,
  icon = true,
  trailing = false,
  lines = 2,
  dense = false,
}: PresetProps & {
  /** Leading square (an icon / thumbnail). Default true. */
  icon?: boolean;
  /** A short block on the right (a date, a size). */
  trailing?: boolean;
  /** 1 = title only, 2 = title + detail (default). */
  lines?: 1 | 2;
  /** Tighter rows (40px instead of 56px). */
  dense?: boolean;
}) {
  return (
    <Busy label={label} className={cn("flex flex-col", className)}>
      {range(count).map((i) => (
        <div key={i} className={cn("flex items-center gap-3 px-3", dense ? "h-10" : "h-14")}>
          {icon && <Skeleton className={cn("shrink-0 rounded-lg", dense ? "h-5 w-5" : "h-9 w-9")} />}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5" style={{ width: WIDTHS[i % WIDTHS.length] }} />
            {lines === 2 && !dense && <Skeleton className="h-3" style={{ width: SUB_WIDTHS[i % SUB_WIDTHS.length] }} />}
          </div>
          {trailing && <Skeleton className="h-3 w-14 shrink-0" />}
        </div>
      ))}
    </Busy>
  );
}

/** People rows: a round avatar, a name and one line under it. */
export function SkeletonAvatarRows({
  count = 6,
  className,
  label,
  size = 40,
  lines = 2,
}: PresetProps & {
  /** Avatar diameter in px. Default 40. */
  size?: number;
  lines?: 1 | 2;
}) {
  return (
    <Busy label={label} className={cn("flex flex-col", className)}>
      {range(count).map((i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <Skeleton className="shrink-0 !rounded-full" style={{ width: size, height: size }} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5" style={{ width: SUB_WIDTHS[(i + 2) % SUB_WIDTHS.length] }} />
            {lines === 2 && <Skeleton className="h-3" style={{ width: WIDTHS[(i + 3) % WIDTHS.length] }} />}
          </div>
        </div>
      ))}
    </Busy>
  );
}

/** Cards in a responsive grid: a picture area and two lines of text. */
export function SkeletonCardGrid({
  count = 6,
  className,
  label,
  minWidth = 220,
  media = true,
  mediaClassName = "aspect-[4/3]",
}: PresetProps & {
  /** Narrowest a card may get before the grid drops a column, px. Default 220. */
  minWidth?: number;
  /** Show the picture area. Default true; false = text-only cards (notes). */
  media?: boolean;
  /** Shape of the picture area. Default "aspect-[4/3]". */
  mediaClassName?: string;
}) {
  return (
    <Busy label={label} className={cn("grid gap-4", className)} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${minWidth}px, 100%), 1fr))` }}>
      {range(count).map((i) => (
        <div key={i} className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {media && <Skeleton className={cn("w-full !rounded-none", mediaClassName)} />}
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-3.5" style={{ width: WIDTHS[i % WIDTHS.length] }} />
            <Skeleton className="h-3" style={{ width: SUB_WIDTHS[i % SUB_WIDTHS.length] }} />
            {!media && <Skeleton className="h-3" style={{ width: WIDTHS[(i + 2) % WIDTHS.length] }} />}
          </div>
        </div>
      ))}
    </Busy>
  );
}

/** Square tiles packed tight: photos, album covers, app icons. */
export function SkeletonTileGrid({
  count = 18,
  className,
  label,
  minWidth = 120,
  gap = 4,
  caption = false,
  tileClassName,
}: PresetProps & {
  /** Narrowest a tile may get, px. Default 120. */
  minWidth?: number;
  /** Space between tiles, px. Default 4 (a photo grid); use 12–16 for covers. */
  gap?: number;
  /** A line of text under each tile (album name). */
  caption?: boolean;
  /** Tile shape / corners. Default square with small corners. */
  tileClassName?: string;
}) {
  return (
    <Busy label={label} className={cn("grid", className)} style={{ gap, gridTemplateColumns: `repeat(auto-fill, minmax(min(${minWidth}px, 45%), 1fr))` }}>
      {range(count).map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className={cn("aspect-square w-full", tileClassName)} />
          {caption && <Skeleton className="h-3" style={{ width: WIDTHS[i % WIDTHS.length] }} />}
        </div>
      ))}
    </Busy>
  );
}

const BUBBLES = [
  { mine: false, w: "46%", h: 36 },
  { mine: false, w: "62%", h: 52 },
  { mine: true, w: "38%", h: 36 },
  { mine: false, w: "54%", h: 36 },
  { mine: true, w: "58%", h: 68 },
  { mine: true, w: "30%", h: 36 },
  { mine: false, w: "40%", h: 52 },
];

/** A conversation: bubbles on both sides, avatars beside the other person's. */
export function SkeletonMessages({
  count = 6,
  className,
  label,
  avatars = true,
}: PresetProps & {
  /** Round avatar beside incoming bubbles. Default true. */
  avatars?: boolean;
}) {
  return (
    <Busy label={label} className={cn("flex flex-col gap-3 px-3 py-2", className)}>
      {range(count).map((i) => {
        const b = BUBBLES[i % BUBBLES.length];
        return (
          <div key={i} className={cn("flex items-end gap-2", b.mine && "flex-row-reverse")}>
            {avatars && !b.mine && <Skeleton className="h-8 w-8 shrink-0 !rounded-full" />}
            <Skeleton className="max-w-[80%] !rounded-2xl" style={{ width: b.w, height: b.h }} />
          </div>
        );
      })}
    </Busy>
  );
}

/** A few lines of text: a paragraph, a note body, a detail panel. */
export function SkeletonText({ count = 3, className, label }: PresetProps) {
  return (
    <Busy label={label} className={cn("flex flex-col gap-2.5", className)}>
      {range(count).map((i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: i === count - 1 ? "55%" : i % 2 ? "92%" : "100%" }} />
      ))}
    </Busy>
  );
}
