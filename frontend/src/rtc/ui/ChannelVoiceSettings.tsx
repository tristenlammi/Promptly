/**
 * A voice channel's own settings, in its settings sheet: user limit, voice
 * quality, who can join and talk, video and Go Live, and how long someone
 * may stay alone before "Still there?". The space's admins change them
 * (saved at once); everyone else sees them.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Volume2 } from "lucide-react";

import type { Bootstrap, Room } from "@/api/rooms";
import { voiceApi, type VoiceChannelSettings, type VoiceQuality } from "@/api/voiceChannels";
import { Segmented, Select, Toggle } from "@/items/ui";
import { BOOTSTRAP_KEY, patchRoom } from "@/rooms/cache";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { QUALITY_WORDS } from "./words";

const DEFAULTS: VoiceChannelSettings = {
  user_limit: 0,
  quality: "good",
  bitrate: 64,
  join_role: "member",
  talk_role: "member",
  video: true,
  alone_minutes: 15,
};

const ALONE = [5, 15, 30, 60] as const;

export function ChannelVoiceSettings({ room, isAdmin }: { room: Room; isAdmin: boolean }) {
  const qc = useQueryClient();
  const v = room.voice ?? DEFAULTS;
  const maxPeople = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY)?.voice_limits?.max_participants ?? 30;

  const save = async (patch: Parameters<typeof voiceApi.patchSettings>[1]) => {
    const before = room.voice;
    patchRoom(qc, room.id, (r) => ({ ...r, voice: { ...(r.voice ?? DEFAULTS), ...patch } as VoiceChannelSettings }));
    try {
      const got = await voiceApi.patchSettings(room.id, patch);
      patchRoom(qc, room.id, (r) => ({ ...r, voice: got }));
    } catch (err) {
      patchRoom(qc, room.id, (r) => ({ ...r, voice: before }));
      toast.error(apiErrorMessage(err, "Couldn't save that."));
    }
  };

  const alone = v.alone_minutes === null ? "never" : String(v.alone_minutes);

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm" data-testid="channel-voice-settings">
        <p className="flex items-center gap-2 font-semibold text-[var(--text)]">
          <Volume2 className="h-4 w-4 text-[var(--text-muted)]" /> Voice
        </p>
        <p className="text-[var(--text-muted)]">
          {v.user_limit ? `Up to ${v.user_limit} people` : "No user limit"} · {QUALITY_WORDS[v.quality].label} quality
          {v.join_role === "admin" ? " · admins only" : ""}
          {v.talk_role === "admin" ? " · only admins talk" : ""}
          {!v.video ? " · no video" : ""}
        </p>
        <p className="text-xs text-[var(--text-muted)]">Only the space's admins can change these.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="channel-voice-settings">
      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <Volume2 className="h-4 w-4 text-[var(--text-muted)]" /> Voice
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-[var(--text-muted)]">User limit</span>
        <Select value={String(v.user_limit)} onChange={(e) => void save({ user_limit: Number(e.target.value) })} aria-label="User limit">
          <option value="0">No limit</option>
          {Array.from({ length: Math.max(0, maxPeople - 1) }, (_, i) => i + 2).map((n) => (
            <option key={n} value={n}>
              {n} people
            </option>
          ))}
        </Select>
        <span className="text-[11px] text-[var(--text-muted)]">Admins can still join a full channel.</span>
      </label>

      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Voice quality">
        <span className="text-xs font-medium text-[var(--text-muted)]">Voice quality</span>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(QUALITY_WORDS) as VoiceQuality[]).map((q) => (
            <button
              key={q}
              type="button"
              role="radio"
              aria-checked={v.quality === q}
              onClick={() => void save({ quality: q })}
              className={cn(
                "flex flex-col rounded-xl border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                v.quality === q ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)]" : "border-[var(--border)] hover:bg-[var(--hover)]",
              )}
            >
              <span className="text-sm font-medium text-[var(--text)]">{QUALITY_WORDS[q].label}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{QUALITY_WORDS[q].detail}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-muted)]">Who can join</span>
        <Segmented<"member" | "admin">
          className="w-full"
          value={v.join_role}
          onChange={(x) => void save({ join_role: x })}
          options={[
            { value: "member", label: "Everyone in the space" },
            { value: "admin", label: "Admins only" },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-muted)]">Who can talk</span>
        <Segmented<"member" | "admin">
          className="w-full"
          value={v.talk_role}
          onChange={(x) => void save({ talk_role: x })}
          options={[
            { value: "member", label: "Everyone" },
            { value: "admin", label: "Admins only" },
          ]}
        />
        {v.talk_role === "admin" && <span className="text-[11px] text-[var(--text-muted)]">Others can join and listen; their microphone stays off.</span>}
      </div>

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--text)]">Cameras and Go Live</p>
          <p className="text-xs text-[var(--text-muted)]">Let people turn on their camera and share their screen here.</p>
        </div>
        <Toggle label="Cameras and Go Live" checked={v.video} onChange={(x) => void save({ video: x })} />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-[var(--text-muted)]">Disconnect people who are alone</span>
        <Select
          value={alone}
          onChange={(e) => void save({ alone_minutes: e.target.value === "never" ? null : Number(e.target.value) })}
          aria-label="Disconnect people who are alone"
          data-testid="alone-minutes"
        >
          {ALONE.map((m) => (
            <option key={m} value={String(m)}>
              After {m} minutes{m === 15 ? " (default)" : ""}
            </option>
          ))}
          <option value="never">Never</option>
        </Select>
        <span className="text-[11px] text-[var(--text-muted)]">They're asked “Still there?” first and have 2 minutes to answer. Saves phone battery and data.</span>
      </label>
    </div>
  );
}
