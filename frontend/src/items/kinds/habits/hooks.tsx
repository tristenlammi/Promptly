import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";

import { nowISO } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";

import { logicalToday } from "./engine";
import { HabitEditor } from "./HabitEditor";
import { LogSheet, type LogChange } from "./LogSheet";
import { Snackbar } from "./parts";
import type { Habit, HabitsData } from "./types";
import { addToLog, applyHabitEdit, changedFields, habitLabel, hasPast, logsFull, onNewHabitRequest, rulesChanged, startTimer, stopTimer, timerMinutes, writeLog } from "./util";

/**
 * The width of an element (0 until measured). Views lay out by the space
 * they actually get — on desktop the AI side panel takes ~400px, so the
 * viewport alone says nothing about whether two columns fit.
 */
export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

/** The person's logical today, rolling over at their day boundary. */
export function useToday(dayEndsAt: number): string {
  const [today, setToday] = useState(() => logicalToday(dayEndsAt));
  useEffect(() => {
    setToday(logicalToday(dayEndsAt));
    const t = window.setInterval(() => setToday(logicalToday(dayEndsAt)), 30_000);
    const onVis = () => setToday(logicalToday(dayEndsAt));
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [dayEndsAt]);
  return today;
}

interface Snack {
  id: number;
  text: ReactNode;
  undo?: () => void;
}

/**
 * The editor, the log sheet and the undo snackbar every tab shares — plus
 * the header's "New habit" button (a module signal, see requestNewHabit).
 */
export function useHabitTools(item: ItemHandle<HabitsData>, today: string, ask?: (p: string) => void) {
  const [editing, setEditing] = useState<{ habit: Habit | null } | null>(null);
  const [logging, setLogging] = useState<{ id: string; day: string } | null>(null);
  const [snack, setSnack] = useState<Snack | null>(null);

  useEffect(() => onNewHabitRequest(() => item.canEdit && setEditing({ habit: null })), [item.canEdit]);

  const say = useCallback((text: ReactNode, undo?: () => void) => setSnack({ id: Date.now(), text, undo }), []);

  const full = useCallback(
    (id: string, day: string) => {
      const h = item.data.habits.find((x) => x.id === id);
      if (!h || !logsFull(h, day)) return false;
      say(`${habitLabel(h)} holds ${h.logs.length} days of history — archive older data (file menu) to log more.`);
      return true;
    },
    [item, say],
  );

  const commitLog = useCallback(
    (c: LogChange) => {
      if (c.after && full(c.habitId, c.day)) return;
      const at = nowISO();
      const delta = c.delta;
      item.update((d) => (delta !== undefined ? addToLog(d, c.habitId, c.day, delta, at, c.after ?? {}) : writeLog(d, c.habitId, c.day, c.after, at)));
      say(c.text, () => {
        const at2 = nowISO();
        item.update((d) =>
          delta !== undefined
            ? addToLog(d, c.habitId, c.day, -delta, at2, { note: c.before?.note ?? "" })
            : writeLog(d, c.habitId, c.day, c.before ? { ...c.before } : null, c.before?.at ?? at2),
        );
      });
    },
    [item, say, full],
  );

  /** The duration timer lives in the file, so it survives closing the sheet. */
  const timer = useCallback(
    (id: string, day: string, op: "start" | "stop" | "cancel") => {
      const at = nowISO();
      const h = item.data.habits.find((x) => x.id === id);
      if (op === "start") {
        item.update((d) => startTimer(d, id, day, at));
        return;
      }
      const t = h?.active_timer;
      if (op === "stop" && t && h && full(id, t.day)) return;
      item.update((d) => {
        stopTimer(d, id, at, op === "stop");
      });
      if (op === "stop" && t && h) say(`${habitLabel(h)}: +${timerMinutes(t.started_at, at)} min`);
    },
    [item, full, say],
  );

  const saveHabit = useCallback(
    (h: Habit, isNew: boolean, original: Habit | null, applyToPast = false) => {
      if (isNew) {
        const base = h.id === "habit" ? (h.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "habit") : h.id;
        item.update((d) => {
          const taken = new Set(d.habits.map((x) => x.id));
          let id = base;
          for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
          d.habits.push({ ...structuredClone(h), id });
          d.settings.onboarded = true;
        });
        say(`Added ${habitLabel(h)}`);
        return;
      }
      if (!original) return;
      // Only what the editor changed — another device may have edited the rest.
      const patch = changedFields(original, h);
      if (!Object.keys(patch).length) return;
      const ruleChange = rulesChanged(original, h) && hasPast(original, today);
      item.update((d) => {
        const x = d.habits.find((y) => y.id === h.id);
        if (x) applyHabitEdit(x, structuredClone(patch), today, applyToPast);
      });
      say(ruleChange && !applyToPast ? `Saved ${habitLabel(h)} — the new rules apply from today` : `Saved ${habitLabel(h)}`);
    },
    [item, say, today],
  );

  const archive = useCallback(
    (h: Habit) => {
      const to = !h.archived;
      item.update((d) => {
        const x = d.habits.find((y) => y.id === h.id);
        if (x) x.archived = to;
      });
      say(`${to ? "Archived" : "Restored"} ${habitLabel(h)}`, () =>
        item.update((d) => {
          const x = d.habits.find((y) => y.id === h.id);
          if (x) x.archived = !to;
        }),
      );
    },
    [item, say],
  );

  const remove = useCallback(
    (h: Habit) => {
      const cur = item.data.habits;
      const idx = cur.findIndex((x) => x.id === h.id);
      const original = cur[idx];
      item.update((d) => {
        d.habits = d.habits.filter((x) => x.id !== h.id);
      });
      say(`Deleted ${habitLabel(h)}`, () =>
        item.update((d) => {
          if (original && !d.habits.some((x) => x.id === original.id)) d.habits.splice(Math.min(idx, d.habits.length), 0, original);
        }),
      );
    },
    [item, say],
  );

  const closeEditor = useCallback(() => setEditing(null), []);
  const closeLog = useCallback(() => setLogging(null), []);
  const dropSnack = useCallback(() => setSnack(null), []);

  const loggingHabit = logging ? item.data.habits.find((h) => h.id === logging.id) ?? null : null;

  const element = (
    <>
      <HabitEditor
        open={!!editing}
        onClose={closeEditor}
        data={item.data}
        habit={editing?.habit ?? null}
        onSave={saveHabit}
        today={today}
        onArchive={archive}
        onDelete={remove}
        ask={ask}
      />
      <LogSheet
        open={!!logging && !!loggingHabit}
        onClose={closeLog}
        habit={loggingHabit}
        day={logging?.day ?? today}
        data={item.data}
        today={today}
        onCommit={commitLog}
        onTimer={timer}
        readOnly={!item.canEdit}
      />
      {snack && <Snackbar key={snack.id} text={snack.text} onUndo={item.canEdit ? snack.undo : undefined} onDone={dropSnack} />}
    </>
  );

  return {
    element,
    openNew: () => item.canEdit && setEditing({ habit: null }),
    openEdit: (h: Habit) => item.canEdit && setEditing({ habit: h }),
    openLog: (id: string, day: string) => setLogging({ id, day }),
    full,
    say,
    archive,
    busy: !!editing || !!logging,
  };
}
