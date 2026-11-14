import { MessagesSquare, Share2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Sheet } from "@/components/shared/Sheet";

/**
 * "Share" with a choice: send it in a Rooms conversation (it opens there as
 * a draft, and nothing goes until you press Send), or hand it to the phone's
 * own share sheet / the clipboard as before.
 */
export function ShareWaysSheet({
  open,
  onClose,
  title = "Share",
  what,
  onRooms,
  onOther,
  otherLabel,
  otherHint,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** A line saying what's being shared. */
  what?: ReactNode;
  onRooms: () => void;
  onOther: () => void;
  otherLabel?: string;
  otherHint?: string;
}) {
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <Sheet open={open} onClose={onClose} title={title} size="sm">
      {what && <p className="mb-2 truncate text-sm text-[var(--text-muted)]">{what}</p>}
      <div className="-mx-1 flex flex-col">
        <Way
          icon={MessagesSquare}
          label="Send in Rooms"
          hint="Pick a conversation. It waits there until you press Send."
          onClick={() => {
            onClose();
            onRooms();
          }}
        />
        <Way
          icon={Share2}
          label={otherLabel ?? (canShare ? "Share another way" : "Copy")}
          hint={otherHint ?? (canShare ? "Another app on this device" : "Copy it to paste somewhere else")}
          onClick={() => {
            onClose();
            onOther();
          }}
        />
      </div>
    </Sheet>
  );
}

function Way({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent-text)]">
        <Icon className="h-5 w-5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-[var(--text)]">{label}</span>
        <span className="text-xs text-[var(--text-muted)]">{hint}</span>
      </span>
    </button>
  );
}
