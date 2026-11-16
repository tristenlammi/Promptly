import { Bell, BellOff, Minimize2, Minus, Plus, SkipForward, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ItemHandle } from "@/items/useItem";
import { fmtDuration } from "@/items/ui";
import { cn } from "@/utils/cn";

import type { WorkoutData } from "./types";

/** Ticks every ``ms`` while mounted (for clocks and countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

let audio: AudioContext | null = null;
function beep() {
  try {
    audio = audio ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audio;
    [0, 0.22].forEach((offset) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + offset);
      o.stop(ctx.currentTime + offset + 0.2);
    });
  } catch {
    /* no audio */
  }
}

/** Unlock audio on the first tap of a session (iOS needs a gesture). */
export function primeAudio() {
  try {
    audio = audio ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    /* no audio */
  }
}

/* ------------------------------------------------ screen-off alerts
 *
 * A page can't run its own timer reliably once the screen is off or the app
 * is in the background. Where the browser can schedule a notification
 * (Notification Triggers: ``showTrigger``), the service worker shows it at
 * the rest's end even while the page sleeps. Elsewhere a page timer raises
 * it if the browser keeps the page running (desktop, most Android) — and in
 * every case the logger buzzes / beeps the moment you come back. The
 * preference is per device, like the notification permission. */

const NOTIFY_KEY = "promptly.workout.restNotify";
const TAG = "promptly-workout-rest";
const TITLE = "Rest is up";
type TriggerCtor = new (ts: number) => unknown;

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

export function canScheduleInBackground(): boolean {
  return typeof window !== "undefined" && "TimestampTrigger" in window;
}

export function restNotifyOn(): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try {
    return window.localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

function setRestNotify(on: boolean) {
  try {
    window.localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
  } catch {
    /* not remembered on this device */
  }
}

let pending: { until: string; timer: number | null } | null = null;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!notificationsSupported()) return null;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => window.setTimeout(() => r(null), 3000))]);
  } catch {
    return null;
  }
}

/** Ask for the notification at ``untilIso`` (replacing any earlier one). */
export async function scheduleRestAlert(untilIso: string, vibrate: boolean) {
  if (pending?.until === untilIso) return;
  await cancelRestAlert();
  const at = new Date(untilIso).getTime();
  if (!restNotifyOn() || !(at > Date.now())) return;
  const mine = { until: untilIso, timer: null as number | null };
  pending = mine;
  const opts: NotificationOptions & Record<string, unknown> = {
    tag: TAG,
    body: "Time for your next set.",
    data: { url: window.location.pathname + window.location.search },
    renotify: true,
    ...(vibrate ? { vibrate: [220, 120, 220] } : {}),
  };
  const reg = await registration();
  if (!reg || pending !== mine) return;
  const Trigger = (window as unknown as { TimestampTrigger?: TriggerCtor }).TimestampTrigger;
  if (Trigger) {
    try {
      await reg.showNotification(TITLE, { ...opts, showTrigger: new Trigger(at) } as NotificationOptions);
      return;
    } catch {
      /* fall through to the best-effort timer */
    }
  }
  mine.timer = window.setTimeout(() => {
    // Only when the page isn't on screen (on screen, the bar beeps).
    if (document.visibilityState !== "visible") void reg.showNotification(TITLE, opts).catch(() => undefined);
  }, Math.max(0, at - Date.now()));
}

/** Drop a scheduled / shown rest notification (skipped, finished, beeped). */
export async function cancelRestAlert() {
  const was = pending;
  pending = null;
  if (was?.timer) window.clearTimeout(was.timer);
  if (!was && !restNotifyOn()) return;
  const reg = await registration();
  if (!reg) return;
  try {
    const list = await reg.getNotifications({ tag: TAG, includeTriggered: true } as GetNotificationOptions);
    for (const n of list) n.close();
  } catch {
    /* nothing to close */
  }
}

/** The rest countdown — lives in the file (``active.rest_until``) so it
 *  survives a reload; buzzes and beeps when it's up (or the moment you come
 *  back after it ran out with the screen off), and can raise a notification
 *  while the screen is off. */
export function RestTimer({ item }: { item: ItemHandle<WorkoutData> }) {
  const a = item.data.active;
  const s = item.data.settings;
  const now = useNow(250);
  const fired = useRef<string | null>(null);
  const hiddenSince = useRef<number | null>(null);
  const [notify, setNotify] = useState(restNotifyOn);
  const [returned, setReturned] = useState(0);
  /** The countdown over the whole screen, to read from across the room. */
  const [big, setBig] = useState(false);
  const until = a?.rest_until ? new Date(a.rest_until).getTime() : 0;
  const total = a?.rest_total_s ?? 0;
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  const running = !!until && left > 0;

  // The background notification follows the timer (set, ±15 s, skip).
  useEffect(() => {
    if (a?.rest_until && notify && new Date(a.rest_until).getTime() > Date.now()) void scheduleRestAlert(a.rest_until, s.vibrate);
    else void cancelRestAlert();
  }, [a?.rest_until, notify, s.vibrate]);

  // Remember when the page went away, so a rest that ran out meanwhile still
  // buzzes the moment it's back on screen.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenSince.current = Date.now();
      else setReturned(Date.now());
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!a?.rest_until || left > 0 || fired.current === a.rest_until) return;
    if (document.visibilityState !== "visible") return; // alert when they look
    const away = hiddenSince.current !== null && hiddenSince.current < until;
    // Ran out while we watched — or while the screen was off (up to 3 min ago).
    if (now - until < 5000 || (away && now - until < 180_000)) {
      if (s.vibrate) navigator.vibrate?.([220, 120, 220]);
      if (s.sound) beep();
      void cancelRestAlert();
    }
    hiddenSince.current = null;
    fired.current = a.rest_until;
  }, [left, a?.rest_until, now, until, s.vibrate, s.sound, returned]);

  const adjust = (delta: number) => {
    const floor = Date.now(); // the clock is read here, never in the mutator
    item.update((d) => {
      if (!d.active?.rest_until) return;
      const t = new Date(d.active.rest_until).getTime() + delta * 1000;
      d.active.rest_until = new Date(Math.max(floor, t)).toISOString();
      d.active.rest_total_s = Math.max(0, Math.min(900, (d.active.rest_total_s ?? 0) + delta));
    });
  };
  const skip = () =>
    item.update((d) => {
      if (d.active) {
        d.active.rest_until = null;
        d.active.rest_total_s = null;
      }
    });
  const toggleNotify = async () => {
    if (notify) {
      setRestNotify(false);
      setNotify(false);
      return;
    }
    if (!notificationsSupported()) return;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission().catch(() => "denied" as NotificationPermission);
    const on = perm === "granted";
    setRestNotify(on);
    setNotify(on);
  };

  // The full screen goes with the rest it was showing.
  useEffect(() => {
    if (!running) setBig(false);
  }, [running]);
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBig(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [big]);

  if (!running) return <span className="sr-only" aria-live="polite">{a?.rest_until && left === 0 ? "Rest over" : ""}</span>;
  const pct = total ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
  const denied = notificationsSupported() && Notification.permission === "denied";
  const notifyHint = notify
    ? canScheduleInBackground()
      ? "Screen-off alert on: you'll get a notification when rest ends."
      : "Screen-off alert on: a notification if your browser keeps the page running; otherwise it buzzes the moment you come back."
    : "Alert me when rest ends with the screen off";
  return (
    <div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom,0px))] z-20 md:bottom-4">
      <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
        <div className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
        <div className="relative flex items-center gap-1.5 py-2 pl-4 pr-2">
          {/* Tap the countdown to fill the screen with it. */}
          <button type="button" onClick={() => setBig(true)} aria-label="Show the rest timer full screen" data-testid="rest-expand" className="-my-1 min-w-0 flex-1 rounded-xl py-1 text-left active:bg-[var(--hover)]">
            <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <Timer className="h-3.5 w-3.5 text-[var(--item-accent)]" aria-hidden /> Rest
            </div>
            {/* Big enough to read from the bench with the phone on the floor. */}
            <div className="text-[32px] font-semibold leading-none tabular-nums text-[var(--text)]" role="timer" aria-live={left <= 10 ? "assertive" : "off"} aria-atomic>
              {fmtDuration(left)}
            </div>
          </button>
          {notificationsSupported() && !denied && (
            <button
              type="button"
              onClick={() => void toggleNotify()}
              aria-pressed={notify}
              aria-label={notifyHint}
              title={notifyHint}
              className={cn("flex h-12 w-10 shrink-0 items-center justify-center rounded-xl hover:bg-[var(--hover)] min-[390px]:w-11", notify ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}
            >
              {notify ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
          )}
          <button type="button" onClick={() => adjust(-15)} aria-label="15 seconds less rest" className="flex h-12 min-w-10 shrink-0 items-center justify-center gap-0.5 rounded-xl px-1 min-[390px]:min-w-11 min-[390px]:px-1.5 text-sm font-semibold tabular-nums text-[var(--text-muted)] hover:bg-[var(--hover)] active:bg-[var(--hover)]">
            <Minus className="h-3.5 w-3.5" />15
          </button>
          <button type="button" onClick={() => adjust(15)} aria-label="15 seconds more rest" className="flex h-12 min-w-10 shrink-0 items-center justify-center gap-0.5 rounded-xl px-1 min-[390px]:min-w-11 min-[390px]:px-1.5 text-sm font-semibold tabular-nums text-[var(--text-muted)] hover:bg-[var(--hover)] active:bg-[var(--hover)]">
            <Plus className="h-3.5 w-3.5" />15
          </button>
          <button type="button" onClick={skip} aria-label="Skip rest" className="flex h-12 shrink-0 items-center gap-1 rounded-xl bg-[var(--item-accent-fill)] px-3 text-sm font-semibold text-white active:opacity-90 min-[390px]:px-3.5">
            <SkipForward className="h-4 w-4" /> Skip
          </button>
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {left === 30 || left === 10 ? `${left} seconds of rest left` : ""}
      </span>
      {big &&
        createPortal(
          <div role="dialog" aria-modal="true" aria-label="Rest timer" data-testid="rest-full" className="fixed inset-0 z-[90] flex flex-col bg-[var(--bg)] pb-safe pl-safe pr-safe pt-safe text-[var(--text)]">
            <div className="flex justify-end p-3">
              <button type="button" autoFocus onClick={() => setBig(false)} aria-label="Back to the workout" className="flex h-12 w-12 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] active:bg-[var(--hover)]">
                <Minimize2 className="h-5 w-5" />
              </button>
            </div>
            {/* Tapping the countdown goes back too: the same place that opened it. */}
            <button type="button" onClick={() => setBig(false)} aria-label="Back to the workout" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6">
              <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                <Timer className="h-4 w-4 text-[var(--item-accent)]" aria-hidden /> Rest
              </span>
              <span className="text-[min(30vw,168px)] font-semibold leading-none tabular-nums">{fmtDuration(left)}</span>
              <span className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-2)]">
                <span className="block h-full rounded-full bg-[var(--item-accent-fill)] transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
              </span>
            </button>
            <div className="flex items-center justify-center gap-3 px-4 pb-6 pt-2">
              <button type="button" onClick={() => adjust(-15)} aria-label="15 seconds less rest" className="flex h-14 min-w-[72px] items-center justify-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-base font-semibold tabular-nums active:bg-[var(--hover)]">
                <Minus className="h-4 w-4" />15
              </button>
              <button type="button" onClick={skip} aria-label="Skip rest" className="flex h-14 flex-1 max-w-[200px] items-center justify-center gap-2 rounded-2xl bg-[var(--item-accent-fill)] text-base font-semibold text-white active:opacity-90">
                <SkipForward className="h-5 w-5" /> Skip
              </button>
              <button type="button" onClick={() => adjust(15)} aria-label="15 seconds more rest" className="flex h-14 min-w-[72px] items-center justify-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-base font-semibold tabular-nums active:bg-[var(--hover)]">
                <Plus className="h-4 w-4" />15
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
