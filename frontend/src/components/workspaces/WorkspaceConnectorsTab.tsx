import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, Plug } from "lucide-react";

import { mcpApi, type WorkspaceConnector } from "@/api/mcp";
import { extractError } from "@/components/files/helpers";
import { Callout } from "@/components/shared/Callout";
import { cn } from "@/utils/cn";

/**
 * Which outside services this workspace's chats can act on (R-156).
 *
 * Lists what the workspace actually has: connectors that work in every
 * chat, connectors attached here (by an admin or by the workspace's owner
 * and admins), and — for those who can manage it — connectors they could
 * attach. It used to show the viewer's own grants instead, so members
 * couldn't tell what their chats could touch. Anything the viewer can't
 * switch says why.
 */
export function WorkspaceConnectorsTab({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<WorkspaceConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await mcpApi.listWorkspaceConnectors(workspaceId));
      setError(null);
    } catch (e) {
      setItems([]);
      setError(extractError(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (c: WorkspaceConnector) => {
    if (!c.can_change || saving) return;
    const next = items.map((it) =>
      it.id === c.id ? { ...it, attached: !it.attached } : it
    );
    setItems(next);
    setSaving(true);
    setError(null);
    try {
      // Only connectors this viewer manages are sent; the server leaves
      // every other attachment alone.
      await mcpApi.setWorkspaceConnectors(
        workspaceId,
        next.filter((it) => it.can_change && it.attached).map((it) => it.id)
      );
    } catch (e) {
      setError(extractError(e));
    } finally {
      setSaving(false);
      void load();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const anyChangeable = items.some((c) => c.can_change);

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        Outside services this workspace's chats can use (with Tools on).
      </p>
      {anyChangeable && (
        <Callout tone="warning">
          Turning one on lets everyone in this workspace use it, signed in as
          the connector — not as themselves.
        </Callout>
      )}
      {error && (
        <div role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          <Plug className="mx-auto mb-2 h-5 w-5 opacity-50" />
          No connectors here yet. An admin can add one in Admin → Connectors.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
                  {c.availability === "global" && (
                    <Globe className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden />
                  )}
                  {c.name}
                  {!c.enabled && (
                    <span className="ml-1 text-[10px] uppercase text-[var(--text-muted)]">
                      disabled
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {c.tool_count} tool{c.tool_count === 1 ? "" : "s"}
                  {c.reason ? ` · ${c.reason}` : ""}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                onClick={() => void toggle(c)}
                disabled={!c.can_change || saving}
                aria-checked={c.attached}
                aria-label={`${c.name} in this workspace`}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full transition",
                  c.attached ? "bg-[var(--accent)]" : "bg-[var(--border)]",
                  (!c.can_change || saving) && "opacity-60"
                )}
                title={
                  c.can_change
                    ? c.attached
                      ? "Turn off for this workspace"
                      : "Turn on for this workspace"
                    : c.reason ?? undefined
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
