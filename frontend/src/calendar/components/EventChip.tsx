import type { MouseEvent } from "react";

import { cn } from "@/utils/cn";

import { zoneNote } from "../dates";
import { chipTime, lookStyle, type ViewEvent } from "../model";
import { ExtraChip } from "./ExtrasChips";

export type OpenEvent = (v: ViewEvent, anchor: DOMRect | null) => void;

export function openFrom(e: MouseEvent<HTMLElement>, v: ViewEvent, open: OpenEvent) {
  e.stopPropagation();
  open(v, e.currentTarget.getBoundingClientRect());
}

/** One line in a month cell / the all-day row. Bars (all-day, multi-day)
 *  are filled; a timed event is a dot + time + title. */
export function EventChip({
  v,
  onOpen,
  showTitle = true,
  continuesLeft,
  continuesRight,
  compact,
}: {
  v: ViewEvent;
  onOpen: OpenEvent;
  showTitle?: boolean;
  continuesLeft?: boolean;
  continuesRight?: boolean;
  compact?: boolean;
}) {
  if (v.extra) return <ExtraChip v={v} onOpen={onOpen} compact={compact} continuesLeft={continuesLeft} continuesRight={continuesRight} />;
  const label = `${v.ev.title}${v.allDay ? "" : `, ${chipTime(v)}`}`;
  // In its own time zone too, when that isn't mine.
  const tip = zoneNote(v.start, v.ev.tz, v.allDay);
  const title = tip ? `${v.ev.title} · ${tip}` : undefined;
  if (!v.spanning) {
    const faded = v.look === "declined";
    const outlined = v.look === "pending";
    return (
      <button
        type="button"
        onClick={(e) => openFrom(e, v, onOpen)}
        data-color={v.color}
        aria-label={label}
        title={title}
        className={cn(
          "flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1 text-left hover:bg-[var(--hover)]",
          "text-xs",
          faded && "line-through opacity-60",
        )}
      >
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full", outlined && "border border-dashed bg-transparent")}
          style={outlined ? { borderColor: v.color } : { background: v.color }}
        />
        {!compact && <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{chipTime(v)}</span>}
        <span className="truncate text-[var(--text)]">{v.ev.title}</span>
      </button>
    );
  }
  const { style, className } = lookStyle(v);
  return (
    <button
      type="button"
      onClick={(e) => openFrom(e, v, onOpen)}
      data-color={v.color}
      aria-label={label}
      style={style}
      className={cn(
        "flex h-full w-full min-w-0 items-center px-1.5 text-left font-medium hover:brightness-95",
        "text-xs",
        continuesLeft ? "rounded-l-none border-l-0" : "rounded-l-md",
        continuesRight ? "rounded-r-none border-r-0" : "rounded-r-md",
        className,
      )}
    >
      <span className="truncate">{showTitle ? v.ev.title : " "}</span>
    </button>
  );
}
