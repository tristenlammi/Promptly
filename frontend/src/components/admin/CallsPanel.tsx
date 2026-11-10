import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, CircleHelp, ListChecks, PhoneCall, RefreshCw, XCircle } from "lucide-react";

import { callsApi, type CallsAdminSettings, type CallsCheck, type StreamQuality } from "@/api/calls";
import { groupsApi } from "@/api/groups";
import { Button } from "@/components/shared/Button";
import { Callout } from "@/components/shared/Callout";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { SettingsCard } from "./SettingsCard";
import { SkeletonRows } from "@/components/shared/Skeleton";

const SETTINGS_KEY = ["calls", "admin", "settings"];

const STREAM_LABELS: Record<StreamQuality, string> = {
  "720p30": "720p, 30 fps",
  "1080p30": "1080p, 30 fps",
  "1080p60": "1080p, 60 fps",
};

/**
 * Admin → Calls: turn voice on, choose who gets it, cap Go Live quality,
 * and see whether it works (the checklist) and how much it's used. Nothing
 * about what anyone says is shown or kept.
 */
export function CallsPanel() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: callsApi.adminSettings });
  const patch = useMutation({
    mutationFn: callsApi.patchAdminSettings,
    // Optimistic, so switches move as soon as they're clicked; rolled back
    // if the server says no.
    onMutate: (body) => {
      const before = qc.getQueryData<CallsAdminSettings>(SETTINGS_KEY);
      if (before) {
        const { everyone, ...rest } = body;
        qc.setQueryData<CallsAdminSettings>(SETTINGS_KEY, {
          ...before,
          ...rest,
          ...(everyone ? { group_ids: null } : {}),
        });
      }
      void qc.cancelQueries({ queryKey: SETTINGS_KEY });
      return { before };
    },
    onSuccess: (row) => {
      qc.setQueryData(SETTINGS_KEY, row);
      void qc.invalidateQueries({ queryKey: ["calls", "me"] });
      void qc.invalidateQueries({ queryKey: ["calls", "admin", "check"] });
    },
    onError: (e, _body, ctx) => {
      if (ctx?.before) qc.setQueryData(SETTINGS_KEY, ctx.before);
      toast.error(apiErrorMessage(e));
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {settings.data ? (
        <VoiceSettings data={settings.data} onChange={(b) => patch.mutate(b)} />
      ) : settings.isError ? (
        <Callout>Couldn't load the calls settings. {apiErrorMessage(settings.error)}</Callout>
      ) : null}
      <Checklist />
      <Usage />
    </div>
  );
}

function VoiceSettings({
  data,
  onChange,
}: {
  data: CallsAdminSettings;
  onChange: (b: Parameters<typeof callsApi.patchAdminSettings>[0]) => void;
}) {
  const groups = useQuery({ queryKey: ["admin", "groups"], queryFn: groupsApi.list, staleTime: 60_000 });
  const everyone = data.group_ids === null;
  const [limit, setLimit] = useState(String(data.max_participants));

  return (
    <SettingsCard title="Voice channels" icon={<PhoneCall className="h-4 w-4" />}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-[var(--text-muted)]">
          Voice channels in Rooms spaces, like Discord's: drop in, talk, share your screen. Audio goes through this server's
          own calls service; nothing said is recorded, indexed or seen by the AI.
        </p>
        {!data.configured && (
          <Callout tone="warning" className="text-xs">
            The calls service isn't set up on this server yet, so voice can't be turned on. The checklist below says what to do.
          </Callout>
        )}
        <label className="flex items-start gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={data.enabled}
            disabled={!data.configured && !data.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          <span>
            Voice is on
            <span className="block text-xs text-[var(--text-muted)]">
              Off hides voice channels' people and join buttons everywhere. Nothing is deleted.
            </span>
          </span>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm text-[var(--text)]">Who can use voice</legend>
          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input type="radio" name="calls-who" checked={everyone} onChange={() => onChange({ everyone: true })} />
            Everyone on this server
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="radio"
              name="calls-who"
              checked={!everyone}
              onChange={() => onChange({ group_ids: data.group_ids ?? [] })}
            />
            Only people in these groups (admins always can)
          </label>
          {!everyone && (
            <div className="ml-6 flex flex-col gap-1.5">
              {groups.data?.length ? (
                groups.data.map((g) => {
                  const on = data.group_ids?.includes(g.id) ?? false;
                  return (
                    <label key={g.id} className="flex items-center gap-2 text-sm text-[var(--text)]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          onChange({
                            group_ids: on ? (data.group_ids ?? []).filter((x) => x !== g.id) : [...(data.group_ids ?? []), g.id],
                          })
                        }
                      />
                      {g.name}
                      <span className="text-xs text-[var(--text-muted)]">
                        ({g.members.length} {g.members.length === 1 ? "person" : "people"})
                      </span>
                    </label>
                  );
                })
              ) : (
                <p className="text-xs text-[var(--text-muted)]">
                  No groups yet. Make one in{" "}
                  <Link to="/admin?tab=groups" className="font-medium text-[var(--accent-text)] underline">
                    Groups
                  </Link>
                  .
                </p>
              )}
              {data.group_ids?.length === 0 && <p className="text-xs text-[var(--warning)]">No group picked: only admins have voice.</p>}
            </div>
          )}
        </fieldset>

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--text)]">
            Best Go Live quality
            <select
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
              value={data.max_stream}
              onChange={(e) => onChange({ max_stream: e.target.value as StreamQuality })}
            >
              {(Object.keys(STREAM_LABELS) as StreamQuality[]).map((q) => (
                <option key={q} value={q}>
                  {STREAM_LABELS[q]}
                </option>
              ))}
            </select>
            <span className="max-w-xs text-xs text-[var(--text-muted)]">
              Streams use your home's upload. Lower this if streams stutter for viewers.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text)]">
            Most people in one channel
            <input
              className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
              type="number"
              min={2}
              max={99}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              onBlur={() => {
                const n = Number(limit);
                if (Number.isInteger(n) && n >= 2 && n <= 99) {
                  if (n !== data.max_participants) onChange({ max_participants: n });
                } else {
                  setLimit(String(data.max_participants));
                  toast.error("Pick a number from 2 to 99.");
                }
              }}
            />
            <span className="max-w-xs text-xs text-[var(--text-muted)]">A channel's own limit can't go above this.</span>
          </label>
        </div>
      </div>
    </SettingsCard>
  );
}

const STATUS_ICON = {
  ok: <CheckCircle2 className="h-4 w-4 text-[var(--success)]" aria-label="OK" />,
  warn: <AlertTriangle className="h-4 w-4 text-[var(--warning)]" aria-label="Needs attention" />,
  fail: <XCircle className="h-4 w-4 text-[var(--danger)]" aria-label="Not working" />,
  unknown: <CircleHelp className="h-4 w-4 text-[var(--text-muted)]" aria-label="Not checked yet" />,
} as const;

function Checklist() {
  const q = useQuery({ queryKey: ["calls", "admin", "check"], queryFn: callsApi.check, refetchOnWindowFocus: true });
  return (
    <SettingsCard
      title="Set-up checklist"
      icon={<ListChecks className="h-4 w-4" />}
      headerExtra={
        <Button size="sm" variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching} leftIcon={<RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />}>
          Check again
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {q.isLoading && <p className="text-xs text-[var(--text-muted)]">Checking…</p>}
        {q.isError && <Callout>Couldn't run the checks. {apiErrorMessage(q.error)}</Callout>}
        {q.data && (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {q.data.checks.map((c) => (
              <CheckRow key={c.id} c={c} />
            ))}
          </ul>
        )}
        <div className="rounded-card border border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
          <p className="font-semibold text-[var(--text)]">For voice from outside your home</p>
          <p className="mt-1">
            On your router, forward <strong>UDP {q.data?.ports.udp ?? 7882}</strong> and <strong>TCP {q.data?.ports.tcp ?? 7881}</strong>{" "}
            to this server. Voice doesn't go through Cloudflare or your web address, so nothing else is needed: no new domain, no
            certificate. Then run{" "}
            <Link to="/account/voice" className="font-medium text-[var(--accent-text)] underline">
              Test calls
            </Link>{" "}
            on a phone with Wi-Fi off. Devices on your home Wi-Fi work without any of this.
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}

function CheckRow({ c }: { c: CallsCheck }) {
  return (
    <li className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">{STATUS_ICON[c.status]}</span>
      <div className="min-w-0 text-sm">
        <p className="font-medium text-[var(--text)]">{c.label}</p>
        <p className="text-xs text-[var(--text-muted)]">{c.detail}</p>
        {c.fix && <p className="mt-1 break-words text-xs text-[var(--text)]">{c.fix}</p>}
      </div>
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-[var(--border)] p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[var(--text)]">{value}</p>
      {hint && <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

function Usage() {
  const q = useQuery({
    queryKey: ["calls", "admin", "usage"],
    queryFn: callsApi.usage,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const u = q.data;
  const upload =
    u?.upload_bps == null
      ? u?.metrics_available
        ? "Measuring…"
        : "—"
      : u.upload_bps >= 1_000_000
        ? `${(u.upload_bps / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(u.upload_bps / 1000)} kbps`;
  return (
    <SettingsCard title="Live usage" icon={<Activity className="h-4 w-4" />}>
      {q.isError ? (
        <Callout>Couldn't load usage. {apiErrorMessage(q.error)}</Callout>
      ) : !u ? (
        <SkeletonRows count={3} label="Loading" />
      ) : (
        <div className="flex flex-col gap-3">
          {!u.running && <p className="text-xs text-[var(--text-muted)]">The calls service isn't running, so there's nothing live to show.</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="In voice now" value={u.people_in_voice == null ? "—" : String(u.people_in_voice)} hint={u.tests_running ? `${u.tests_running} test call${u.tests_running === 1 ? "" : "s"} running` : undefined} />
            <Stat label="Channels in use" value={u.channels_in_use == null ? "—" : String(u.channels_in_use)} />
            <Stat label="Upload right now" value={upload} hint={u.running && !u.metrics_available ? "The calls service's metrics port isn't reachable" : undefined} />
            <Stat label="Last 30 days" value={`${u.minutes_30d.toLocaleString()} min`} hint="Time people spent in voice" />
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
