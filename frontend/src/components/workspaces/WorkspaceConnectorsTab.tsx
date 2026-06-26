import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug } from "lucide-react";

import { mcpApi, type WorkspaceConnector } from "@/api/mcp";
import { cn } from "@/utils/cn";

/**
 * Workspace-owner control for switching ``workspace``-scoped MCP connectors
 * on for this workspace. Members see the list read-only; only the owner can
 * change it. Admins decide which connectors are workspace-available.
 */
export function WorkspaceConnectorsTab({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const [items, setItems] = useState<WorkspaceConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await mcpApi.listWorkspaceConnectors(workspaceId));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (c: WorkspaceConnector) => {
    if (!isOwner || saving) return;
    const next = items.map((it) =>
      it.id === c.id ? { ...it, attached: !it.attached } : it
    );
    setItems(next);
    setSaving(true);
    try {
      await mcpApi.setWorkspaceConnectors(
        workspaceId,
        next.filter((it) => it.attached).map((it) => it.id)
      );
    } catch {
      void load(); // revert to server truth on failure
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        Switch on the connectors this workspace's chats can use. Only
        connectors an admin made available to workspaces appear here.
      </p>

      {items.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          <Plug className="mx-auto mb-2 h-5 w-5 opacity-50" />
          No workspace connectors available. An admin can add an MCP connector
          with “restricted” availability and attach it to this workspace.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--text)]">
                  {c.name}
                  {!c.enabled && (
                    <span className="ml-2 text-[10px] uppercase text-[var(--text-muted)]">
                      disabled
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {c.tool_count} tool{c.tool_count === 1 ? "" : "s"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void toggle(c)}
                disabled={!isOwner || saving}
                aria-pressed={c.attached}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full transition",
                  c.attached ? "bg-[var(--accent)]" : "bg-[var(--border)]",
                  (!isOwner || saving) && "opacity-60"
                )}
                title={
                  isOwner
                    ? c.attached
                      ? "Turn off for this workspace"
                      : "Turn on for this workspace"
                    : "Only the workspace owner can change this"
                }
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                    c.attached ? "left-[18px]" : "left-0.5"
                  )}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
