import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  mcpApi,
  type ConnectorAvailability,
  type ConnectorKind,
  type McpConnector,
  type McpToolInfo,
  type WorkspaceOption,
} from "@/api/mcp";
import { groupsApi, type UserGroup } from "@/api/groups";
import { adminApi } from "@/api/admin";
import type { AdminUser } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { extractError } from "@/components/files/helpers";
import { cn } from "@/utils/cn";

/** One-click presets that prefill the form. */
const PRESETS: {
  label: string;
  kind: ConnectorKind;
  url: string;
  auth_header_name: string;
  hint: string;
}[] = [
  {
    label: "GitHub",
    kind: "mcp",
    url: "https://api.githubcopilot.com/mcp/",
    auth_header_name: "Authorization",
    hint: "Paste a GitHub token as 'Bearer <token>'.",
  },
  {
    label: "UniFi",
    kind: "unifi",
    url: "https://192.168.1.1",
    auth_header_name: "X-API-KEY",
    hint: "Your controller URL + a read-only UniFi Network API key (Settings → Integrations).",
  },
];

export function McpConnectorsPanel() {
  const [connectors, setConnectors] = useState<McpConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<McpConnector | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConnectors(await mcpApi.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = async (c: McpConnector) => {
    setBusyId(c.id);
    try {
      await mcpApi.refresh(c.id);
      await load();
    } catch {
      // surfaced by the interceptor
    } finally {
      setBusyId(null);
    }
  };

  const onToggle = async (c: McpConnector) => {
    setBusyId(c.id);
    try {
      await mcpApi.update(c.id, { enabled: !c.enabled });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (c: McpConnector) => {
    if (!window.confirm(`Delete connector "${c.name}"?`)) return;
    setBusyId(c.id);
    try {
      await mcpApi.remove(c.id);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="max-w-xl text-sm text-[var(--text-muted)]">
          Connect remote MCP servers so the AI can use their tools in chat
          (when the Tools toggle is on). Read-only by default — tools a server
          marks destructive are blocked.
        </p>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setEditing("new")}
        >
          Add connector
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : connectors.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--text-muted)]">
          <Plug className="mx-auto mb-2 h-6 w-6 opacity-50" />
          No connectors yet. Add one (try the GitHub preset).
        </div>
      ) : (
        <ul className="space-y-2">
          {connectors.map((c) => (
            <li
              key={c.id}
              className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text)]">
                      {c.name}
                    </span>
                    {c.kind !== "mcp" && <Badge>{c.kind}</Badge>}
                    <Badge>
                      {c.availability === "restricted"
                        ? scopeLabel(c)
                        : "global"}
                    </Badge>
                    {!c.enabled && <Badge tone="muted">disabled</Badge>}
                  </div>
                  <div className="truncate text-xs text-[var(--text-muted)]">
                    {c.url}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {c.tools.length} tool{c.tools.length === 1 ? "" : "s"}
                    {c.has_auth ? " · authenticated" : ""}
                    {c.tools_refreshed_at
                      ? ` · refreshed ${new Date(c.tools_refreshed_at).toLocaleString()}`
                      : " · not yet fetched"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconBtn
                    title="Refresh tools"
                    onClick={() => void onRefresh(c)}
                    busy={busyId === c.id}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </IconBtn>
                  <button
                    type="button"
                    onClick={() => void onToggle(c)}
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    {c.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(c)}
                    className="rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    Edit
                  </button>
                  <IconBtn title="Delete" onClick={() => void onDelete(c)} danger>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </div>
              </div>
              {c.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.tools.map((t) => (
                    <ToolChip key={t.name} tool={t} allowed={c.allowed_tools} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ConnectorForm
          connector={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function ToolChip({
  tool,
  allowed,
}: {
  tool: McpToolInfo;
  allowed: string[] | null;
}) {
  const isAllowed = allowed === null || allowed.includes(tool.name);
  const destructive =
    tool.annotations?.destructiveHint === true &&
    tool.annotations?.readOnlyHint !== true;
  return (
    <span
      title={tool.description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]",
        isAllowed
          ? "bg-black/[0.04] text-[var(--text-muted)] dark:bg-white/[0.06]"
          : "bg-black/[0.02] text-[var(--text-muted)]/50 line-through"
      )}
    >
      {destructive ? (
        <ShieldAlert className="h-2.5 w-2.5 text-amber-500" />
      ) : (
        <ShieldCheck className="h-2.5 w-2.5 text-emerald-500" />
      )}
      {tool.name}
    </span>
  );
}

function ConnectorForm({
  connector,
  onClose,
  onSaved,
}: {
  connector: McpConnector | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = connector !== null;
  const [name, setName] = useState(connector?.name ?? "");
  const [kind, setKind] = useState<ConnectorKind>(connector?.kind ?? "mcp");
  const [url, setUrl] = useState(connector?.url ?? "");
  const isUnifi = kind === "unifi";
  const [authHeader, setAuthHeader] = useState(
    connector?.auth_header_name ?? "Authorization"
  );
  const [authValue, setAuthValue] = useState("");
  const [availability, setAvailability] = useState<ConnectorAvailability>(
    connector?.availability ?? "global"
  );
  // Restricted-scope targets: identity = groups + named users; context =
  // workspaces.
  const [groupIds, setGroupIds] = useState<Set<string>>(
    new Set(connector?.group_ids ?? [])
  );
  const [userIds, setUserIds] = useState<Set<string>>(
    new Set(connector?.user_ids ?? [])
  );
  const [workspaceIds, setWorkspaceIds] = useState<Set<string>>(
    new Set(connector?.workspace_ids ?? [])
  );
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [g, u, w] = await Promise.all([
          groupsApi.list(),
          adminApi.listUsers(),
          mcpApi.listWorkspaceOptions(),
        ]);
        if (!alive) return;
        setGroups(g);
        setUsers(u);
        setWorkspaces(w);
      } catch {
        // selector simply shows nothing if options can't load
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const [testTools, setTestTools] = useState<McpToolInfo[] | null>(
    connector?.tools ?? null
  );
  // Allow-list: a Set of permitted tool names, or null = "all allowed".
  const [allowed, setAllowed] = useState<Set<string> | null>(
    connector?.allowed_tools ? new Set(connector.allowed_tools) : null
  );
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setTestErr(null);
    try {
      const r = await mcpApi.test({
        url: url.trim(),
        kind,
        auth_header_name: authHeader || null,
        auth_value: authValue || null,
      });
      if (r.ok) setTestTools(r.tools);
      else setTestErr(r.error ?? "Connection failed");
    } catch (e) {
      setTestErr(extractError(e));
    } finally {
      setTesting(false);
    }
  };

  const allTools = testTools ?? [];
  const isToolAllowed = (n: string) => allowed === null || allowed.has(n);
  const toggleTool = (n: string) => {
    const cur = allowed === null ? new Set(allTools.map((t) => t.name)) : new Set(allowed);
    if (cur.has(n)) cur.delete(n);
    else cur.add(n);
    setAllowed(cur.size === allTools.length ? null : cur);
  };
  // null = all allowed (default); otherwise the explicit list.
  const allowedPayload = allowed === null ? null : [...allowed];
  // Restricted scope is sent as concrete lists; global clears them all.
  const scopePayload =
    availability === "restricted"
      ? {
          group_ids: [...groupIds],
          user_ids: [...userIds],
          workspace_ids: [...workspaceIds],
        }
      : { group_ids: [], user_ids: [], workspace_ids: [] };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      if (isEdit && connector) {
        await mcpApi.update(connector.id, {
          name: name.trim(),
          url: url.trim(),
          auth_header_name: authHeader || null,
          // Only send a new secret when the admin typed one.
          ...(authValue ? { auth_value: authValue } : {}),
          availability,
          allowed_tools: allowedPayload,
          ...scopePayload,
        });
      } else {
        await mcpApi.create({
          name: name.trim(),
          kind,
          url: url.trim(),
          auth_header_name: authHeader || null,
          auth_value: authValue || null,
          availability,
          allowed_tools: allowedPayload,
          ...scopePayload,
        });
      }
      onSaved();
    } catch (e) {
      setErr(extractError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Edit connector" : "Add connector"}
      widthClass="max-w-lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={!name.trim() || !url.trim() || saving}
          >
            {saving ? "Saving…" : isEdit ? "Save" : "Add connector"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {!isEdit && (
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setName((n) => n || p.label);
                  setKind(p.kind);
                  setUrl(p.url);
                  setAuthHeader(p.auth_header_name);
                }}
                className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:border-[var(--accent)]/50"
                title={p.hint}
              >
                {p.label} preset
              </button>
            ))}
          </div>
        )}
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            placeholder="GitHub"
          />
        </Field>
        <Field
          label={
            isUnifi
              ? "Controller URL"
              : "Server URL (streamable-HTTP MCP endpoint)"
          }
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputCls}
            placeholder={isUnifi ? "https://192.168.1.1" : "https://…/mcp/"}
          />
        </Field>
        <div className={cn("grid gap-2", isUnifi ? "grid-cols-1" : "grid-cols-2")}>
          {!isUnifi && (
            <Field label="Auth header (optional)">
              <input
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
                className={inputCls}
                placeholder="Authorization"
              />
            </Field>
          )}
          <Field
            label={
              isUnifi
                ? isEdit && connector?.has_auth
                  ? "Read-only API key (leave blank to keep)"
                  : "Read-only API key"
                : isEdit && connector?.has_auth
                  ? "Auth value (leave blank to keep)"
                  : "Auth value (optional)"
            }
          >
            <input
              type="password"
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              className={inputCls}
              placeholder={isUnifi ? "UniFi API key" : "Bearer …"}
            />
          </Field>
        </div>
        <Field label="Availability">
          <select
            value={availability}
            onChange={(e) =>
              setAvailability(e.target.value as ConnectorAvailability)
            }
            className={inputCls}
          >
            <option value="global">Global — all users, everywhere</option>
            <option value="restricted">
              Restricted — selected groups &amp; workspaces
            </option>
          </select>
        </Field>

        {availability === "restricted" && (
          <div className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5">
            <p className="text-xs text-[var(--text-muted)]">
              Reachable by the chosen <strong>groups</strong> and{" "}
              <strong>users</strong> (anywhere), and in chats inside the chosen{" "}
              <strong>workspaces</strong>. Pick at least one.
            </p>
            <ScopePicker
              label="Groups"
              empty="No groups yet — create some in the Groups tab."
              items={groups.map((g) => ({
                id: g.id,
                label: g.name,
                hint:
                  g.members.length === 1
                    ? "1 member"
                    : `${g.members.length} members`,
              }))}
              selected={groupIds}
              onToggle={(id) =>
                setGroupIds((s) => toggle(s, id))
              }
            />
            <ScopePicker
              label="Users"
              empty="No users found."
              searchable
              items={users.map((u) => ({
                id: u.id,
                label: u.username,
                hint: u.email,
              }))}
              selected={userIds}
              onToggle={(id) =>
                setUserIds((s) => toggle(s, id))
              }
            />
            <ScopePicker
              label="Workspaces"
              empty="No workspaces exist yet."
              items={workspaces.map((w) => ({
                id: w.id,
                label: w.title,
                hint: w.owner ?? undefined,
              }))}
              selected={workspaceIds}
              onToggle={(id) =>
                setWorkspaceIds((s) => toggle(s, id))
              }
            />
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-[var(--border)] pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void test()}
            disabled={!url.trim() || testing}
            leftIcon={
              testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined
            }
          >
            Test connection
          </Button>
          {testTools && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              ✓ {testTools.length} tool{testTools.length === 1 ? "" : "s"} found
            </span>
          )}
          {testErr && (
            <span className="text-xs text-red-600 dark:text-red-400">
              {testErr}
            </span>
          )}
        </div>
        {testTools && testTools.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              Allowed tools ({allowed === null ? testTools.length : allowed.size}
              /{testTools.length}) — untick to hide a tool from the model
            </div>
            <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1.5">
              {testTools.map((t) => {
                const destructive =
                  t.annotations?.destructiveHint === true &&
                  t.annotations?.readOnlyHint !== true;
                return (
                  <label
                    key={t.name}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-[var(--hover)]"
                    title={t.description}
                  >
                    <input
                      type="checkbox"
                      checked={isToolAllowed(t.name)}
                      onChange={() => toggleTool(t.name)}
                      className="h-3 w-3 accent-[var(--accent)]"
                    />
                    {destructive ? (
                      <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                    ) : (
                      <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-500" />
                    )}
                    <span className="font-mono text-[var(--text)]">{t.name}</span>
                    <span className="truncate text-[var(--text-muted)]">
                      {t.description}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </Modal>
  );
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Short badge text summarising a restricted connector's scope. */
function scopeLabel(c: McpConnector): string {
  const g = c.group_ids.length;
  const u = c.user_ids.length;
  const w = c.workspace_ids.length;
  const parts: string[] = [];
  if (g) parts.push(`${g} group${g === 1 ? "" : "s"}`);
  if (u) parts.push(`${u} user${u === 1 ? "" : "s"}`);
  if (w) parts.push(`${w} workspace${w === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "restricted (none)";
}

function ScopePicker({
  label,
  empty,
  items,
  selected,
  onToggle,
  searchable,
}: {
  label: string;
  empty: string;
  items: { id: string; label: string; hint?: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown =
    searchable && q
      ? items.filter(
          (it) =>
            it.label.toLowerCase().includes(q) ||
            (it.hint?.toLowerCase().includes(q) ?? false)
        )
      : items;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--text-muted)]">
          {label} ({selected.size} selected)
        </span>
        {searchable && items.length > 0 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-1 py-1 text-xs text-[var(--text-muted)]/70">{empty}</p>
      ) : (
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
          {shown.length === 0 ? (
            <p className="px-1 py-1 text-xs text-[var(--text-muted)]/70">
              No matches.
            </p>
          ) : (
            shown.map((it) => (
              <label
                key={it.id}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-[var(--hover)]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(it.id)}
                  onChange={() => onToggle(it.id)}
                  className="h-3 w-3 accent-[var(--accent)]"
                />
                <span className="text-[var(--text)]">{it.label}</span>
                {it.hint && (
                  <span className="ml-auto truncate text-[var(--text-muted)]/70">
                    {it.hint}
                  </span>
                )}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "muted";
}) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        tone === "muted"
          ? "bg-black/[0.04] text-[var(--text-muted)] dark:bg-white/[0.06]"
          : "bg-[var(--accent)]/10 text-[var(--accent)]"
      )}
    >
      {children}
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "rounded-md p-1.5 text-[var(--text-muted)] transition",
        danger
          ? "hover:bg-red-500/10 hover:text-red-500"
          : "hover:bg-[var(--hover)] hover:text-[var(--text)]"
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}
