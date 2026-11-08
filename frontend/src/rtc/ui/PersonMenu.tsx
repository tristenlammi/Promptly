/**
 * Someone's menu in a voice channel (right-click, click, or long-press
 * them): their volume for you (0–200%), Mute for me, and for the space's
 * admins Mute / Deafen for everyone, Move to another channel and
 * Disconnect; Message opens your conversation with them.
 */
import { ArrowRightLeft, HeadphoneOff, MessageSquare, MicOff, PhoneOff, Settings, Volume2, VolumeX } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { roomsApi } from "@/api/rooms";
import { voiceApi } from "@/api/voiceChannels";
import { UserAvatar } from "@/rooms/components/ui";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { voice } from "../voice/actions";
import { useVoiceSettings } from "../voice/hooks";
import { personPercent } from "../voice/volume";
import { canModerate, findChannel, nameOf, useChannelMembers, useRoomsBootstrap } from "./directory";
import { ACCENT } from "./bits";
import { Floating } from "./Floating";
import { useVoiceUi } from "./uiStore";

const item =
  "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none disabled:opacity-50";

export function PersonMenu() {
  const target = useVoiceUi((s) => s.personMenu);
  const close = useVoiceUi((s) => s.closePersonMenu);
  return (
    <Floating
      open={!!target}
      onClose={close}
      anchor={target?.anchor ?? null}
      point={target?.point ?? null}
      placement="right"
      width={272}
      label="Voice options"
    >
      {target && <PersonMenuBody userId={target.userId} roomId={target.roomId} onClose={close} />}
    </Floating>
  );
}

function PersonMenuBody({ userId, roomId, onClose }: { userId: string; roomId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const b = useRoomsBootstrap();
  const meId = useAuthStore((s) => s.user?.id) ?? "";
  const settings = useVoiceSettings();
  const members = useChannelMembers(roomId);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const openSettings = useVoiceUi((s) => s.openSettings);

  const ch = findChannel(b, roomId);
  const user = b?.users[userId];
  const name = nameOf(b, userId);
  const me = userId === meId;
  const m = members.find((x) => x.user_id === userId);
  const mod = !!ch && !!m && canModerate(ch.space, meId, userId);
  const pct = personPercent(userId, settings);
  const localMuted = settings.localMutes.includes(userId);
  const otherChannels = ch ? ch.space.rooms.filter((r) => r.kind === "voice" && r.id !== roomId) : [];
  const role = ch?.space.member_roles?.[userId];

  const run = async (what: () => Promise<unknown>, ok: string | null, fail: string) => {
    setBusy(true);
    try {
      await what();
      if (ok) toast.success(ok);
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, fail));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col p-1.5">
      <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
        <UserAvatar user={user} size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {name}
            {me && <span className="font-normal text-[var(--text-muted)]"> (you)</span>}
          </p>
          {(role === "owner" || role === "admin") && <p className="text-[11px] capitalize text-[var(--text-muted)]">Space {role}</p>}
        </div>
      </div>

      {!me && (
        <>
          <div className="px-2.5 pb-2">
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-xs font-medium text-[var(--text-muted)]">
                <span>Volume for you</span>
                <span className="tabular-nums text-[var(--text)]">{localMuted ? "Muted" : `${pct}%`}</span>
              </span>
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={pct}
                aria-label={`Volume of ${name}`}
                aria-valuetext={`${pct}%`}
                onChange={(e) => void voice.setPersonVolume(userId, Number(e.target.value))}
                className="w-full"
                style={{ accentColor: ACCENT }}
                data-autofocus=""
              />
              <span className="flex justify-between text-[10px] text-[var(--text-muted)]">
                <span>0%</span>
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => void voice.setPersonVolume(userId, 100)}>
                  100%
                </button>
                <span>200%</span>
              </span>
            </label>
          </div>
          <button
            type="button"
            aria-pressed={localMuted}
            className={item}
            onClick={() => void voice.setLocalMute(userId, !localMuted)}
          >
            {localMuted ? <Volume2 className="h-4 w-4 text-[var(--text-muted)]" /> : <VolumeX className="h-4 w-4 text-[var(--text-muted)]" />}
            <span className="flex-1">{localMuted ? "Unmute for me" : "Mute for me"}</span>
            {localMuted && <span className="h-2 w-2 rounded-full bg-[var(--danger)]" aria-hidden />}
          </button>
        </>
      )}

      {mod && m && (
        <>
          <div className="mx-2 my-1 border-t border-[var(--border)]" />
          <p className="px-2.5 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Admin</p>
          <button
            type="button"
            aria-pressed={m.server_muted}
            disabled={busy}
            className={item}
            onClick={() =>
              void run(
                () => voiceApi.moderate(roomId, userId, { server_mute: !m.server_muted }),
                m.server_muted ? `${name} can talk again.` : `${name} is muted for everyone.`,
                "Couldn't change that.",
              )
            }
          >
            <MicOff className={cn("h-4 w-4", m.server_muted ? "text-[var(--danger)]" : "text-[var(--text-muted)]")} />
            <span className="flex-1">{m.server_muted ? "Unmute for everyone" : "Mute for everyone"}</span>
          </button>
          <button
            type="button"
            aria-pressed={m.server_deafened}
            disabled={busy}
            className={item}
            onClick={() =>
              void run(
                () => voiceApi.moderate(roomId, userId, { server_deafen: !m.server_deafened }),
                m.server_deafened ? `${name} can hear again.` : `${name} is deafened for everyone.`,
                "Couldn't change that.",
              )
            }
          >
            <HeadphoneOff className={cn("h-4 w-4", m.server_deafened ? "text-[var(--danger)]" : "text-[var(--text-muted)]")} />
            <span className="flex-1">{m.server_deafened ? "Undeafen for everyone" : "Deafen for everyone"}</span>
          </button>
          {otherChannels.length > 0 && (
            <>
              <button type="button" aria-expanded={moveOpen} disabled={busy} className={item} onClick={() => setMoveOpen((v) => !v)}>
                <ArrowRightLeft className="h-4 w-4 text-[var(--text-muted)]" />
                <span className="flex-1">Move to…</span>
              </button>
              {moveOpen && (
                <div className="ml-6 flex flex-col" role="group" aria-label={`Move ${name} to`}>
                  {otherChannels.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      disabled={busy}
                      className={cn(item, "h-8 text-[13px]")}
                      onClick={() => void run(() => voiceApi.move(roomId, userId, r.id), `Moving ${name} to ${r.name}.`, "Couldn't move them.")}
                    >
                      <Volume2 className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      <span className="truncate">{r.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {!me && (
            <button
              type="button"
              disabled={busy}
              className={cn(item, "text-[var(--danger)]")}
              onClick={() => void run(() => voiceApi.disconnect(roomId, userId), `${name} was disconnected.`, "Couldn't disconnect them.")}
            >
              <PhoneOff className="h-4 w-4" />
              <span className="flex-1">Disconnect</span>
            </button>
          )}
        </>
      )}

      <div className="mx-2 my-1 border-t border-[var(--border)]" />
      {me ? (
        <button
          type="button"
          className={item}
          onClick={() => {
            onClose();
            openSettings();
          }}
        >
          <Settings className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="flex-1">Voice &amp; video settings</span>
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          className={item}
          onClick={() =>
            void run(
              async () => {
                const room = await roomsApi.openDm([userId]);
                navigate(`/rooms/r/${room.id}`);
              },
              null,
              "Couldn't open the conversation.",
            )
          }
        >
          <MessageSquare className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="flex-1">Message</span>
        </button>
      )}
    </div>
  );
}
