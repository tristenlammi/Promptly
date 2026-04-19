import { Check, Loader2, X } from "lucide-react";

import type { ToolInvocation } from "@/api/types";
import { cn } from "@/utils/cn";

interface ToolStatusBlockProps {
  invocation: ToolInvocation;
}

/** Inline, in-flight status pill for a single tool the AI is calling
 *  on the current turn. Renders three states (pending → ok / error)
 *  with a tool-aware label so the chip reads naturally
 *  ("Searching the web…", "Generated PDF") instead of leaking the
 *  raw tool name back at the user.
 *
 *  Single-icon design: one leading glyph that mirrors the status —
 *  spinner while running, green check on success, red cross on
 *  failure — followed by the human-readable label and any compact
 *  meta badges (cost, hit count, etc.). The action-specific icon
 *  (search glass, globe, file…) stays out of the chip itself so the
 *  status icon never has to compete with it. */
export function ToolStatusBlock({ invocation }: ToolStatusBlockProps) {
  const meta = TOOL_PRESENTATION[invocation.name] ?? DEFAULT_PRESENTATION;

  const label =
    invocation.status === "pending"
      ? meta.pending
      : invocation.status === "ok"
        ? meta.done
        : meta.failed;

  const StatusIcon =
    invocation.status === "pending"
      ? Loader2
      : invocation.status === "ok"
        ? Check
        : X;

  return (
    <div
      role={invocation.status === "error" ? "alert" : "status"}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs",
        "transition-colors",
        invocation.status === "pending" &&
          "border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] text-[var(--accent)]",
        invocation.status === "ok" &&
          "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300",
        invocation.status === "error" &&
          "border-red-500/30 bg-red-500/[0.07] text-red-600 dark:text-red-400"
      )}
    >
      <StatusIcon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          invocation.status === "pending" && "animate-spin",
          invocation.status === "ok" && "stroke-[2.5]",
          invocation.status === "error" && "stroke-[2.5]"
        )}
        aria-hidden
      />
      <span className="truncate font-medium">{label}</span>
      {invocation.status === "ok" && (
        <ToolMetaBadges meta={invocation.meta} />
      )}
      {invocation.status === "error" && invocation.error && (
        <span
          className="truncate text-[var(--text-muted)]"
          title={invocation.error}
        >
          · {invocation.error}
        </span>
      )}
    </div>
  );
}

interface ToolPresentation {
  pending: string;
  done: string;
  failed: string;
}

/** Per-tool display metadata. The user only ever sees ``pending`` /
 *  ``done`` / ``failed`` here — the raw tool name (``web_search``,
 *  ``fetch_url``, ...) stays in the SSE wire format and the API
 *  schema, but never leaks into the chat UI.
 *
 *  Adding a new tool is a one-line edit here. Tools that aren't
 *  registered fall back to ``DEFAULT_PRESENTATION`` (a generic
 *  "Running tool" line) so unknown tools still render gracefully.
 */
const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  web_search: {
    pending: "Searching the web…",
    done: "Searched the web",
    failed: "Web search failed",
  },
  fetch_url: {
    pending: "Reading page…",
    done: "Read page",
    failed: "Couldn't read page",
  },
  generate_pdf: {
    pending: "Generating PDF…",
    done: "Generated PDF",
    failed: "PDF generation failed",
  },
  generate_image: {
    pending: "Generating image…",
    done: "Generated image",
    failed: "Image generation failed",
  },
  // Internal / debug tools — kept friendly in case they ever surface.
  echo: {
    pending: "Running diagnostic…",
    done: "Diagnostic complete",
    failed: "Diagnostic failed",
  },
  attach_demo_file: {
    pending: "Attaching demo file…",
    done: "Attached demo file",
    failed: "Demo attach failed",
  },
};

const DEFAULT_PRESENTATION: ToolPresentation = {
  pending: "Running tool…",
  done: "Tool complete",
  failed: "Tool failed",
};

/** Inline model / hit-count badges rendered next to a successful tool call.
 *
 * Tool ``meta`` is opaque on the wire (every tool emits its own
 * shape), so we look for a small set of *known* keys and render them
 * as compact pills. Unknown keys are ignored so adding a new field on
 * the backend never breaks rendering.
 *
 * Surfaces:
 *  * ``model_id``  — which image model actually ran
 *  * ``edited``    — whether the call edited an uploaded image
 *  * ``result_count`` — number of search hits returned (web_search)
 *
 * NOTE: The ``cost_usd`` field used to render here as a green pill on
 * every tool chip. That's been moved to a sibling info-icon next to
 * the message-stats icon ({@link MessageStats}) so cost shows up once
 * per assistant message rather than once per tool call. The backend
 * still includes ``cost_usd`` in tool meta for analytics / debug
 * purposes — we just don't surface it twice.
 */
function ToolMetaBadges({
  meta,
}: {
  meta?: Record<string, unknown> | null;
}) {
  if (!meta) return null;
  const modelId =
    typeof meta.model_id === "string" && meta.model_id.length > 0
      ? meta.model_id
      : null;
  const edited = meta.edited === true;
  const resultCount =
    typeof meta.result_count === "number" ? meta.result_count : null;

  if (modelId === null && !edited && resultCount === null) {
    return null;
  }

  return (
    <span className="ml-0.5 inline-flex items-center gap-1">
      {resultCount !== null && (
        <span
          className={cn(
            "rounded-md border px-1.5 py-px text-[10px] font-medium tabular-nums",
            "border-current/30 opacity-80"
          )}
          title={`${resultCount} result${resultCount === 1 ? "" : "s"}`}
        >
          {resultCount} hit{resultCount === 1 ? "" : "s"}
        </span>
      )}
      {edited && (
        <span
          className="rounded-md border border-current/30 px-1.5 py-px text-[10px] font-medium opacity-80"
          title="This image was generated from your uploaded source"
        >
          edit
        </span>
      )}
      {modelId !== null && (
        <span
          className="hidden truncate text-[10px] opacity-60 sm:inline"
          title={modelId}
        >
          · {modelId}
        </span>
      )}
    </span>
  );
}

