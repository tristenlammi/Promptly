/**
 * Ctrl+K rows for voice: "Join Lounge" for any voice channel you can see,
 * and while you're in voice, Mute, Deafen, Leave voice and Voice settings.
 */
import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, Settings, Volume2 } from "lucide-react";
import { useMemo } from "react";

import type { PaletteAction } from "@/components/chat/usePaletteActions";

import { voice } from "../voice/actions";
import { useVoice } from "../voice/hooks";
import { useRoomsBootstrap } from "./directory";
import { joinVoice, useVoiceUi } from "./uiStore";
import { SHORTCUTS } from "./words";

const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();

export function useVoicePaletteRows(query: string, navigate: (to: string) => void): PaletteAction[] {
  const s = useVoice((v) => ({ status: v.status, roomId: v.roomId, muted: v.muted, deafened: v.deafened }));
  const inVoice = s.status !== "idle";
  const q = norm(query);
  const b = useRoomsBootstrap(q.length >= 2 || inVoice);

  return useMemo(() => {
    const out: PaletteAction[] = [];
    if (!b || b.voice_available !== true) return out;
    const joinish = /^(join|voice|hop in|go to)\b\s*/.exec(q);
    const term = joinish ? q.slice(joinish[0].length) : q;
    if (q.length >= 2) {
      for (const space of b.spaces) {
        for (const r of space.rooms) {
          if (r.kind !== "voice" || r.id === s.roomId) continue;
          const name = norm(r.name);
          const hit = term ? name.startsWith(term) || name.includes(` ${term}`) || norm(space.name).startsWith(term) : !!joinish;
          if (!hit) continue;
          const people = b.voice?.[r.id]?.length ?? 0;
          out.push({
            key: `voice-join-${r.id}`,
            icon: <Volume2 className="h-4 w-4" />,
            title: `${inVoice ? "Switch to" : "Join"} ${r.name}`,
            detail: `${space.name} · ${people === 0 ? "no one's there yet" : `${people} in voice`}`,
            sure: !!joinish && !!term,
            group: "Voice",
            run: async () => {
              navigate(`/rooms/r/${r.id}`);
              void joinVoice(r.id);
              return true;
            },
          });
        }
      }
    }
    if (inVoice) {
      const says = (...words: string[]) => !q || words.some((w) => w.startsWith(q) || q.startsWith(w));
      if (says("mute", "unmute", "mic")) {
        out.push({
          key: "voice-mute",
          icon: s.muted ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />,
          title: s.muted ? "Unmute" : "Mute",
          detail: `Your microphone · ${SHORTCUTS.mute}`,
          sure: q === "mute" || q === "unmute",
          group: "Voice",
          run: async () => {
            void voice.toggleMute();
            return true;
          },
        });
      }
      if (says("deafen", "undeafen")) {
        out.push({
          key: "voice-deafen",
          icon: s.deafened ? <Headphones className="h-4 w-4" /> : <HeadphoneOff className="h-4 w-4" />,
          title: s.deafened ? "Undeafen" : "Deafen",
          detail: `Hear nothing, and mute you too · ${SHORTCUTS.deafen}`,
          sure: q === "deafen" || q === "undeafen",
          group: "Voice",
          run: async () => {
            void voice.toggleDeafen();
            return true;
          },
        });
      }
      if (says("leave", "leave voice", "disconnect", "hang up")) {
        out.push({
          key: "voice-leave",
          icon: <PhoneOff className="h-4 w-4" />,
          title: "Leave voice",
          detail: "Disconnect from the voice channel",
          sure: q.startsWith("leave") || q === "disconnect",
          group: "Voice",
          run: async () => {
            void voice.leave();
            return true;
          },
        });
      }
    }
    if (q.length >= 3 && "voice settings".startsWith(q.slice(0, 14)) && q.startsWith("voice s")) {
      out.push({
        key: "voice-settings",
        icon: <Settings className="h-4 w-4" />,
        title: "Voice & video settings",
        detail: "Microphone, noise filter, push to talk",
        sure: false,
        group: "Voice",
        run: async () => {
          useVoiceUi.getState().openSettings();
          return true;
        },
      });
    }
    return out.slice(0, 6);
  }, [b, q, s.roomId, s.muted, s.deafened, inVoice, navigate]);
}
