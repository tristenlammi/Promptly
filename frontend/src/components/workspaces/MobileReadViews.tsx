/**
 * Phone read views for boards, rosters and sheets (V9).
 *
 * The desktop editors are wide, pointer-driven grids that don't fit a
 * phone, so a phone used to show "best on desktop" and nothing else — you
 * couldn't even check who's on shift tomorrow or what's left on a board.
 * These are deliberately simple single-column reads of the same data:
 * cards grouped by column, shifts grouped by day, a sheet tab as a
 * scrollable table. Editing stays on the desktop.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Circle, Loader2 } from "lucide-react";

import {
  workspacesApi,
  type BoardColumn,
  type RosterShift,
  type WorkspaceParticipant,
} from "@/api/workspaces";
import { useWorkspaceItem, useWorkspaceTasks } from "@/hooks/useWorkspaces";
import { ErrorState } from "@/components/shared/Callout";
import { cn } from "@/utils/cn";

const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: "todo", name: "To Do" },
  { id: "doing", name: "In Progress" },
  { id: "done", name: "Done", done: true },
];

function Loading() {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-sm text-[var(--text-muted)]">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading…
    </div>
  );
}

function ReadOnlyNote() {
  return (
    <p className="px-4 pb-6 pt-2 text-center text-xs text-[var(--text-muted)]">
      Read-only on a phone — open on a computer to edit.
    </p>
  );
}

export function MobileBoardView({
  workspaceId,
  boardItemId,
  people,
}: {
  workspaceId: string;
  boardItemId: string;
  people: WorkspaceParticipant[];
}) {
  const { data: item } = useWorkspaceItem(workspaceId, boardItemId);
  const { data: tasks, isLoading, isError } = useWorkspaceTasks(workspaceId, boardItemId);
  const names = useMemo(
    () => Object.fromEntries(people.map((p) => [p.user_id, p.username])),
    [people]
  );
  const columns: BoardColumn[] =
    item?.config?.columns && item.config.columns.length > 0
      ? item.config.columns
      : DEFAULT_COLUMNS;
  const [showDone, setShowDone] = useState(false);
  if (isLoading) return <Loading />;
  if (isError) return <ErrorState>Couldn&apos;t load this board.</ErrorState>;
  const byCol = new Map<string, typeof tasks>();
  for (const t of tasks ?? []) {
    byCol.set(t.status, [...(byCol.get(t.status) ?? []), t]);
  }
  return (
    <div className="flex-1 overflow-y-auto">
      {columns
        .filter((c) => showDone || !c.done)
        .map((col) => {
          const cards = (byCol.get(col.id) ?? []).sort((a, b) => a.position - b.position);
          return (
            <section key={col.id} className="border-b border-[var(--border)]">
              <h2 className="sticky top-0 z-[1] flex items-center justify-between bg-[var(--bg)] px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {col.name}
                <span className="font-normal normal-case">{cards.length}</span>
              </h2>
              {cards.length === 0 ? (
                <p className="px-4 pb-3 text-xs text-[var(--text-muted)]">Nothing here.</p>
              ) : (
                <ul>
                  {cards.map((t) => (
                    <li key={t.id} className="flex items-start gap-2 px-4 py-2.5">
                      {col.done || t.done ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
                      ) : (
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-[var(--text)]">{t.title}</div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-[var(--text-muted)]">
                          {t.assignee_user_id && names[t.assignee_user_id] && (
                            <span>{names[t.assignee_user_id]}</span>
                          )}
                          {t.due_at && (
                            <span
                              className={cn(
                                !t.done &&
                                  new Date(t.due_at) < new Date() &&
                                  "text-[var(--danger)]"
                              )}
                            >
                              Due {new Date(t.due_at).toLocaleDateString()}
                            </span>
                          )}
                          {t.priority === "high" && <span>High priority</span>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      {columns.some((c) => c.done) && (
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          className="w-full px-4 py-3 text-left text-xs font-medium text-[var(--accent-text)]"
        >
          {showDone ? "Hide done" : "Show done"}
        </button>
      )}
      <ReadOnlyNote />
    </div>
  );
}

export function MobileRosterView({
  workspaceId,
  rosterId,
  people,
}: {
  workspaceId: string;
  rosterId: string;
  people: WorkspaceParticipant[];
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["workspaces", "roster", workspaceId, rosterId, "mobile"],
    queryFn: () => workspacesApi.getRoster(workspaceId, rosterId),
  });
  const names = useMemo(
    () => Object.fromEntries(people.map((p) => [p.user_id, p.username])),
    [people]
  );
  const [showPast, setShowPast] = useState(false);
  if (isLoading) return <Loading />;
  if (isError) return <ErrorState>Couldn&apos;t load this roster.</ErrorState>;
  const today = new Date().toISOString().slice(0, 10);
  const shifts = (data?.data?.shifts ?? [])
    .filter((s) => showPast || s.date >= today)
    .sort((a, b) => (a.date + (a.start ?? "")).localeCompare(b.date + (b.start ?? "")));
  const byDay = new Map<string, RosterShift[]>();
  for (const s of shifts) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  return (
    <div className="flex-1 overflow-y-auto">
      {byDay.size === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          No upcoming shifts.
        </p>
      ) : (
        [...byDay.entries()].map(([day, list]) => (
          <section key={day} className="border-b border-[var(--border)]">
            <h2 className="sticky top-0 z-[1] flex items-center gap-1.5 bg-[var(--bg)] px-4 py-2 text-xs font-semibold text-[var(--text-muted)]">
              <CalendarDays className="h-3.5 w-3.5" />
              {new Date(day + "T00:00:00").toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "short",
              })}
              {day === today && (
                <span className="rounded-full bg-[var(--accent)]/15 px-1.5 text-[10px] text-[var(--accent-text)]">
                  Today
                </span>
              )}
            </h2>
            <ul>
              {list.map((s) => (
                <li key={s.id} className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 truncate text-[var(--text)]">
                    {names[s.personId] ?? s.personId}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {s.timed && s.start && s.end ? `${s.start}–${s.end}` : `${s.hours}h`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <button
        type="button"
        onClick={() => setShowPast((v) => !v)}
        className="w-full px-4 py-3 text-left text-xs font-medium text-[var(--accent-text)]"
      >
        {showPast ? "Hide past shifts" : "Show past shifts"}
      </button>
      <ReadOnlyNote />
    </div>
  );
}

type SheetTab = { name?: string; celldata?: { r: number; c: number; v: unknown }[] };

function cellText(v: unknown): string {
  if (v && typeof v === "object") {
    const o = v as { m?: unknown; v?: unknown };
    return String(o.m ?? o.v ?? "");
  }
  return v == null ? "" : String(v);
}

export function MobileSheetView({
  workspaceId,
  sheetId,
}: {
  workspaceId: string;
  sheetId: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["workspaces", "sheet", workspaceId, sheetId, "mobile"],
    queryFn: () => workspacesApi.getSpreadsheet(workspaceId, sheetId),
  });
  const [tab, setTab] = useState(0);
  if (isLoading) return <Loading />;
  if (isError) return <ErrorState>Couldn&apos;t load this sheet.</ErrorState>;
  const tabs = ((data?.data ?? []) as SheetTab[]).filter((t) => t && typeof t === "object");
  const current = tabs[Math.min(tab, Math.max(tabs.length - 1, 0))];
  const grid: string[][] = [];
  for (const cell of current?.celldata ?? []) {
    const text = cellText(cell.v);
    if (!text) continue;
    (grid[cell.r] ??= [])[cell.c] = text;
  }
  // Cap what a phone renders; a huge sheet is a desktop job.
  const rows = grid.slice(0, 200);
  const width = Math.min(26, Math.max(0, ...rows.map((r) => (r ? r.length : 0))));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabs.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-3 py-2">
          {tabs.map((t, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setTab(i)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs",
                i === tab
                  ? "bg-[var(--accent)]/15 text-[var(--accent-text)]"
                  : "text-[var(--text-muted)]"
              )}
            >
              {t.name || `Sheet ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">This sheet is empty.</p>
        ) : (
          <table className="border-collapse text-xs">
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? "font-semibold" : undefined}>
                  {Array.from({ length: width }, (_, ci) => (
                    <td
                      key={ci}
                      className="max-w-[12rem] whitespace-nowrap border border-[var(--border)] px-2 py-1 text-[var(--text)]"
                    >
                      {r?.[ci] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {grid.length > rows.length && (
          <p className="px-4 py-2 text-xs text-[var(--text-muted)]">
            Showing the first {rows.length} rows.
          </p>
        )}
      </div>
      <ReadOnlyNote />
    </div>
  );
}
