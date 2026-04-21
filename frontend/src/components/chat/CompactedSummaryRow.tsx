import { useState } from "react";
import { ChevronDown, ChevronUp, Scissors } from "lucide-react";

import { cn } from "@/utils/cn";

/**
 * Inline "compacted summary" marker shown in place of the original
 * middle messages that were collapsed by ``POST /conversations/{id}/compact``.
 *
 * Why a dedicated component: rendering these as regular
 * ``role="assistant"`` bubbles would be misleading ("Promptly said
 * this" — no, the user asked us to compress history). A visually
 * distinct, collapsed-by-default row makes it obvious this is a
 * derived artifact the user can click to read.
 *
 * The component receives the raw system-role message content —
 * including the ``[Compacted summary of N earlier messages]`` prefix
 * the backend stamps on — and extracts the count for the header.
 * Falling back to "a few" if the prefix was stripped keeps the
 * component resilient to manual edits / reimports.
 */

interface Props {
  content: string;
}

const PREFIX_REGEX = /^\[Compacted summary of (\d+) earlier messages?\]\n+/;

export function CompactedSummaryRow({ content }: Props) {
  const [open, setOpen] = useState(false);

  const match = content.match(PREFIX_REGEX);
  const count = match ? match[1] : null;
  const body = match ? content.slice(match[0].length) : content;

  return (
    <div className="mx-auto my-3 max-w-3xl px-4">
      <div
        className={cn(
          "rounded-lg border border-dashed text-xs",
          "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          aria-expanded={open}
        >
          <Scissors className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium text-[var(--text)]">
            Compacted summary
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {count
              ? `· ${count} earlier messages collapsed`
              : "· earlier messages collapsed"}
          </span>
          <span className="ml-auto flex items-center gap-1 text-[10px]">
            {open ? "Hide" : "Show"}
            {open ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </span>
        </button>
        {open && (
          <div className="whitespace-pre-wrap border-t border-[var(--border)] px-3 py-2 text-[var(--text)]">
            {body}
          </div>
        )}
      </div>
    </div>
  );
}

/** Detector the parent ChatWindow uses to decide whether a system
 *  message should render as a CompactedSummaryRow or fall through
 *  to the default bubble path. */
export function isCompactedSummary(role: string, content: string): boolean {
  return role === "system" && PREFIX_REGEX.test(content);
}
