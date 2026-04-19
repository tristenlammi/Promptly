import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/utils/cn";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Initial left-pane width as a percentage of the container (0–100). */
  initialLeftPercent?: number;
  minLeftPercent?: number;
  maxLeftPercent?: number;
  storageKey?: string;
}

/**
 * Dead-simple horizontal split pane with a draggable divider. Kept in-house
 * to avoid pulling in another dependency for a single pixel-wide handle.
 */
export function SplitPane({
  left,
  right,
  initialLeftPercent = 40,
  minLeftPercent = 25,
  maxLeftPercent = 70,
  storageKey,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [leftPct, setLeftPct] = useState<number>(() => {
    if (!storageKey) return initialLeftPercent;
    const saved = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= minLeftPercent && saved <= maxLeftPercent) {
      return saved;
    }
    return initialLeftPercent;
  });
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!storageKey) return;
    window.localStorage.setItem(storageKey, String(leftPct));
  }, [leftPct, storageKey]);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(maxLeftPercent, Math.max(minLeftPercent, pct));
      setLeftPct(clamped);
    },
    [minLeftPercent, maxLeftPercent]
  );

  const onMouseUp = useCallback(() => {
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  const onMouseDown = () => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div ref={containerRef} className="flex h-full w-full min-h-0">
      <div
        className="min-w-0 flex-none"
        style={{ width: `${leftPct}%` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onMouseDown}
        className={cn(
          "relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center",
          "bg-[var(--border)] transition hover:bg-[var(--accent)]/40"
        )}
        title="Drag to resize"
      >
        <span
          aria-hidden
          className="absolute inset-y-4 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-transparent"
        />
      </div>
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}
