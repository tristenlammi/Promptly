import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, Smartphone, X } from "lucide-react";

import { appPasswordsApi, type AppPasswordCreated, type AppPasswordScope } from "@/api/appPasswords";
import { formatRelativeTime } from "@/components/files/helpers";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { DeviceGuide } from "./DeviceGuide";

/**
 * Settings → Devices (WP-8.3): an app password per device that syncs —
 * a phone's PhotoSync, a laptop's rclone or Finder. Shown once, revoked on
 * its own; your account password never works there.
 */

const SCOPE_LABEL: Record<AppPasswordScope, string> = {
  "dav:read": "See and download files",
  "dav:write": "Add, change and delete files",
  upload: "Upload big files",
};

const KEY = ["app-passwords"];

export function DevicesPanel() {
  const qc = useQueryClient();
  const { data: devices = [], isLoading } = useQuery({ queryKey: KEY, queryFn: appPasswordsApi.list });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AppPasswordScope[]>(["dav:read", "dav:write"]);
  const [made, setMade] = useState<AppPasswordCreated | null>(null);

  const create = useMutation({
    mutationFn: () => appPasswordsApi.create(name.trim(), scopes),
    onSuccess: (row) => {
      setMade(row);
      setAdding(false);
      setName("");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't add the device.")),
  });

  const revoke = async (id: string, label: string) => {
    const ok = await confirm({
      title: `Revoke “${label}”?`,
      message: "It's signed out at once and can't sync until you give it a new app password.",
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await appPasswordsApi.revoke(id);
      toast.success(`“${label}” can't sign in any more.`);
      void qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't revoke it."));
    }
  };

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Devices">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <Smartphone className="h-4 w-4" /> Devices
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Apps that sync your files — PhotoSync or FolderSync on a phone, rclone or Finder on a computer — sign in with an
        app password made here, never your account password. Give each device its own, so you can cut one off without the
        others.
      </p>

      {made && <NewPassword made={made} onDone={() => setMade(null)} />}

      {isLoading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading…</p>
      ) : devices.length > 0 ? (
        <ul className="mb-3 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <KeyRound className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text)]">{d.name}</div>
                <div className="truncate text-[var(--text-muted)]">
                  <span className="font-mono">{d.hint}</span> · {d.scopes.map((s) => SCOPE_LABEL[s]).join(", ")} ·{" "}
                  {d.last_used_at
                    ? `last used ${formatRelativeTime(d.last_used_at)}${d.last_used_ip ? ` from ${d.last_used_ip}` : ""}`
                    : "not used yet"}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void revoke(d.id, d.name)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        !made && <p className="mb-3 text-xs text-[var(--text-muted)]">No devices yet.</p>
      )}

      {adding ? (
        <form
          className="space-y-3 rounded-md border border-[var(--border)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && scopes.length) create.mutate();
          }}
        >
          <label className="block text-xs font-medium text-[var(--text)]">
            Device name
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sam's iPhone — PhotoSync"
              maxLength={80}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm font-normal outline-none focus:border-[var(--accent)]"
            />
          </label>
          <fieldset className="space-y-1.5 text-xs">
            <legend className="mb-1 font-medium text-[var(--text)]">It may</legend>
            {(Object.keys(SCOPE_LABEL) as AppPasswordScope[]).map((s) => (
              <label key={s} className="flex items-center gap-2 text-[var(--text)]">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  className="accent-[var(--accent)]"
                />
                {SCOPE_LABEL[s]}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={create.isPending} disabled={!name.trim() || !scopes.length}>
              Make an app password
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
          Add a device
        </Button>
      )}

      <DeviceGuide />
    </section>
  );
}

/** The new password, once, with what the device needs to connect. */
function NewPassword({ made, onDone }: { made: AppPasswordCreated; onDone: () => void }) {
  const server = `${window.location.origin}/dav/`;
  return (
    <div role="status" className="mb-3 space-y-2 rounded-md border border-[var(--accent)]/50 bg-[var(--accent)]/5 p-3 text-xs">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-[var(--text)]">
          <span className="font-medium">“{made.name}” is ready.</span> Copy the password now — it won't be shown again.
        </p>
        <button type="button" onClick={onDone} aria-label="Done" className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <CopyRow label="Server (WebDAV)" value={server} />
      <CopyRow label="Username" value={made.username} />
      <CopyRow label="Password" value={made.password} secret />
    </div>
  );
}

function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[var(--text-muted)]">{label}</span>
      <code
        aria-label={label}
        className="min-w-0 flex-1 truncate rounded bg-[var(--bg)] px-2 py-1 font-mono text-[var(--text)]"
        title={secret ? undefined : value}
      >
        {value}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
