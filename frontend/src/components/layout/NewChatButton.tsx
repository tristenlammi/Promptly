import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Clock, Ghost, MessageSquarePlus } from "lucide-react";

import { cn } from "@/utils/cn";

interface NewChatButtonProps {
  /** When true, renders the compact icon-only variant for collapsed
   *  sidebars (and small mobile contexts in the future). The popover
   *  still works the same way; the trigger is just smaller. */
  compact?: boolean;
}

/**
 * Split button: main click starts a normal new chat; the small caret
 * on the right opens a popover with two extra options:
 *   - Temporary chat (ephemeral) — deleted when the user leaves.
 *   - Temporary 1-hour chat — auto-deletes 1h after the last message.
 *
 * Both temporary modes are passed via the ``?temporary=...`` query
 * param to ``/chat``; ``ChatPage`` reads it and threads it into the
 * lazy ``chatApi.create`` call on first send.
 */
export function NewChatButton({ compact = false }: NewChatButtonProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape so the popover doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const startNormal = () => {
    setOpen(false);
    navigate("/chat");
  };
  const startEphemeral = () => {
    setOpen(false);
    navigate("/chat?temporary=ephemeral");
  };
  const startOneHour = () => {
    setOpen(false);
    navigate("/chat?temporary=one_hour");
  };

  if (compact) {
    return (
      <div ref={popoverRef} className="relative">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={startNormal}
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-full",
              "bg-[var(--accent)] text-white hover:opacity-90"
            )}
            aria-label="New chat"
            title="New chat"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "inline-flex h-9 w-5 items-center justify-center rounded-full",
              "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)]",
              "dark:hover:bg-white/[0.06]"
            )}
            aria-label="More chat types"
            aria-expanded={open}
            title="More chat types"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                open && "rotate-180"
              )}
            />
          </button>
        </div>
        {open && <PopoverMenu onEphemeral={startEphemeral} onOneHour={startOneHour} side="right" />}
      </div>
    );
  }

  return (
    <div ref={popoverRef} className="relative">
      <div className="flex w-full items-stretch gap-px overflow-hidden rounded-input">
        <button
          type="button"
          onClick={startNormal}
          className={cn(
            "flex flex-1 items-center justify-center gap-2 bg-[var(--accent)] px-3 py-2",
            "text-sm font-medium text-white transition hover:opacity-90"
          )}
        >
          <MessageSquarePlus className="h-4 w-4" />
          New chat
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex w-9 items-center justify-center bg-[var(--accent)] text-white",
            "transition hover:opacity-90 border-l border-white/20"
          )}
          aria-label="More chat types"
          aria-expanded={open}
          title="More chat types"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && (
        <PopoverMenu
          onEphemeral={startEphemeral}
          onOneHour={startOneHour}
          side="left"
        />
      )}
    </div>
  );
}

/**
 * The dropdown body — two options + a tiny explainer line each so the
 * difference between the modes is obvious at first glance. Anchored
 * to the trigger via absolute positioning; the parent wrapper handles
 * outside-click dismissal.
 */
function PopoverMenu({
  onEphemeral,
  onOneHour,
  side,
}: {
  onEphemeral: () => void;
  onOneHour: () => void;
  /** Which edge of the trigger to align the popover to. ``left`` for
   *  the expanded sidebar (popover hangs below + flush to the right
   *  edge of the button); ``right`` for the collapsed sidebar where
   *  the trigger lives in a narrow strip. */
  side: "left" | "right";
}) {
  return (
    <div
      role="menu"
      className={cn(
        "absolute z-30 mt-2 w-64 overflow-hidden rounded-card border shadow-lg",
        "border-[var(--border)] bg-[var(--surface)]",
        side === "left" ? "left-0" : "left-full ml-2 top-0 mt-0"
      )}
    >
      <PopoverItem
        onClick={onEphemeral}
        icon={<Ghost className="h-4 w-4" />}
        title="Temporary chat"
        subtitle="Disappears when you leave."
      />
      <div className="border-t border-[var(--border)]" />
      <PopoverItem
        onClick={onOneHour}
        icon={<Clock className="h-4 w-4" />}
        title="Temporary (1 hour)"
        subtitle="Auto-deletes 1h after your last message."
      />
    </div>
  );
}

function PopoverItem({
  onClick,
  icon,
  title,
  subtitle,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className={cn(
        "flex w-full items-start gap-3 px-3 py-2.5 text-left transition",
        "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      )}
    >
      <span className="mt-0.5 text-[var(--accent)]">{icon}</span>
      <span className="flex flex-col">
        <span className="text-sm font-medium text-[var(--text)]">{title}</span>
        <span className="text-xs text-[var(--text-muted)]">{subtitle}</span>
      </span>
    </button>
  );
}
