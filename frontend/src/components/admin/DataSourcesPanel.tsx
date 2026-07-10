import { useEffect, useState } from "react";
import {
  Database,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import {
  dataSourcesApi,
  type DataSource,
  type DataSourcePayload,
} from "@/api/dataSources";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

const BLANK: DataSourcePayload & { password: string } = {
  name: "",
  host: "",
  port: 5432,
  database: "",
  username: "",
  password: "",
  sslmode: "disable",
  enabled: true,
};

/**
 * Admin CRUD for read-only database connections that back workspace Data-view
 * items. Passwords are write-only (the API returns a ``password_set`` flag,
 * never the value). Queries against these run read-only, single-SELECT, with a
 * row cap + timeout — so the connection is only ever a read window.
 */
export function DataSourcesPanel() {
  const [rows, setRows] = useState<DataSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DataSource | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setRows(await dataSourcesApi.list());
    } catch (e) {
      setError(apiErrorMessage(e, "Couldn't load data sources."));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const onTest = async (row: DataSource) => {
    setTestingId(row.id);
    try {
      await dataSourcesApi.test(row.id);
      toast.success(`Connected to “${row.name}”.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Connection failed."));
    } finally {
      setTestingId(null);
    }
  };

  const onDelete = async (row: DataSource) => {
    const ok = await confirm({
      title: "Delete data source",
      message: `Delete “${row.name}”? Data-view items using it will stop running until re-pointed.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await dataSourcesApi.remove(row.id);
      toast.success("Data source deleted.");
      void load();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't delete."));
    }
  };

  if (error) {
    return (
      <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
        {error}
        <Button size="sm" variant="ghost" className="ml-3" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (rows === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading data sources…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-xl text-xs text-[var(--text-muted)]">
          Read-only database connections (Postgres) that workspace editors can
          query from a Data-view item. Editors pick a source and write a{" "}
          <code>SELECT</code> — they never see these credentials. Use a
          least-privilege, read-only DB user; queries are also forced read-only
          with a row cap and timeout.
        </p>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setEditing("new")}
        >
          Add source
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--text-muted)]">
          <Database className="h-6 w-6 opacity-50" />
          No data sources yet. Add one to enable Data-view items.
        </div>
      ) : (
        <div className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)]">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3">
              <Database className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--text)]">
                    {row.name}
                  </span>
                  {!row.enabled && (
                    <span className="rounded-full bg-[var(--hover)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                      Disabled
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                  {row.username}@{row.host}:{row.port}/{row.database}
                  {row.sslmode === "require" ? " · ssl" : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onTest(row)}
                disabled={testingId === row.id}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] disabled:opacity-50"
              >
                {testingId === row.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plug className="h-3 w-3" />
                )}
                Test
              </button>
              <button
                type="button"
                onClick={() => setEditing(row)}
                className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                title="Edit"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void onDelete(row)}
                className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--hover-strong)] hover:text-[var(--danger)]"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SourceEditor
          source={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function SourceEditor({
  source,
  onClose,
  onSaved,
}: {
  source: DataSource | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: source?.name ?? BLANK.name,
    host: source?.host ?? BLANK.host,
    port: source?.port ?? BLANK.port,
    database: source?.database ?? BLANK.database,
    username: source?.username ?? BLANK.username,
    password: "",
    sslmode: source?.sslmode ?? BLANK.sslmode,
    enabled: source?.enabled ?? BLANK.enabled,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setErr(null);
    if (!form.name.trim() || !form.host.trim() || !form.database.trim() || !form.username.trim()) {
      setErr("Name, host, database and username are required.");
      return;
    }
    setBusy(true);
    try {
      if (source) {
        const patch: Partial<DataSourcePayload> = {
          name: form.name,
          host: form.host,
          port: form.port,
          database: form.database,
          username: form.username,
          sslmode: form.sslmode,
          enabled: form.enabled,
        };
        if (form.password) patch.password = form.password;
        await dataSourcesApi.update(source.id, patch);
      } else {
        await dataSourcesApi.create({
          name: form.name,
          host: form.host,
          port: form.port,
          database: form.database,
          username: form.username,
          password: form.password || undefined,
          sslmode: form.sslmode,
          enabled: form.enabled,
        });
      }
      toast.success(source ? "Data source updated." : "Data source added.");
      onSaved();
    } catch (e) {
      setErr(apiErrorMessage(e, "Couldn't save."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <h3 className="mb-3 text-sm font-semibold text-[var(--text)]">
          {source ? "Edit data source" : "Add data source"}
        </h3>
        <div className="space-y-3">
          <Row label="Name">
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Production analytics"
              className={inputCls}
            />
          </Row>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Row label="Host">
                <input
                  value={form.host}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="db.internal"
                  className={inputCls}
                />
              </Row>
            </div>
            <Row label="Port">
              <input
                type="number"
                value={form.port}
                onChange={(e) => set("port", Number(e.target.value) || 5432)}
                className={inputCls}
              />
            </Row>
          </div>
          <Row label="Database">
            <input
              value={form.database}
              onChange={(e) => set("database", e.target.value)}
              placeholder="analytics"
              className={inputCls}
            />
          </Row>
          <Row label="Username">
            <input
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="readonly"
              autoComplete="off"
              className={inputCls}
            />
          </Row>
          <Row label="Password">
            <input
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              placeholder={
                source?.password_set
                  ? "•••••••• (stored — leave blank to keep)"
                  : "Password"
              }
              autoComplete="new-password"
              className={inputCls}
            />
          </Row>
          <div className="flex items-center gap-4">
            <Row label="SSL">
              <select
                value={form.sslmode}
                onChange={(e) => set("sslmode", e.target.value)}
                className={inputCls}
              >
                <option value="disable">Disable</option>
                <option value="require">Require</option>
              </select>
            </Row>
            <label className="mt-5 inline-flex items-center gap-1.5 text-xs text-[var(--text)]">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              Enabled
            </label>
          </div>
          {err && (
            <div className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400">
              {err}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} loading={busy}>
            {source ? "Save" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const inputCls = cn(
  "w-full rounded-input border bg-[var(--bg)] px-2.5 py-1.5 text-sm",
  "border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)]",
  "focus:border-[var(--accent)] focus:outline-none"
);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
