import { useEffect, useState } from "react";

/**
 * Returns true when the current window is being rendered as an
 * installed PWA (Android/Chrome ``display-mode: standalone`` or
 * iOS' legacy ``navigator.standalone`` flag).
 *
 * Used to gate the "Install this app" indicators — there's no point
 * asking the user to install something they've already installed.
 */
export function useIsStandalone(): boolean {
  const [standalone, setStandalone] = useState<boolean>(() => computeInitial());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(display-mode: standalone)");
    const handler = (e: MediaQueryListEvent) => setStandalone(e.matches || iosStandalone());
    setStandalone(mq.matches || iosStandalone());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return standalone;
}

function computeInitial(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return iosStandalone();
}

function iosStandalone(): boolean {
  // iOS Safari exposes a non-standard ``navigator.standalone`` flag;
  // TS doesn't know about it, so we read through a structural cast.
  if (typeof navigator === "undefined") return false;
  const n = navigator as Navigator & { standalone?: boolean };
  return n.standalone === true;
}
