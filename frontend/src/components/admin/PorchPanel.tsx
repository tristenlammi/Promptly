import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, House, Image as ImageIcon, MessageCircle, Users } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { porchAdminApi, type PorchAdminSettings, type ReportItem } from "@/api/porch";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { SettingsCard } from "./SettingsCard";
import { SkeletonRows } from "@/components/shared/Skeleton";

const KEY = ["porch", "admin"];
const REPORTS_KEY = ["porch", "admin", "reports"];
const HANDLED_KEY = ["porch", "admin", "handled"];

const input =
  "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const btn =
  "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60";

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Admin → Porch: on or off, who can use it (user groups), video limits,
 * Everyone's name, and the reports queue. Admins see a reported post here —
 * nothing else from groups they're not in.
 */
export function PorchPanel() {
  const qc = useQueryClient();
  const { data, isError, refetch } = useQuery({ queryKey: KEY, queryFn: porchAdminApi.get });
  const patch = useMutation({
    mutationFn: porchAdminApi.patch,
    onSuccess: (row) => {
      qc.setQueryData(KEY, row);
      void qc.invalidateQueries({ queryKey: ["porch", "available"] });
      void qc.invalidateQueries({ queryKey: ["porch", "bootstrap"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save that. Try again.")),
  });
  if (isError) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Couldn't load Porch's settings.{" "}
        <button type="button" className="font-medium text-[var(--accent-text,var(--accent))] hover:underline" onClick={() => void refetch()}>
          Try again
        </button>
      </p>
    );
  }
  if (!data) return null;
  return (
    <div className="flex flex-col gap-5">
      <AccessCard data={data} save={(b) => patch.mutate(b)} busy={patch.isPending} />
      <EveryoneCard data={data} save={(b) => patch.mutate(b)} busy={patch.isPending} />
      <ReportsCard everyone={data.everyone_name} />
    </div>
  );
}

type Save = (b: Parameters<typeof porchAdminApi.patch>[0]) => void;

function AccessCard({ data, save, busy }: { data: PorchAdminSettings; save: Save; busy: boolean }) {
  const some = data.user_group_ids !== null;
  const [picked, setPicked] = useState<string[]>(data.user_group_ids ?? []);
  const whoId = useId();
  useEffect(() => setPicked(data.user_group_ids ?? []), [data.user_group_ids]);
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setPicked(next);
    if (next.length) save({ user_group_ids: next });
  };
  return (
    <SettingsCard title="Porch" icon={<House className="h-4 w-4" />}>
      <div className="flex flex-col gap-4">
        <label className="flex items-start gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" className="mt-0.5" checked={data.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} />
          <span>
            Porch is on
            <span className="block text-xs text-[var(--text-muted)]">
              Off hides Porch from everyone, admins too. Nothing is deleted; turning it back on brings it all back.
            </span>
          </span>
        </label>

        <fieldset className={cn("flex flex-col gap-2", !data.enabled && "opacity-60")} disabled={!data.enabled || busy} aria-describedby={whoId}>
          <legend className="text-sm font-medium text-[var(--text)]">Who can use it</legend>
          <p id={whoId} className="text-xs text-[var(--text-muted)]">
            {data.enabled ? `${data.people} ${data.people === 1 ? "person" : "people"} can use Porch now.` : "Porch is off."} These are user groups from
            Admin → Groups, not Porch's own groups.
          </p>
          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input type="radio" name="porch-who" checked={!some} onChange={() => save({ user_group_ids: null })} />
            Everyone on this Promptly
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="radio"
              name="porch-who"
              checked={some}
              disabled={data.user_groups.length === 0}
              onChange={() => {
                const first = picked.length ? picked : data.user_groups.slice(0, 1).map((g) => g.id);
                setPicked(first);
                if (first.length) save({ user_group_ids: first });
              }}
            />
            Only people in these user groups
          </label>
          {data.user_groups.length === 0 ? (
            <p className="pl-6 text-xs text-[var(--text-muted)]">There are no user groups yet. Make one in Admin → Groups.</p>
          ) : (
            some && (
              <ul className="flex flex-col gap-1 pl-6">
                {data.user_groups.map((g) => (
                  <li key={g.id}>
                    <label className="flex items-center gap-2 text-sm text-[var(--text)]">
                      <input type="checkbox" checked={picked.includes(g.id)} disabled={picked.length === 1 && picked.includes(g.id)} onChange={() => toggle(g.id)} />
                      {g.name}
                      <span className="text-xs text-[var(--text-muted)]">
                        {g.member_count} {g.member_count === 1 ? "person" : "people"}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )
          )}
        </fieldset>

        <div className={cn("flex flex-wrap gap-4", !data.enabled && "opacity-60")}>
          <NumberField
            label="Longest video, in seconds"
            value={data.video_max_seconds}
            min={5}
            max={3600}
            disabled={!data.enabled}
            onSave={(n) => save({ video_max_seconds: n })}
          />
          <NumberField label="Largest video, in MB" value={data.video_max_mb} min={1} max={20480} disabled={!data.enabled} onSave={(n) => save({ video_max_mb: n })} />
        </div>
      </div>
    </SettingsCard>
  );
}

function NumberField({ label, value, min, max, disabled, onSave }: { label: string; value: number; min: number; max: number; disabled?: boolean; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="flex flex-col gap-1 text-sm text-[var(--text)]">
      {label}
      <input
        className={cn(input, "w-32")}
        type="number"
        min={min}
        max={max}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isInteger(n) && n >= min && n <= max && n !== value) onSave(n);
          else setV(String(value));
        }}
      />
    </label>
  );
}

function EveryoneCard({ data, save, busy }: { data: PorchAdminSettings; save: Save; busy: boolean }) {
  const [name, setName] = useState(data.everyone_name);
  const [emoji, setEmoji] = useState(data.everyone_emoji);
  useEffect(() => {
    setName(data.everyone_name);
    setEmoji(data.everyone_emoji);
  }, [data.everyone_name, data.everyone_emoji]);
  const changed = name.trim() !== data.everyone_name || emoji.trim() !== data.everyone_emoji;
  return (
    <SettingsCard
      title="The Everyone group"
      icon={<Users className="h-4 w-4" />}
      footer={
        <button
          type="button"
          className={cn(btn, "bg-[var(--accent)] text-white hover:brightness-95")}
          disabled={busy || !changed || !name.trim()}
          onClick={() => save({ everyone_name: name.trim(), everyone_emoji: emoji.trim() })}
        >
          Save
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          Everyone who can use Porch is in it, and nobody can leave it (they can take it out of their feed). Server admins are its admins.
        </p>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm text-[var(--text)]">
            Emoji
            <input className={cn(input, "w-16 text-center")} value={emoji} maxLength={16} onChange={(e) => setEmoji(e.target.value)} />
          </label>
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm text-[var(--text)]">
            Name
            <input className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Everyone" />
          </label>
        </div>
      </div>
    </SettingsCard>
  );
}

function ReportsCard({ everyone }: { everyone: string }) {
  const qc = useQueryClient();
  const open = useQuery({ queryKey: REPORTS_KEY, queryFn: porchAdminApi.reports });
  const handled = useQuery({ queryKey: HANDLED_KEY, queryFn: porchAdminApi.handled });
  const done = () => {
    void qc.invalidateQueries({ queryKey: REPORTS_KEY });
    void qc.invalidateQueries({ queryKey: HANDLED_KEY });
    void qc.invalidateQueries({ queryKey: KEY });
  };
  return (
    <SettingsCard title="Reports" icon={<Flag className="h-4 w-4" />} headerExtra={open.data && open.data.length > 0 ? <span className="text-xs text-[var(--text-muted)]">{open.data.length} waiting</span> : undefined}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-[var(--text-muted)]">
          Posts and comments people reported in {everyone}, the group everyone is in. You see why, never who reported it. Remove from {everyone} takes a post out of{" "}
          {everyone} only (it stays in the poster's other groups, and is deleted if {everyone} was its only one) and tells the person who posted it the reason you give. Keep
          leaves it up.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Reports made in other groups go to those groups' own admins. They never show here, and you only see what's in a group you're in yourself.
        </p>
        {open.isPending ? (
          <SkeletonRows count={3} label="Loading" />
        ) : open.isError ? (
          <p className="text-sm text-[var(--text-muted)]">Couldn't load the reports.</p>
        ) : open.data.length === 0 ? (
          <p className="rounded-lg bg-[var(--surface-2)] px-3 py-4 text-center text-sm text-[var(--text-muted)]">Nothing has been reported. All clear.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Waiting reports">
            {open.data.map((r) => (
              <ReportRow key={r.id} r={r} everyone={everyone} onDone={done} />
            ))}
          </ul>
        )}
        {handled.data && handled.data.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text)]">Recently handled ({handled.data.length})</summary>
            <ul className="mt-2 flex flex-col divide-y divide-[var(--border)]">
              {handled.data.map((h) => (
                <li key={h.id} className="py-1.5 text-xs text-[var(--text-muted)]">
                  <span className="font-medium text-[var(--text)]">{h.status === "removed" ? "Removed" : "Kept"}</span> a {h.target_type}
                  {h.handled_by ? ` · by ${h.handled_by.name}` : ""} · {when(h.handled_at)}
                  {h.note ? ` · “${h.note}”` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </SettingsCard>
  );
}

function ReportRow({ r, everyone, onDone }: { r: ReportItem; everyone: string; onDone: () => void }) {
  const t = r.target;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const decide = async (action: "remove" | "keep") => {
    if (action === "remove" && !t.gone && !reason.trim()) {
      toast.error("Say why. The person who posted it will see this.");
      return;
    }
    setBusy(true);
    try {
      const out = await porchAdminApi.decide(r.id, action, reason.trim());
      const who = t.author?.name ?? "They";
      if (t.gone) toast.success("Report closed.");
      else if (action === "keep") toast.success("Kept. The report is closed.");
      else if (t.type === "comment") toast.success(`Comment removed. ${who} has been told why.`);
      else if (out.deleted) toast.success(`Removed. It was only in ${everyone}, so it's gone. ${who} has been told why.`);
      else toast.success(`Removed from ${everyone}. It stays in ${who}'s other groups, and ${who} has been told why.`);
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't do that. Try again."));
    } finally {
      setBusy(false);
    }
  };
  // Only the admin's own groups are ever named.
  const where = t.groups ? t.groups.named.map((g) => g.name).join(", ") : "";
  return (
    <li data-report={r.id} className="flex flex-col gap-3 rounded-xl border border-[var(--border)] p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[var(--text-muted)]" aria-hidden>
          {t.type === "comment" ? <MessageCircle className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--text)]">
            {t.gone ? <>A reported {t.type}</> : <><b className="font-semibold">{t.author?.name ?? "Someone"}</b>'s {t.type}</>}
            {where && <span className="text-[var(--text-muted)]"> · in {where}</span>}
            {t.created_at && <span className="text-[var(--text-muted)]"> · {when(t.created_at)}</span>}
          </p>
          {t.gone ? (
            <p className="mt-1 text-sm italic text-[var(--text-muted)]">It's been deleted, or it isn't in {everyone} any more. Close the report.</p>
          ) : (
            <>
              {t.post_body && <p className="mt-1 truncate text-xs text-[var(--text-muted)]">On the post: {t.post_body}</p>}
              {t.body && <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2)] p-2 text-sm text-[var(--text)]">{t.body}</p>}
              {t.media && t.media.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.media.slice(0, 6).map((m, i) =>
                    m.thumb ? (
                      <a key={i} href={m.preview ?? m.thumb} target="_blank" rel="noreferrer" title="Open larger">
                        <img src={m.thumb} alt={m.alt || `Photo ${i + 1} of the post`} className="h-20 w-20 rounded-lg object-cover" />
                      </a>
                    ) : null,
                  )}
                </div>
              )}
            </>
          )}
          <ul className="mt-2 flex flex-col gap-1">
            {r.reports.map((x) => (
              <li key={x.id} className="text-xs text-[var(--text-muted)]">
                Reported {when(x.created_at)}
                {x.reason ? `: “${x.reason}”` : " (no reason given)"}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {!t.gone && (
        <label htmlFor={reasonId} className="flex flex-col gap-1 text-sm text-[var(--text)]">
          Reason, if you remove it (they'll see this)
          <input id={reasonId} className={input} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Please keep it friendly" />
        </label>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {t.gone ? (
          <button type="button" className={cn(btn, "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]")} disabled={busy} onClick={() => void decide("keep")}>
            Close report
          </button>
        ) : (
          <>
            <button type="button" className={cn(btn, "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]")} disabled={busy} onClick={() => void decide("keep")}>
              Keep it
            </button>
            <button type="button" className={cn(btn, "bg-[var(--danger)] text-white hover:brightness-95")} disabled={busy} onClick={() => void decide("remove")}>
              {t.type === "comment" ? "Remove comment" : `Remove from ${everyone}`}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
