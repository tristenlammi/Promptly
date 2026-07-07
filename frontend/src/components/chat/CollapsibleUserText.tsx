import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/utils/cn";

// Collapsed height (~9 lines at text-sm) and the height a message has to
// exceed before it's worth clamping at all — a message only a line or two
// over the cap shouldn't sprout a toggle.
const COLLAPSED_MAX_PX = 216;
const COLLAPSE_TRIGGER_PX = 300;

/**
 * Clamps a long user message to a few lines with a Show more / Show less
 * toggle, so a wall-of-text prompt doesn't make you scroll past it every
 * time you revisit the thread. Long messages start collapsed; short ones
 * render untouched with no toggle.
 */
export function CollapsibleUserText({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsible, setCollapsible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight reports the full content height even while the element
    // is max-height clamped, so this measures correctly in either state.
    const measure = () =>
      setCollapsible(el.scrollHeight > COLLAPSE_TRIGGER_PX);
    measure();
    // Re-evaluate on reflow (window resize / rotation): wrapping changes
    // the height, and therefore whether the toggle is warranted.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clamp = collapsible && !expanded;

  return (
    <div>
      <div
        ref={ref}
        className="overflow-hidden"
        style={
          clamp
            ? {
                maxHeight: COLLAPSED_MAX_PX,
                // Fade the last couple of lines to transparent so it reads
                // as "there's more" regardless of the bubble's background.
                WebkitMaskImage:
                  "linear-gradient(to bottom, #000 68%, transparent)",
                maskImage: "linear-gradient(to bottom, #000 68%, transparent)",
              }
            : undefined
        }
      >
        {children}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] transition hover:opacity-80"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-180",
            )}
          />
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
