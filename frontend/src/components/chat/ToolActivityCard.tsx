import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Code2,
  FileText,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  PenLine,
  Search,
  Table,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type {
  AgentProgress,
  PersistedToolCall,
  ToolInvocation,
  ToolProgressData,
} from "@/api/types";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { useItemPreview } from "@/components/workspaces/itemPreviewContext";
import { buildWikiHref } from "@/components/files/documents/WikiLinkExtension";
import { cn } from "@/utils/cn";

/**
 * One quiet "activity" card summarising every tool the assistant ran on
 * a turn — the replacement for the old stack of one-green-pill-per-call.
 *
 * Design intent (matches the approved mockup):
 *  - Neutral surface + hairline border, native to the app. Success is
 *    the expected outcome and gets NO colour; the accent shows only
 *    while a call is running, amber/red only when something failed.
 *  - While streaming, the header line is the *current* step with a
 *    spinner; finished steps settle into a muted timeline below.
 *  - Once the turn lands, it collapses to a one-line summary
 *    ("Searched the web and read 2 pages · 15 sources · 14s"),
 *    expandable on click to see each step (query/host, count, elapsed).
 *
 * Consumes either the live in-flight ``ToolInvocation[]`` (streaming
 * bubble) or the persisted ``PersistedToolCall[]`` (scrollback), both
 * normalised to ``ActivityStep`` so the render path is identical.
 */

type StepStatus = "pending" | "ok" | "error";

interface ActivityStep {
  id: string;
  name: string;
  status: StepStatus;
  errorKind?: string | null;
  elapsedMs?: number | null;
  progressMessage?: string | null;
  progressData?: ToolProgressData | null;
  meta?: Record<string, unknown> | null;
}

/** Per-tool display copy + icon. Unknown tools degrade to a generic
 *  wrench so a newly-shipped tool still renders without a code change. */
const TOOL_INFO: Record<
  string,
  { verb: string; noun: (n: number) => string; icon: typeof Search }
> = {
  web_search: {
    verb: "Searching the web",
    noun: (n) => (n === 1 ? "web search" : "web searches"),
    icon: Search,
  },
  fetch_url: {
    verb: "Reading page",
    noun: (n) => (n === 1 ? "page" : "pages"),
    icon: Globe,
  },
  generate_pdf: {
    verb: "Generating PDF",
    noun: (n) => (n === 1 ? "PDF" : "PDFs"),
    icon: FileText,
  },
  generate_image: {
    verb: "Generating image",
    noun: (n) => (n === 1 ? "image" : "images"),
    icon: ImageIcon,
  },
  code_interpreter: {
    verb: "Running code",
    noun: (n) => (n === 1 ? "code run" : "code runs"),
    icon: Code2,
  },
  run_agents: {
    verb: "Running agents",
    noun: (n) => (n === 1 ? "agent fan-out" : "agent fan-outs"),
    icon: Users,
  },
};

const GENERIC_INFO = {
  verb: "Running tool",
  noun: (n: number) => (n === 1 ? "tool call" : "tool calls"),
  icon: Wrench,
};

function infoFor(name: string) {
  return TOOL_INFO[name] ?? GENERIC_INFO;
}

/** The badge argument for a step — the search query or the fetched
 *  host — so two calls of the same tool read as distinct work. */
function stepArg(step: ActivityStep): string | null {
  const meta = step.meta;
  if (!meta) return null;
  if (step.name === "web_search" && typeof meta.query === "string") {
    return meta.query;
  }
  if (step.name === "fetch_url" && typeof meta.url === "string") {
    try {
      return new URL(meta.url).hostname.replace(/^www\./, "");
    } catch {
      return meta.url;
    }
  }
  return null;
}

/** Compact per-step trailing detail: hit count, files, or "timed out". */
function stepDetail(step: ActivityStep): string | null {
  if (step.status === "error") {
    if (step.errorKind === "timeout") return "timed out";
    // A blocked page isn't a system failure — the site refused a
    // crawler. "unreachable" reads as the benign, expected thing it is.
    if (step.name === "fetch_url") return "unreachable";
    return "failed";
  }
  const meta = step.meta;
  const bits: string[] = [];
  if (meta) {
    // run_agents reports agent_count + merged result_count; lead with
    // the agent count so the row reads "4 agents · 12 sources".
    if (step.name === "run_agents" && typeof meta.agent_count === "number") {
      bits.push(`${meta.agent_count} agent${meta.agent_count === 1 ? "" : "s"}`);
      if (typeof meta.result_count === "number" && meta.result_count > 0) {
        bits.push(`${meta.result_count} source${meta.result_count === 1 ? "" : "s"}`);
      }
    } else if (typeof meta.result_count === "number" && meta.result_count > 0) {
      bits.push(`${meta.result_count} result${meta.result_count === 1 ? "" : "s"}`);
    }
    // The primary search provider came back empty/erroring and a
    // fallback answered — worth a quiet flag so a dying primary is
    // visible in the UI, not just the server logs.
    if (meta.failover === true && typeof meta.provider === "string") {
      bits.push(`via ${meta.provider} (fallback)`);
    }
    // A page that hard-blocked the direct crawler was recovered through
    // Tavily's Extract API.
    if (meta.via_tavily === true) {
      bits.push("via Tavily");
    }
    if (typeof meta.chart_count === "number" && meta.chart_count > 0) {
      bits.push(`${meta.chart_count} chart${meta.chart_count === 1 ? "" : "s"}`);
    } else if (typeof meta.file_count === "number" && meta.file_count > 0) {
      bits.push(`${meta.file_count} file${meta.file_count === 1 ? "" : "s"}`);
    }
  }
  const t = formatElapsed(step.elapsedMs);
  if (t) bits.push(t);
  return bits.length ? bits.join(" · ") : null;
}

function formatElapsed(ms?: number | null): string | null {
  if (ms == null || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** "Searched the web and read 2 pages" — a sentence built by grouping
 *  the SUCCESSFUL steps per tool. Failures are deliberately NOT folded
 *  into the headline: one blocked page (those sites 403 every crawler)
 *  shouldn't make a turn that produced results read as a failure. The
 *  failed steps still show, honestly, on the expanded per-step rows.
 *  Returns "" when nothing succeeded — the caller renders a failure
 *  line in that case. */
function summarise(steps: ActivityStep[]): string {
  const okByTool = new Map<string, number>();
  // Sum of agents fanned out across any run_agents calls, from meta.
  let agentTotal = 0;
  for (const s of steps) {
    if (s.status === "error") continue;
    okByTool.set(s.name, (okByTool.get(s.name) ?? 0) + 1);
    if (s.name === "run_agents" && typeof s.meta?.agent_count === "number") {
      agentTotal += s.meta.agent_count;
    }
  }
  const clauses: string[] = [];
  for (const [name, count] of okByTool) {
    const info = infoFor(name);
    // "Searched the web", "read 2 pages" — first clause carries the
    // verb capitalised, later ones lower-case for the "and" join.
    const past = pastVerb(info.verb);
    if (name === "run_agents") {
      const n = agentTotal || count;
      clauses.push(`Ran ${n} agent${n === 1 ? "" : "s"} in parallel`);
    } else if (name === "web_search") {
      clauses.push(count === 1 ? past : `${past} (${count}×)`);
    } else {
      clauses.push(`${past} ${count} ${info.noun(count)}`);
    }
  }
  return clauses.length ? joinClauses(clauses) : "";
}

/** Headline for the rare case where EVERY step errored — the only
 *  time the card should read as a genuine failure. */
function failureSummary(steps: ActivityStep[]): string {
  const names = new Set(steps.map((s) => s.name));
  if (names.size === 1) {
    const only = [...names][0];
    if (only === "web_search") return "Web search failed";
    if (only === "fetch_url") return "Couldn't read the page";
    if (only === "run_agents") return "Agents couldn't complete";
  }
  return "Tool calls didn't complete";
}

/** Map the present-participle verb to a past-tense summary verb. */
function pastVerb(verb: string): string {
  switch (verb) {
    case "Searching the web":
      return "Searched the web";
    case "Reading page":
      return "read";
    case "Generating PDF":
      return "generated";
    case "Generating image":
      return "generated";
    case "Running code":
      return "ran";
    case "Running agents":
      return "ran agents";
    default:
      return "ran";
  }
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  const head = clauses.slice(0, -1).join(", ");
  const tail = clauses[clauses.length - 1];
  // First clause keeps its capital; join the rest with "and".
  return `${head} and ${tail}`;
}

/** Growing progress-bar width for one agent. We don't have a true %,
 *  so map the agent's tool-step count to an ever-advancing fill that
 *  eases toward — but never reaches — full while running; done snaps to
 *  100%. Reads as real progress without fabricating a number. */
function agentWidth(a: AgentProgress): number {
  if (a.status !== "running") return 100;
  return Math.min(85, 18 + a.activity * 16);
}

/** One sub-agent's live row — the terracotta-accented mini-card from
 *  the mockup: label + task, a status glyph, a growing progress bar,
 *  and the agent's own "reading dxomark.com" sub-status underneath. */
function AgentRow({ agent }: { agent: AgentProgress }) {
  const running = agent.status === "running";
  const failed = agent.status === "failed";
  return (
    <div className="rounded-md border border-[var(--border)] border-l-2 border-l-[var(--accent)] bg-[var(--bg)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium text-[var(--accent)]">
          {agent.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">
          {agent.task}
        </span>
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
        ) : failed ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success)] stroke-[2.5]" />
        )}
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            failed ? "bg-[var(--warning)]" : "bg-[var(--accent)]",
            running && "animate-pulse",
          )}
          style={{ width: `${agentWidth(agent)}%` }}
        />
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
        {agent.detail}
        {running && "…"}
      </div>
    </div>
  );
}

/** The full live fan-out card — header pill + one AgentRow per agent. */
function AgentFanout({ agents }: { agents: AgentProgress[] }) {
  const done = agents.filter((a) => a.status !== "running").length;
  const allDone = done === agents.length;
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <span className="shrink-0 rounded-md bg-[var(--accent)]/10 px-2 py-0.5 font-mono text-[11px] text-[var(--accent)]">
          run_agents
        </span>
        <span className="text-[13px] text-[var(--text-muted)]">
          {allDone
            ? `${agents.length} agents finished`
            : `Fanning out ${agents.length} research agents…`}
        </span>
        {!allDone && (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
            {done}/{agents.length}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3">
        {agents.map((a) => (
          <AgentRow key={a.label} agent={a} />
        ))}
      </div>
    </div>
  );
}

export function ToolActivityCard({
  steps,
  streaming,
}: {
  steps: ActivityStep[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);

  // The card is "in progress" for the whole stream, NOT only while a tool
  // call is mid-flight. Keying the layout on "is a step pending" made it
  // strobe open/closed between tool calls: for a beat between one call
  // finishing and the next starting (and while the final answer streams),
  // no step is pending, so it fell through to the collapsed finished view,
  // then snapped back when the next call began. Gate on `streaming` so the
  // live card stays put until the turn actually ends.
  const inProgress = streaming;
  const current = inProgress
    ? steps.find((s) => s.status === "pending") ?? null
    : null;

  // A live run_agents fan-out owns the card: show the per-agent view
  // (the mockup) rather than a single "Running agents…" line.
  const liveAgents = inProgress
    ? steps.find(
        (s) =>
          s.status === "pending" &&
          s.name === "run_agents" &&
          (s.progressData?.agents?.length ?? 0) > 0,
      )?.progressData?.agents ?? null
    : null;

  const totalMs = useMemo(
    () => steps.reduce((sum, s) => sum + (s.elapsedMs ?? 0), 0),
    [steps],
  );
  const sourceCount = useMemo(
    () =>
      steps.reduce((sum, s) => {
        const rc = s.meta?.result_count;
        return sum + (typeof rc === "number" ? rc : 0);
      }, 0),
    [steps],
  );
  // Workspace items a tool touched (read_workspace_item, query_board_cards)
  // surface as clickable pills under the card. Dedupe by id across steps.
  const linkedItems = useMemo(() => collectLinkedItems(steps), [steps]);

  if (steps.length === 0) return null;

  // ---- Live run_agents fan-out (the rich per-agent view) ----
  if (liveAgents) {
    return <AgentFanout agents={liveAgents} />;
  }

  // ---- While the turn is in progress: live header + settled timeline,
  //      always open. Between tool calls (and while the final answer
  //      streams) no step is pending — show a neutral "Working…" header
  //      instead of collapsing, so the card never strobes. ----
  if (inProgress) {
    const info = current ? infoFor(current.name) : null;
    const arg = current ? stepArg(current) : null;
    return (
      <>
      <div className="mt-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
          <span className="truncate">
            {info ? (
              <>
                <span className="text-[var(--text)]">{info.verb}</span>
                {arg && (
                  <span className="text-[var(--text-muted)]">
                    {" "}
                    <span className="text-[var(--text)]">{arg}</span>
                  </span>
                )}
                …
                {current?.progressMessage && (
                  <span className="text-[var(--text-muted)]">
                    {" · "}
                    {current.progressMessage}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[var(--text)]">Working…</span>
            )}
          </span>
        </div>
        {steps.some((s) => s.status !== "pending") && (
          <div className="flex flex-col gap-1 border-t border-[var(--border)] px-3 py-1.5">
            {steps
              .filter((s) => s.status !== "pending")
              .map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
          </div>
        )}
      </div>
      <ItemPillRow items={linkedItems} />
      </>
    );
  }

  // A finished run_agents turn collapses to the one-liner like every
  // other tool, but its EXPANDED body is the full per-agent fan-out +
  // green summary footer (matching the mock) rather than plain rows.
  const finishedAgentStep = steps.find(
    (s) =>
      (s.status === "ok" || s.status === "error") &&
      s.name === "run_agents" &&
      Array.isArray(s.meta?.agents),
  );

  // ---- Finished: collapsed one-line summary, expandable ----
  // The card reads as a failure ONLY when nothing succeeded. A turn
  // with any successful work is a success, even if a blocked page or
  // two failed along the way (those failures stay visible on expand).
  const okCount = steps.filter((s) => s.status === "ok").length;
  const allFailed = okCount === 0;
  const summary = allFailed ? failureSummary(steps) : summarise(steps);
  const metaBits: string[] = [];
  if (sourceCount > 0)
    metaBits.push(`${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
  const totalT = formatElapsed(totalMs);
  if (totalT) metaBits.push(totalT);

  return (
    <>
    <div className="mt-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--text-muted)] transition hover:bg-[var(--hover)]"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        {allFailed ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        )}
        <span className="truncate text-[var(--text)]">{summary}</span>
        {metaBits.length > 0 && (
          <span className="shrink-0 text-[var(--text-muted)]">
            · {metaBits.join(" · ")}
          </span>
        )}
      </button>
      {open &&
        (finishedAgentStep ? (
          <AgentsExpanded
            agents={finishedAgentStep.meta!.agents as FinishedAgent[]}
            sourceCount={sourceCount}
          />
        ) : (
          <div className="flex flex-col gap-1.5 border-t border-[var(--border)] px-3 py-2">
            {steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </div>
        ))}
    </div>
    <ItemPillRow items={linkedItems} />
    </>
  );
}

// ---------------------------------------------------------------------
// Item-link pills — clickable chips under the card that open a workspace
// item (a note/board/sheet/canvas a tool read) in the preview modal.
// ---------------------------------------------------------------------
interface LinkedItem {
  id: string;
  kind: string;
  ref_id: string | null;
  title: string;
  workspace_id: string;
}

/** Pull the ``items`` a tool emitted in its meta, deduped by id, in the
 *  order first seen. Tolerant of the loosely-typed ``meta`` bag. */
function collectLinkedItems(steps: ActivityStep[]): LinkedItem[] {
  const seen = new Set<string>();
  const out: LinkedItem[] = [];
  for (const s of steps) {
    const raw = s.meta?.items;
    if (!Array.isArray(raw)) continue;
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : null;
      const workspace_id =
        typeof o.workspace_id === "string" ? o.workspace_id : null;
      if (!id || !workspace_id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: typeof o.kind === "string" ? o.kind : "note",
        ref_id: typeof o.ref_id === "string" ? o.ref_id : null,
        title: typeof o.title === "string" ? o.title : "Untitled",
        workspace_id,
      });
    }
  }
  return out;
}

const ITEM_KIND_ICON: Record<string, LucideIcon> = {
  note: FileText,
  board: LayoutGrid,
  sheet: Table,
  canvas: PenLine,
};

function ItemPillRow({ items }: { items: LinkedItem[] }) {
  const preview = useItemPreview();
  const navigate = useNavigate();
  if (items.length === 0) return null;

  const open = (item: LinkedItem) => {
    if (preview) {
      const node: WorkspaceItemNode = {
        id: item.id,
        kind: item.kind as WorkspaceItemNode["kind"],
        ref_id: item.ref_id,
        title: item.title,
        icon: null,
        position: 0,
        indexing_status: null,
        children: [],
      };
      preview(node);
      return;
    }
    // No preview provider on this surface (chat rendered outside the
    // workspace detail page) — navigate to the item in the workspace.
    navigate(
      buildWikiHref({
        id: item.id,
        kind: item.kind,
        refId: item.ref_id,
        title: item.title,
        workspaceId: item.workspace_id,
      }),
    );
  };

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((item) => {
        const Icon = ITEM_KIND_ICON[item.kind] ?? FileText;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => open(item)}
            title={`Open "${item.title}"`}
            className={cn(
              "inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-1",
              "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[12px] font-medium text-[var(--accent)]",
              "transition hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/15",
            )}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate">{item.title}</span>
          </button>
        );
      })}
    </div>
  );
}

interface FinishedAgent {
  task?: string;
  ok?: boolean;
  tool_calls?: number;
  sources?: number;
}

/** The expanded body of a finished run_agents card — the full per-agent
 *  fan-out (reusing the settled AgentRow) plus the green summary footer,
 *  matching the mock. Container-less: it slots inside the collapsible
 *  card, so the collapsed one-liner stays the default. */
function AgentsExpanded({
  agents,
  sourceCount,
}: {
  agents: FinishedAgent[];
  sourceCount: number;
}) {
  const okCount = agents.filter((a) => a.ok !== false).length;
  const rows: AgentProgress[] = agents.map((a, i) => ({
    label: `Agent ${i + 1}`,
    task: a.task || "research task",
    status: a.ok === false ? "failed" : "done",
    detail: a.ok === false ? "couldn't complete" : "brief returned",
    activity: 0,
  }));
  return (
    <div className="border-t border-[var(--border)]">
      <div className="flex flex-col gap-2 p-3">
        {rows.map((a) => (
          <AgentRow key={a.label} agent={a} />
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2.5 text-[13px] text-[var(--success)]">
        <Check className="h-3.5 w-3.5 shrink-0 stroke-[2.5]" />
        <span className="truncate">
          Merged {okCount} brief{okCount === 1 ? "" : "s"}
          {sourceCount > 0 &&
            ` · ${sourceCount} source${sourceCount === 1 ? "" : "s"}`}{" "}
          · citations de-duplicated
        </span>
      </div>
    </div>
  );
}

/** One row in the expanded / streaming timeline. */
function StepRow({ step }: { step: ActivityStep }) {
  const info = infoFor(step.name);
  const Icon = info.icon;
  const arg = stepArg(step);
  const detail = stepDetail(step);
  const isError = step.status === "error";

  // A hard failure tints the accent rail amber; everything else keeps
  // the terracotta rail so the whole card reads as one cohesive family.
  const hardError = isError && step.errorKind !== "per_turn_cap";
  return (
    <div
      className={cn(
        "rounded-md border border-[var(--border)] border-l-2 bg-[var(--bg)] px-2.5 py-1.5",
        hardError ? "border-l-[var(--warning)]" : "border-l-[var(--accent)]",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {isError ? (
          step.errorKind === "timeout" || step.errorKind === "per_turn_cap" ? (
            <AlertTriangle className="h-3 w-3 shrink-0 text-[var(--warning)]" />
          ) : (
            <X className="h-3 w-3 shrink-0 text-[var(--danger)]" />
          )
        ) : (
          <Icon className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
          <span className="text-[var(--text)]">{pastVerb(info.verb)}</span>
          {arg && <span> {arg}</span>}
        </span>
        {detail && (
          <span
            className={cn(
              "shrink-0 tabular-nums",
              hardError ? "text-[var(--warning)]" : "text-[var(--text-muted)]",
            )}
          >
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Normalisers — collapse either source shape into ``ActivityStep[]``.
// --------------------------------------------------------------------

/** Drop benign per-turn-cap failures when a same-tool call already
 *  succeeded — a capped 6th search after 5 good ones is budget noise,
 *  not something the user needs flagged. Pending entries always
 *  survive (in-flight UX). Shared by both normalisers so live and
 *  scrollback agree. */
function suppressBenignFailures(steps: ActivityStep[]): ActivityStep[] {
  const okTools = new Set(
    steps.filter((s) => s.status === "ok").map((s) => s.name),
  );
  return steps.filter(
    (s) =>
      !(
        s.status === "error" &&
        s.errorKind === "per_turn_cap" &&
        okTools.has(s.name)
      ),
  );
}

/** Live in-flight invocations (streaming bubble). */
export function stepsFromInvocations(
  invocations: ToolInvocation[] | null | undefined,
): ActivityStep[] {
  if (!invocations || invocations.length === 0) return [];
  return suppressBenignFailures(
    invocations.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      errorKind: t.errorKind ?? null,
      elapsedMs: t.elapsedMs ?? null,
      progressMessage: t.progressMessage ?? null,
      progressData: t.progressData ?? null,
      meta: t.meta ?? null,
    })),
  );
}

/** Persisted per-turn log (scrollback). ``per_turn_cap`` overshoots are
 *  dropped when a same-tool call already succeeded — they're benign
 *  budget noise, exactly as the live consolidation rule treats them. */
export function stepsFromPersisted(
  calls: PersistedToolCall[] | null | undefined,
): ActivityStep[] {
  if (!calls || calls.length === 0) return [];
  return suppressBenignFailures(
    calls.map((c) => ({
      id: c.id,
      name: c.name,
      status: (c.ok ? "ok" : "error") as StepStatus,
      errorKind: c.error_kind ?? null,
      elapsedMs: c.elapsed_ms ?? null,
      meta: c.meta ?? null,
    })),
  );
}
