import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";

import { calendarApi, type EditScope, type EventPatch, type Repeat } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";

import { askScope } from "./components/ui";
import { addUsers } from "./data";
import { addDays, dayDiff, localZone, parseYmd, shortDay, timeLabel, ymd } from "./dates";
import { withTimes, type ViewEvent } from "./model";

/*
 * Dragging events to move / resize them. A mouse drags once it has moved a
 * few pixels; a finger has to hold still for a moment first (otherwise it's
 * a scroll or a tap). A press that never became a drag is left alone, so
 * the click that follows opens the event as usual.
 */

const LONG_PRESS_MS = 350;
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;

let active = false;
/** A drag is under way (scrolling is held off while it is). */
export const dragging = () => active;

export interface PressHandlers {
  /** The press became a drag (at the press point). */
  start: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  drop: (x: number, y: number) => void;
  cancel: () => void;
  cursor?: string;
}

/** Swallow the click that follows a drag (on whatever is under the pointer). */
function swallowNextClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  // A touch drag usually doesn't end in a click at all.
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

/** Start watching a press on an event; it may become a drag. */
export function beginPress(e: ReactPointerEvent<HTMLElement>, h: PressHandlers) {
  if (e.button !== 0 || active) return;
  const touch = e.pointerType !== "mouse";
  const id = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let started = false;
  let timer = 0;
  const bodyStyle = document.body.style;
  const before = { cursor: bodyStyle.cursor, select: bodyStyle.userSelect };

  const begin = () => {
    started = true;
    active = true;
    bodyStyle.userSelect = "none";
    bodyStyle.cursor = h.cursor ?? "grabbing";
    window.getSelection()?.removeAllRanges();
    if (touch) navigator.vibrate?.(8);
    h.start(x0, y0);
  };
  const cleanup = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("contextmenu", onContext, true);
    if (started) {
      active = false;
      bodyStyle.userSelect = before.select;
      bodyStyle.cursor = before.cursor;
    }
  };
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (!started) {
      const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (touch) {
        // Moved before the hold finished: it's a scroll.
        if (dist > TOUCH_SLOP) cleanup();
        return;
      }
      if (dist < MOUSE_SLOP) return;
      begin();
    }
    h.move(ev.clientX, ev.clientY);
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const was = started;
    cleanup();
    if (was) {
      swallowNextClick();
      h.drop(ev.clientX, ev.clientY);
    }
  };
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const was = started;
    cleanup();
    if (was) h.cancel();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !started) return;
    ev.stopPropagation();
    cleanup();
    h.cancel();
  };
  // A long press would otherwise bring up the phone's context menu.
  const onContext = (ev: Event) => {
    if (touch) ev.preventDefault();
  };

  if (touch) timer = window.setTimeout(begin, LONG_PRESS_MS);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("contextmenu", onContext, true);
}

/** Holds off touch scrolling while a drag is under way: a ref for the
 *  view's root (the listener has to be in place, non-passive, before the
 *  finger lands). */
export function useTouchDragGuard() {
  const off = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    off.current?.();
    off.current = null;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (active && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    off.current = () => el.removeEventListener("touchmove", onTouchMove);
  }, []);
}

/** Snap minutes to the 15-minute grid. */
export const snap15 = (min: number) => Math.round(min / 15) * 15;

// ------------------------------------------------------------------ saving

/** Events shown at their new times while the move saves. */
interface MovedState {
  moved: Record<string, { start: Date; end: Date }>;
  set: (id: string, to: { start: Date; end: Date } | null) => void;
}
export const useMoved = create<MovedState>((set) => ({
  moved: {},
  set: (id, to) =>
    set((s) => {
      const moved = { ...s.moved };
      if (to) moved[id] = to;
      else delete moved[id];
      return { moved };
    }),
}));

export function applyMoves(events: ViewEvent[], moved: MovedState["moved"]): ViewEvent[] {
  if (!Object.keys(moved).length) return events;
  return events.map((v) => (moved[v.ev.id] ? withTimes(v, moved[v.ev.id].start, moved[v.ev.id].end) : v));
}

const wire = (s: Date, eExcl: Date, allDay: boolean) =>
  allDay ? { start: ymd(s), end: ymd(addDays(eExcl, -1)) } : { start: s.toISOString(), end: eExcl.toISOString() };

/** Weekly days follow a move by whole days. */
function shiftRepeat(r: Repeat | null, days: number): Repeat | null {
  if (!r || r.freq !== "weekly" || !r.weekdays?.length || days % 7 === 0) return null;
  return { ...r, weekdays: Array.from(new Set(r.weekdays.map((w) => (((w + days) % 7) + 7) % 7))).sort() };
}

function movedLabel(v: ViewEvent, start: Date): string {
  return v.allDay ? shortDay(start) : `${shortDay(start)}, ${timeLabel(start).replace(/\s?([AP])M$/i, (_m, p: string) => ` ${p.toLowerCase()}m`)}`;
}

/** Save a dragged event at [start, end) — asks "this / following / all" for a
 *  repeating one. ``refresh`` resolves once the calendar has refetched. */
export async function commitMove(v: ViewEvent, start: Date, end: Date, refresh: () => Promise<void>): Promise<void> {
  const ev = v.ev;
  if (start.getTime() === v.start.getTime() && end.getTime() === v.end.getTime()) return;
  const setMoved = useMoved.getState().set;
  setMoved(ev.id, { start, end });

  let scope: EditScope = "all";
  if (ev.repeat) {
    const s = await askScope("edit");
    if (!s) {
      setMoved(ev.id, null);
      return;
    }
    scope = s;
  }

  const shiftDays = dayDiff(v.start, start);
  const patch: EventPatch = { tz: localZone() };
  if (ev.repeat && scope === "all") {
    // Move the whole series by the same change, from its first occurrence.
    const first = ev.all_day ? parseYmd(ev.series_start) : new Date(ev.series_start);
    const s0 = addDays(new Date(first.getFullYear(), first.getMonth(), first.getDate()), shiftDays);
    if (ev.all_day) {
      Object.assign(patch, wire(s0, addDays(s0, dayDiff(start, end)), true));
    } else {
      s0.setHours(start.getHours(), start.getMinutes(), 0, 0);
      Object.assign(patch, wire(s0, new Date(s0.getTime() + (end.getTime() - start.getTime())), false));
    }
  } else {
    Object.assign(patch, wire(start, end, v.allDay));
  }
  if (ev.repeat) {
    patch.scope = scope;
    patch.occurrence = ev.occurrence;
    const r = scope !== "this" ? shiftRepeat(ev.repeat, shiftDays) : null;
    if (r) patch.repeat = r;
  }

  try {
    const r = await calendarApi.update(ev.event_id, patch);
    addUsers(r.users);
    await refresh();
    const undo = ev.repeat
      ? undefined
      : {
          label: "Undo",
          onClick: () => {
            void (async () => {
              setMoved(ev.id, { start: v.start, end: v.end });
              try {
                await calendarApi.update(ev.event_id, { tz: localZone(), ...wire(v.start, v.end, v.allDay) });
                await refresh();
              } catch (err) {
                toast.error(extractError(err) || "Couldn't undo that.");
              } finally {
                setMoved(ev.id, null);
              }
            })();
          },
        };
    toast.success(`Moved to ${movedLabel(v, start)}`, undo ? { action: undo } : undefined);
  } catch (err) {
    toast.error(extractError(err) || "Couldn't move the event.");
  } finally {
    setMoved(ev.id, null);
  }
}
