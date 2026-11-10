import { useEffect, useState } from "react";

/** The time now, refreshed every ``everyMs`` while the tab is visible (so
 *  "in 12 min" counts down without asking the server again). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const id = window.setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [everyMs]);
  return now;
}

/** "3:30 pm" in the person's own format. */
export function clock(d: Date | number | string): string {
  return new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
