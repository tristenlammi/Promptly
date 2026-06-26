import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Sparkles, Trash2, Users2 } from "lucide-react";

import { groupsApi, type UserGroup } from "@/api/groups";
import { adminApi } from "@/api/admin";
import type { AdminModelOption, AdminUser } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { extractError } from "@/components/files/helpers";
import { cn } from "@/utils/cn";

export function GroupsPanel() {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [pool, setPool] = useState<AdminModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserGroup | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, u, p] = await Promise.all([
        groupsApi.list(),
        adminApi.listUsers(),
        adminApi.modelPool(),
      ]);
      setGroups(g);
      setUsers(u);
      setPool(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateErr(null);
    try {
      await groupsApi.create(name);
      setNewName("");
      await load();
    } catch (e) {
      setCreateErr(extractError(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (g: UserGroup) => {
    if (!window.confirm(`Delete group "${g.name}"? Members are not deleted.`))
      return;
    setBusyId(g.id);
    try {
      await groupsApi.remove(g.id);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="mb-4 max-w-xl text-sm text-[var(--text-muted)]">
        Group users into named teams (e.g. “Network Engineers”). A group is a
        role bundle: it scopes which connectors a member can reach AND grants a
        set of models — added on top of each member’s own access.
      </div>

      <div className="mb-4 flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            New group name
          </span>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            placeholder="Network Engineers"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => void create()}
          disabled={!newName.trim() || creating}
        >
          Create
        </Button>
      </div>
      {createErr && (
        <p className="mb-3 text-xs text-red-600 dark:text-red-400">{createErr}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--text-muted)]">
          <Users2 className="mx-auto mb-2 h-6 w-6 opacity-50" />
          No groups yet. Create one above.
        </div>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li
              key={g.id}
              className="flex items-start justify-between gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--text)]">
                    {g.name}
                  </span>
                  {g.allowed_models.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                      <Sparkles className="h-2.5 w-2.5" />
                      {g.allowed_models.length} model
                      {g.allowed_models.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {g.members.length === 0
                    ? "No members"
                    : g.members.map((m) => m.username).join(", ")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(g)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(g)}
                  aria-label="Delete group"
                  className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-500"
                >
                  {busyId === g.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <GroupEditModal
          group={editing}
          users={users}
          pool={pool}
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

function GroupEditModal({
  group,
  users,
  pool,
  onClose,
  onSaved,
}: {
  group: UserGroup;
  users: AdminUser[];
  pool: AdminModelOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"members" | "models">("members");
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(group.members.map((m) => m.id))
  );
  const [models, setModels] = useState<Set<string>>(
    new Set(group.allowed_models)
  );
  const [query, setQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)
    );
  }, [users, query]);

  const filteredPool = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        m.model_id.toLowerCase().includes(q) ||
        m.provider_name.toLowerCase().includes(q)
    );
  }, [pool, modelQuery]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const newName = name.trim();
      await groupsApi.update(group.id, {
        ...(newName && newName !== group.name ? { name: newName } : {}),
        allowed_models: [...models],
      });
      await groupsApi.setMembers(group.id, [...selected]);
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
      title={`Edit “${group.name}”`}
      widthClass="max-w-md"
      dismissible={false}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={!name.trim() || saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Group name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>

        <div className="flex gap-1 rounded-md bg-[var(--hover)] p-0.5">
          <TabBtn
            active={tab === "members"}
            onClick={() => setTab("members")}
            label={`Members (${selected.size})`}
          />
          <TabBtn
            active={tab === "models"}
            onClick={() => setTab("models")}
            label={`Models (${models.size})`}
          />
        </div>

        {tab === "members" ? (
          <div>
            <div className="mb-1 flex items-center justify-end">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search users…"
                className="w-40 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="max-h-60 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-2 text-xs text-[var(--text-muted)]/70">
                  No matching users.
                </p>
              ) : (
                filtered.map((u) => (
                  <label
                    key={u.id}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-[var(--hover)]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => setSelected((s) => toggle(s, u.id))}
                      className="h-3 w-3 accent-[var(--accent)]"
                    />
                    <span className="text-[var(--text)]">{u.username}</span>
                    <span className="ml-auto truncate text-[var(--text-muted)]/70">
                      {u.email}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-1 text-[11px] text-[var(--text-muted)]">
              Every member gets these models, on top of their own access.
            </p>
            <div className="mb-1 flex items-center justify-end">
              <input
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                placeholder="Search models…"
                className="w-40 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="max-h-60 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
              {filteredPool.length === 0 ? (
                <p className="px-2 py-2 text-xs text-[var(--text-muted)]/70">
                  No models available.
                </p>
              ) : (
                filteredPool.map((m) => (
                  <label
                    key={`${m.provider_id}-${m.model_id}`}
                    className="flex items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-[var(--hover)]"
                  >
                    <input
                      type="checkbox"
                      checked={models.has(m.model_id)}
                      onChange={() => setModels((s) => toggle(s, m.model_id))}
                      className="mt-0.5 h-3 w-3 accent-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[var(--text)]">
                          {m.display_name}
                        </span>
                        {m.is_custom && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent)]/10 px-1 py-0.5 text-[9px] font-medium text-[var(--accent)]">
                            <Sparkles className="h-2 w-2" />
                            custom
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] text-[var(--text-muted)]/70">
                        {m.is_custom && m.base_display_name
                          ? `on ${m.base_display_name} · ${m.provider_name}`
                          : `${m.model_id} · ${m.provider_name}`}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </Modal>
  );
}

function TabBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded px-2 py-1 text-xs font-medium transition",
        active
          ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
          : "text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {label}
    </button>
  );
}
