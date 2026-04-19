import { Wrench } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

interface ToolsToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

/**
 * Wrench button in the input bar that opts the *next* send into the AI
 * tool-calling loop (Phase A1: ``echo`` + ``attach_demo_file``; later
 * phases: image gen, PDF authoring, etc.).
 *
 * Mirrors :func:`WebSearchToggle`'s shape so the affordance is visually
 * consistent. Per-session, not persisted: the parent page (ChatPage)
 * owns the boolean and resets it when the active conversation changes,
 * matching the web-search toggle's behaviour. We don't bind it to the
 * conversation row because tool use is a one-off intent (hop count,
 * cost, latency) the user might want for *this* turn but not the next.
 */
export function ToolsToggle({
  enabled,
  onToggle,
  disabled,
}: ToolsToggleProps) {
  const isMobile = useIsMobile();
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      disabled={disabled}
      aria-pressed={enabled}
      aria-label={enabled ? "Disable AI tools" : "Enable AI tools"}
      title={
        enabled
          ? "AI tools on — the model can call functions for this turn"
          : "Enable AI tools (echo, file generation, more coming)"
      }
      className={cn(
        "inline-flex items-center rounded-full border transition",
        "disabled:cursor-not-allowed disabled:opacity-40",
        // Mobile collapses to an icon-only circle to match the
        // WebSearchToggle and Attach button. Active state is carried
        // by the accent ring + accent icon — no text needed.
        isMobile
          ? "h-9 w-9 justify-center"
          : "h-8 gap-1.5 px-2.5 text-xs",
        enabled
          ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
          : "border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      <Wrench className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
      {!isMobile && (
        // Phase A polish: keep the label visible even when the toggle
        // is off (desktop). Hiding it on a per-session boolean made the
        // affordance easy to miss for users who didn't know the icon
        // meant "tools".
        <span className="font-medium">Tools</span>
      )}
    </button>
  );
}
