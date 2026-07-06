import { useEffect, useRef } from "react";

import { cn } from "@/utils/cn";

/**
 * Animated voice waveform — a row of rounded bars that ride a slow,
 * layered sine wave. Shared by the voice-mode overlay (large) and the
 * composer's dictation UI (mini).
 *
 * Three modes:
 *  - ``live``    — amplitude follows the real mic level (``levelRef``),
 *                  smoothed with a fast-attack / slow-release envelope so
 *                  the raw per-frame RMS never reads as jitter.
 *  - ``ambient`` — gentle synthetic swell (used while TTS is speaking,
 *                  where we don't tap the output audio).
 *  - ``idle``    — bars ease back down to a resting baseline.
 *
 * Heights are written straight to the DOM inside one rAF loop — no React
 * state per frame. ``prefers-reduced-motion`` renders a static waveform.
 */

export type VoiceWaveformMode = "live" | "ambient" | "idle";

interface VoiceWaveformProps {
  mode: VoiceWaveformMode;
  /** Raw 0–1 mic level, written by the caller per frame (``live`` mode).
   *  The component smooths it — pass the unfiltered value. */
  levelRef?: React.MutableRefObject<number>;
  bars?: number;
  className?: string;
  /** Styles each bar — set width / colour / rounding here. */
  barClassName?: string;
}

// Resting bar height (percent of the container).
const BASELINE_PCT = 14;

export function VoiceWaveform({
  mode,
  levelRef,
  bars = 24,
  className,
  barClassName,
}: VoiceWaveformProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // The rAF loop reads these refs so mode/level changes never restart it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const levelSourceRef = useRef(levelRef);
  levelSourceRef.current = levelRef;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const els = Array.from(wrap.children) as HTMLElement[];

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Static, softly varied waveform — communicates "voice" without motion.
      els.forEach((el, i) => {
        el.style.height = `${BASELINE_PCT + Math.abs(Math.sin(i * 0.55)) * 26}%`;
      });
      return;
    }

    let raf = 0;
    // Random phase start so several instances don't move in lockstep.
    let t = Math.random() * 10;
    let env = 0; // smoothed 0–1 amplitude envelope

    const tick = () => {
      const m = modeRef.current;
      let target = 0;
      if (m === "live") {
        target = Math.min(1, levelSourceRef.current?.current ?? 0);
      } else if (m === "ambient") {
        // Slow breathing swell, never fully still.
        target = 0.45 + 0.18 * Math.sin(t * 0.6);
      }
      // Fast attack so speech registers instantly; slow release so the
      // bars glide back down instead of flickering with every frame.
      env += (target - env) * (target > env ? 0.28 : 0.055);
      t += 0.05;

      for (let i = 0; i < els.length; i++) {
        const wave =
          Math.abs(Math.sin(t + i * 0.45)) * 0.6 +
          Math.abs(Math.sin(t * 1.35 + i * 0.19)) * 0.4;
        const h = BASELINE_PCT + wave * env * (96 - BASELINE_PCT);
        els[i].style.height = `${h}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={wrapRef}
      className={cn("flex items-center justify-center gap-[3px]", className)}
      aria-hidden="true"
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn("shrink-0", barClassName)}
          style={{ height: `${BASELINE_PCT}%` }}
        />
      ))}
    </div>
  );
}
