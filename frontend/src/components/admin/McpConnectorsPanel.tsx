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
  type McpConnector,
  type McpToolInfo,
} from "@/api/mcp";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { extractError } from "@/components/files/helpers";
import { cn } from "@/utils/cn";

/** One-click presets that prefill the form for known hosted-remote servers. */
const PRESETS: { label: string; url: string; auth_header_name: string; hint: string }[] = [
  {
    label: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    auth_header_name: "Authorization",
    hint: "Paste a GitHub token as 'Bearer <token>'.",
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
                    <Badge>{c.availability}</Badge>
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
  const [url, setUrl] = useState(connector?.url ?? "");
  const [authHeader, setAuthHeader] = useState(
    connector?.auth_header_name ?? "Authorization"
  );
  const [authValue, setAuthValue] = useState("");
  const [availability, setAvailability] = useState<"global" | "workspace">(
    connector?.availability ?? "global"
  );
  const [testTools, setTestTools] = useState<McpToolInfo[] | null>(
    connector?.tools ?? null
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
        });
      } else {
        await mcpApi.create({
          name: name.trim(),
          url: url.trim(),
          auth_header_name: authHeader || null,
          auth_value: authValue || null,
          availability,
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
        <Field label="Server URL (streamable-HTTP MCP endpoint)">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputCls}
            placeholder="https://…/mcp/"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Auth header (optional)">
            <input
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              className={inputCls}
              placeholder="Authorization"
            />
          </Field>
          <Field
            label={
              isEdit && connector?.has_auth
                ? "Auth value (leave blank to keep)"
                : "Auth value (optional)"
            }
          >
            <input
              type="password"
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              className={inputCls}
              placeholder="Bearer …"
            />
          </Field>
        </div>
        <Field label="Availability">
          <select
            value={availability}
            onChange={(e) =>
              setAvailability(e.target.value as "global" | "workspace")
            }
            className={inputCls}
          >
            <option value="global">Global — all users</option>
            <option value="workspace">
              Workspace — only attached workspaces
            </option>
          </select>
        </Field>

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
          <div className="flex flex-wrap gap-1">
            {testTools.map((t) => (
              <ToolChip key={t.name} tool={t} allowed={null} />
            ))}
          </div>
        )}
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </Modal>
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
