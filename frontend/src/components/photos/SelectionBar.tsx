import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "@/utils/cn";

import "./photos.css";

export interface SelectionAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

/**
 * What you can do with the photos you've ticked: a bar that floats over the
 * top of the grid, so picking the first photo doesn't push the page down.
 * Buttons are 40px; on a narrow screen they show their icon only (the name
 * is still there for a long press, a hover and screen readers). Escape
 * clears the selection.
 *
 * Put it inside a ``relative`` box that holds the grid.
 */
export function SelectionBar({
  count,
  onClear,
  actions,
  escape = true,
}: {
  count: number;
  onClear: () => void;
  actions: SelectionAction[];
  /** Off while something is open on top (the viewer, a dialog). */
  escape?: boolean;
}) {
  const clear = useRef(onClear);
  clear.current = onClear;
  useEffect(() => {
    if (!escape || count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog or menu that is open gets Escape first.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      clear.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [escape, count]);

  if (count === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2">
      <div
        role="toolbar"
        aria-label="Selected photos"
        className="photos-bar-in pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
      >
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text)] hover:bg-[var(--hover)]"
        >
          <X className="h-4 w-4" />
        </button>
        <span aria-live="polite" className="mr-1 shrink-0 whitespace-nowrap text-sm font-medium text-[var(--text)]">
          {count} <span className="hidden min-[420px]:inline">selected</span>
        </span>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            aria-label={a.label}
            title={a.label}
            className={cn(
              "flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs hover:bg-[var(--hover)]",
              a.danger ? "text-red-500" : "text-[var(--text)]",
            )}
          >
            <span className="flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">{a.icon}</span>
            <span className="hidden whitespace-nowrap lg:inline">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
