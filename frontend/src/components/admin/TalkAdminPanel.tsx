import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, ExternalLink, Gauge } from "lucide-react";
import { Link } from "react-router-dom";

import { apiClient } from "@/api/client";
import { groupsApi } from "@/api/groups";
import { Callout } from "@/components/shared/Callout";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { SettingsCard } from "./SettingsCard";

/**
 * Admin → Talk (WP-T6): whether people can have live spoken conversations
 * with Promptly, who, how many at once, the speech models behind it, and how
 * fast it's been. The speed numbers are timings only: nothing anyone said is
 * kept for this, or shown here.
 */

const SETUP_NOTES = "https://github.com/tristenlammi/Promptly#talking-to-promptly";

interface TalkAdmin {
  enabled: boolean;
  group_ids: string[];
  live_slots: number;
  max_live_slots: number;
  talking_now: number;
  answers: {
    voice_model_set: boolean;
    provider: string | null;
    model: string | null;
    hosted: boolean | null;
    provider_enabled?: boolean;
  };
  speech: {
    listening: {
      reachable: boolean;
      live_model: string | null;
      live_slots: number | null;
      turn_detector: string | null;
      dictation_model: string | null;
      device: string | null;
    };
    speaking: {
      reachable: boolean;
      model: string | null;
      default_voice: string | null;
      threads: number | string | null;
      stream_slots: number | null;
    };
  };
}

interface Stat {
  median_ms: number | null;
  p90_ms: number | null;
  count: number;
}

type TimingKey = "end_of_turn" | "transcript" | "model" | "first_audio" | "barge_in";

interface UsageBlock {
  turns: number;
  conversations: number;
  people: number;
  barge_ins: number;
  fast_path: number;
  timings: Record<TimingKey, Stat>;
}

interface Usage {
  days: number;
  keep_days: number;
  all: UsageBlock;
  devices: (UsageBlock & { device: "web" | "android" | "car" })[];
}

const KEY = ["admin", "talk"];

const STEPS: { key: TimingKey; label: string; hint: string }[] = [
  { key: "end_of_turn", label: "Knowing you'd finished", hint: "Your last word → it decided you'd stopped talking" },
  { key: "transcript", label: "Final transcript", hint: "Your last word → the full text of what you said" },
  { key: "model", label: "Model's first words", hint: "The model asked → its first words back" },
  { key: "first_audio", label: "First sound", hint: "Your last word → you hear the answer start. The one that matters most." },
  { key: "barge_in", label: "Going quiet when talked over", hint: "It heard you talk over it → its voice stopped" },
];

const DEVICE_LABEL: Record<string, string> = { web: "Web", android: "Android", car: "Car" };

function seconds(ms: number | null): string {
  if (ms == null) return "–";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function TalkAdminPanel() {
  const qc = useQueryClient();
  const { data, isError, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await apiClient.get<TalkAdmin>("/admin/talk")).data,
    refetchInterval: 15_000,
  });
  const groups = useQuery({ queryKey: ["admin", "groups"], queryFn: groupsApi.list });
  const patch = useMutation({
    mutationFn: async (body: Partial<Pick<TalkAdmin, "enabled" | "group_ids" | "live_slots">>) =>
      (await apiClient.patch<TalkAdmin>("/admin/talk", body)).data,
    // Shown at once; put back if the server says no.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: KEY });
      const before = qc.getQueryData<TalkAdmin>(KEY);
      if (before) qc.setQueryData<TalkAdmin>(KEY, { ...before, ...body });
      return { before };
    },
    onSuccess: (row) => {
      qc.setQueryData(KEY, row);
      // The Talk orb reads this for the admin too.
      void qc.invalidateQueries({ queryKey: ["talk", "config"] });
    },
    onError: (e, _body, ctx) => {
      if (ctx?.before) qc.setQueryData(KEY, ctx.before);
      toast.error(apiErrorMessage(e));
    },
  });

  if (isError) {
    return <Callout tone="danger">Couldn't load Talk's settings. {apiErrorMessage(error)}</Callout>;
  }
  if (!data) {
    return (
      <p className="text-sm text-[var(--text-muted)]" role="status">
        Loading Talk…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard
        title="Talk"
        icon={<AudioLines className="h-4 w-4" />}
        headerExtra={
          <span className="text-xs text-[var(--text-muted)]" aria-live="polite">
            {data.talking_now === 0
              ? "No one talking now"
              : `${data.talking_now} talking now`}
          </span>
        }
      >
        <div className="flex flex-col gap-5">
          <p className="text-xs text-[var(--text-muted)]">
            Live spoken conversations with Promptly, on the web and in the Android app. Speech is recognised
            and spoken on this server; audio is never saved. What people say is kept like any chat message.
          </p>

          <label className="flex items-start gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={data.enabled}
              disabled={patch.isPending}
              onChange={(e) => patch.mutate({ enabled: e.target.checked })}
            />
            <span>
              Talk is on
              <span className="block text-xs text-[var(--text-muted)]">
                Off hides the Talk button for everyone. Dictation and the simpler tap-to-talk voice mode keep
                working.
              </span>
            </span>
          </label>

          <WhoCanTalk
            data={data}
            groups={groups.data ?? []}
            groupsLoading={groups.isLoading}
            busy={patch.isPending}
            onChange={(ids) => patch.mutate({ group_ids: ids })}
          />

          <LiveSlots data={data} busy={patch.isPending} onSave={(n) => patch.mutate({ live_slots: n })} />
        </div>
      </SettingsCard>

      <SpeechModels data={data} />
      <SpeedCard />
    </div>
  );
}

function WhoCanTalk({
  data,
  groups,
  groupsLoading,
  busy,
  onChange,
}: {
  data: TalkAdmin;
  groups: { id: string; name: string; members: unknown[] }[];
  groupsLoading: boolean;
  busy: boolean;
  onChange: (ids: string[]) => void;
}) {
  const limited = data.group_ids.length > 0;
  // Picking "Only some groups" before ticking one: shown, not saved yet.
  const [choosing, setChoosing] = useState(false);
  const showGroups = limited || choosing;
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...data.group_ids, id] : data.group_ids.filter((g) => g !== id);
    onChange(next);
    if (next.length === 0) setChoosing(true);
  };

  return (
    <fieldset className="flex flex-col gap-2" disabled={!data.enabled || busy}>
      <legend className="mb-1 text-sm font-medium text-[var(--text)]">Who can use it</legend>
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input
          type="radio"
          name="talk-who"
          checked={!showGroups}
          onChange={() => {
            setChoosing(false);
            if (limited) onChange([]);
          }}
        />
        Everyone
      </label>
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input type="radio" name="talk-who" checked={showGroups} onChange={() => setChoosing(true)} />
        Only people in some groups
      </label>
      {showGroups && (
        <div className="ml-6 flex flex-col gap-1.5">
          {groupsLoading ? (
            <p className="text-xs text-[var(--text-muted)]">Loading groups…</p>
          ) : groups.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">
              There are no groups yet. Make one under{" "}
              <Link to="/admin?tab=groups" className="font-medium text-[var(--accent)] underline">
                Groups
              </Link>
              , then come back.
            </p>
          ) : (
            <>
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={data.group_ids.includes(g.id)}
                    onChange={(e) => toggle(g.id, e.target.checked)}
                  />
                  {g.name}
                  <span className="text-xs text-[var(--text-muted)]">
                    {g.members.length} {g.members.length === 1 ? "person" : "people"}
                  </span>
                </label>
              ))}
              <p className="text-xs text-[var(--text-muted)]">
                {limited
                  ? "Admins can always talk. Everyone else needs to be in a ticked group."
                  : "Tick at least one group. Until then, everyone can talk."}
              </p>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}

function LiveSlots({ data, busy, onSave }: { data: TalkAdmin; busy: boolean; onSave: (n: number) => void }) {
  const [value, setValue] = useState(String(data.live_slots));
  useEffect(() => setValue(String(data.live_slots)), [data.live_slots]);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= data.max_live_slots;
  const save = () => {
    if (valid && n !== data.live_slots) onSave(n);
    else if (!valid) setValue(String(data.live_slots));
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="talk-live-slots" className="text-sm font-medium text-[var(--text)]">
        People talking at once
      </label>
      <div className="flex items-center gap-2">
        <input
          id="talk-live-slots"
          className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
          type="number"
          inputMode="numeric"
          min={1}
          max={data.max_live_slots}
          value={value}
          disabled={!data.enabled || busy}
          aria-describedby="talk-live-slots-hint"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
      </div>
      <span id="talk-live-slots-hint" className="text-xs text-[var(--text-muted)]">
        Each person talking uses about one CPU core while they speak. Someone who starts when it's full is told
        to try again in a minute. Between 1 and {data.max_live_slots}.
      </span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 text-sm text-[var(--text)]">{children}</dd>
    </div>
  );
}

function SpeechModels({ data }: { data: TalkAdmin }) {
  const { listening, speaking } = data.speech;
  const a = data.answers;
  const detector =
    listening.turn_detector === "ok"
      ? "Smart Turn (knows a pause from an ending)"
      : listening.turn_detector === "loading"
        ? "Smart Turn is loading"
        : "Silence only (Smart Turn isn't available)";
  return (
    <SettingsCard title="Speech models in use" icon={<AudioLines className="h-4 w-4" />}>
      <div className="flex flex-col gap-3">
        {(!listening.reachable || !speaking.reachable) && (
          <Callout tone="warning">
            {!listening.reachable && !speaking.reachable
              ? "Can't reach the speech services (whisper and tts). Talk won't start until they're back."
              : !listening.reachable
                ? "Can't reach the listening service (whisper). Talk won't start until it's back."
                : "Can't reach the speaking service (tts). Talk won't start until it's back."}{" "}
            Check that the containers are running; the setup notes say how.
          </Callout>
        )}
        {listening.reachable && !listening.live_model && (
          <Callout tone="warning">
            Live listening is switched off (WHISPER_LIVE_MODEL=off), so Talk can't start. People get the
            tap-to-talk voice mode instead.
          </Callout>
        )}
        <dl className="divide-y divide-[var(--border)]">
          <Row label="Listening">
            {listening.reachable ? (
              <>
                Whisper <span className="font-medium">{listening.live_model ?? "off"}</span> for Talk
                {listening.live_slots != null && ` (${listening.live_slots} at once)`}
                {listening.dictation_model && (
                  <span className="text-[var(--text-muted)]">
                    {" "}
                    · {listening.dictation_model} for dictation and meetings
                  </span>
                )}
                {listening.device && <span className="text-[var(--text-muted)]"> · on {listening.device.toUpperCase()}</span>}
                <span className="block text-xs text-[var(--text-muted)]">{detector}</span>
              </>
            ) : (
              <span className="text-[var(--text-muted)]">Not reachable</span>
            )}
          </Row>
          <Row label="Speaking">
            {speaking.reachable ? (
              <>
                {speaking.model}
                {speaking.default_voice && (
                  <span className="text-[var(--text-muted)]"> · default voice {speaking.default_voice}</span>
                )}
                <span className="block text-xs text-[var(--text-muted)]">
                  {speaking.stream_slots != null && `${speaking.stream_slots} answers spoken at once`}
                  {speaking.threads != null && ` · ${speaking.threads} threads`}
                </span>
              </>
            ) : (
              <span className="text-[var(--text-muted)]">Not reachable</span>
            )}
          </Row>
          <Row label="Answers">
            {a.voice_model_set ? (
              <>
                <span className="font-medium">{a.model}</span> from {a.provider}
                {a.provider_enabled === false && (
                  <span className="block text-xs text-[var(--warning)]">
                    That provider is turned off, so spoken answers use each chat's own model.
                  </span>
                )}
                <span className="block text-xs text-[var(--text-muted)]">
                  {a.hosted
                    ? `Hosted: what people say is sent to ${a.provider} as text to get an answer. Talk shows this on hover in its header.`
                    : "On your own network: nothing leaves it."}
                </span>
              </>
            ) : (
              <>
                Each chat's own model
                <span className="block text-xs text-[var(--text-muted)]">
                  A fast voice model makes Talk answer sooner. Pick one under{" "}
                  <Link to="/admin?tab=models" className="font-medium text-[var(--accent)] underline">
                    Models → Defaults
                  </Link>
                  .
                </span>
              </>
            )}
          </Row>
        </dl>
        <a
          href={SETUP_NOTES}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-[var(--accent)] hover:underline"
        >
          Setup notes: models, slots and CPU
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
    </SettingsCard>
  );
}

const RANGES = [1, 7, 30] as const;

function SpeedCard() {
  const [days, setDays] = useState<number>(7);
  const [device, setDevice] = useState<string>("all");
  const { data, isError, error, isLoading } = useQuery({
    queryKey: ["admin", "talk", "usage", days],
    queryFn: async () => (await apiClient.get<Usage>("/admin/talk/usage", { params: { days } })).data,
    refetchInterval: 30_000,
  });
  const block: UsageBlock | null = !data
    ? null
    : device === "all"
      ? data.all
      : (data.devices.find((d) => d.device === device) ?? null);
  const devices = data?.devices ?? [];

  return (
    <SettingsCard
      title="How fast it's been"
      icon={<Gauge className="h-4 w-4" />}
      headerExtra={
        <div role="group" aria-label="Time period" className="flex gap-1">
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition",
                days === d
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              )}
            >
              {d === 1 ? "24 h" : `${d} days`}
            </button>
          ))}
        </div>
      }
    >
      {isError ? (
        <Callout tone="danger">Couldn't load the numbers. {apiErrorMessage(error)}</Callout>
      ) : isLoading || !data ? (
        <p className="text-sm text-[var(--text-muted)]" role="status">
          Loading…
        </p>
      ) : data.all.turns === 0 ? (
        <div className="flex flex-col items-center gap-1 py-6 text-center" data-testid="talk-usage-empty">
          <p className="text-sm font-medium text-[var(--text)]">
            No one has talked to Promptly {days === 1 ? "in the last day" : `in the last ${days} days`}.
          </p>
          <p className="text-xs text-[var(--text-muted)]">Numbers show up here after the first spoken answer.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="talk-usage">
          {devices.length > 1 && (
            <div role="group" aria-label="Device" className="flex flex-wrap gap-1">
              {["all", ...devices.map((d) => d.device)].map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={device === d}
                  onClick={() => setDevice(d)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                    device === d
                      ? "border-[var(--accent)] text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
                  )}
                >
                  {d === "all" ? "All devices" : (DEVICE_LABEL[d] ?? d)}
                </button>
              ))}
            </div>
          )}
          {block == null ? (
            <p className="text-sm text-[var(--text-muted)]">Nothing from this device in this period.</p>
          ) : (
            <>
              <p className="text-sm text-[var(--text)]">
                {block.turns} spoken {block.turns === 1 ? "answer" : "answers"} in {block.conversations}{" "}
                {block.conversations === 1 ? "conversation" : "conversations"} from {block.people}{" "}
                {block.people === 1 ? "person" : "people"}
                {block.barge_ins > 0 && `, talked over ${block.barge_ins} ${block.barge_ins === 1 ? "time" : "times"}`}
                {block.fast_path > 0 && `, ${block.fast_path} answered by a command without the model`}.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Talk timings, median and slow end, {days === 1 ? "last 24 hours" : `last ${days} days`}
                  </caption>
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Step
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                        Usually
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        <abbr title="9 in 10 answers were faster than this" className="no-underline">
                          Slow end
                        </abbr>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {STEPS.map((step) => {
                      const st = block.timings[step.key];
                      return (
                        <tr key={step.key} data-step={step.key}>
                          <th scope="row" className="py-2 pr-3 text-left font-normal">
                            <span className={cn("text-[var(--text)]", step.key === "first_audio" && "font-semibold")}>
                              {step.label}
                            </span>
                            <span className="block text-xs text-[var(--text-muted)]">{step.hint}</span>
                          </th>
                          <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">
                            {seconds(st.median_ms)}
                          </td>
                          <td className="whitespace-nowrap py-2 text-right tabular-nums text-[var(--text-muted)]">
                            {seconds(st.p90_ms)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="text-xs text-[var(--text-muted)]">
            "Usually" is the middle answer; at the "slow end", 9 in 10 answers were faster. Only these timings
            are kept, for {data.keep_days} days: never words or audio.
          </p>
        </div>
      )}
    </SettingsCard>
  );
}
