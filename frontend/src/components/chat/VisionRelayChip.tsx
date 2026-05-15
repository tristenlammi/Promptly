import { useState } from "react";
import { Check, ChevronDown, Eye, Loader2, X } from "lucide-react";

import type { VisionRelayInvocation } from "@/api/types";
import { cn } from "@/utils/cn";

interface VisionRelayChipProps {
  invocation: VisionRelayInvocation;
}

/** Inline status pill for one vision-relay captioning call.
 *
 * Renders three states (pending → ok / error) and matches the look of
 * the regular tool-call chip ({@link ./ToolStatusBlock}) so users
 * don't have to learn a new pattern. The relay model name shows in
 * the chip body so it's obvious *who* is captioning the image, and
 * the successful chip is expandable to reveal the caption text — a
 * small transparency win, since the user is otherwise relying on a
 * model output they can't see.
 *
 * Why a distinct component:
 *
 *   - The relay isn't an LLM tool call, it's a preprocessing step on
 *     the user's input. Lumping it into ``ToolStatusBlock`` would
 *     require teaching the tool-presentation map about a non-tool
 *     event, plus the "Image #N" prefix needs special handling.
 *   - The expand-to-reveal-caption affordance is unique to relay
 *     chips; tool chips don't expose their internals.
 *   - Distinct chip styling (eye icon, indigo accent) signals "this
 *     is a vision relay, not a regular tool" at a glance — important
 *     because the fact that the model can't see images natively is
 *     itself information the user should notice.
 */
export function VisionRelayChip({ invocation }: VisionRelayChipProps) {
  const [expanded, setExpanded] = useState(false);

  const StatusIcon =
    invocation.status === "pending"
      ? Loader2
      : invocation.status === "ok"
        ? Check
        : X;

  const label =
    invocation.status === "pending"
      ? `Captioning image #${invocation.index}…`
      : invocation.status === "ok"
        ? `Image #${invocation.index} captioned`
        : `Image #${invocation.index} caption failed`;

  // Strip provider-name prefix when the model id already includes it
  // (e.g. some Gemini models report as ``gemini-2.0-flash``) so the
  // chip doesn't read "Gemini · gemini-2.0-flash". Cheap heuristic;
  // exact-match displays still get the cleaner shape.
  const modelLabel = invocation.relayModelId || invocation.relayProviderName;
  const canExpand =
    invocation.status === "ok" && !!invocation.caption && invocation.caption.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        role={invocation.status === "error" ? "alert" : "status"}
        aria-expanded={canExpand ? expanded : undefined}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs",
          "transition-colors",
          canExpand && "cursor-pointer hover:opacity-90",
          !canExpand && "cursor-default",
          invocation.status === "pending" &&
            "border-indigo-500/30 bg-indigo-500/[0.07] text-indigo-700 dark:text-indigo-300",
          invocation.status === "ok" &&
            "border-indigo-500/30 bg-indigo-500/[0.07] text-indigo-700 dark:text-indigo-300",
          invocation.status === "error" &&
            "border-red-500/30 bg-red-500/[0.07] text-red-600 dark:text-red-400",
        )}
        title={
          invocation.status === "error"
            ? invocation.error ?? "Captioning failed"
            : canExpand
              ? "Click to expand the caption"
              : invocation.filename
        }
      >
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <StatusIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            invocation.status === "pending" && "animate-spin",
            invocation.status === "ok" && "stroke-[2.5]",
            invocation.status === "error" && "stroke-[2.5]",
          )}
          aria-hidden
        />
        <span className="truncate font-medium">{label}</span>
        <span
          className="hidden truncate text-[var(--text-muted)] sm:inline"
          title={modelLabel}
        >
          · via {modelLabel}
        </span>
        {invocation.status === "error" && invocation.error && (
          <span
            className="truncate text-[var(--text-muted)]"
            title={invocation.error}
          >
            · {invocation.error}
          </span>
        )}
        {canExpand && (
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 opacity-60 transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </button>
      {canExpand && expanded && invocation.caption && (
        <div
          className={cn(
            "max-w-prose self-start rounded-card border px-3 py-2 text-xs leading-snug",
            "border-indigo-500/20 bg-indigo-500/[0.04] text-[var(--text-muted)]",
          )}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-70">
            <Eye className="h-3 w-3" aria-hidden />
            <span>Caption sent to chat model</span>
            {invocation.filename && (
              <span className="ml-auto truncate" title={invocation.filename}>
                {invocation.filename}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words">{invocation.caption}</p>
        </div>
      )}
    </div>
  );
}
