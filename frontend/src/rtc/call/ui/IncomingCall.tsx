/**
 * A call ringing you: big and clear, like Messenger. A dark full screen on
 * a phone, a card in the middle of the page on a computer. Answer (green),
 * Decline (red), and for a video call "Voice only". Already talking (a call
 * or a voice channel): "End and answer". Rings in every open tab; only one
 * of them plays the ringtone out loud.
 */
import { Phone, PhoneOff, Video } from "lucide-react";
import { forwardRef, useEffect, useRef, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

import { currentVoiceSettings } from "../../voice/prefs";
import { useVoiceStore } from "../../voice/store";
import { calls } from "../actions";
import { playTone } from "../ringtone";
import { inCallHere, useCallStore, type IncomingCall as Ring } from "../store";
import { CALL_ACCENT_STYLE, CALL_GREEN, personOf, RoundButton, TalkingAvatar, useCallPeople } from "./bits";

export function IncomingCall() {
  const rings = useCallStore((s) => s.incoming);
  const list = Object.values(rings).sort((a, b) => a.at - b.at);
  const ring = list[0] ?? null;
  if (!ring) return null;
  return <RingCard key={ring.call_id} ring={ring} more={list.length - 1} />;
}

function RingCard({ ring, more }: { ring: Ring; more: number }) {
  const isPhone = useIsMobile();
  const { users } = useCallPeople(true);
  const answerRef = useRef<HTMLButtonElement>(null);
  const callHere = useCallStore((s) => inCallHere(s));
  const voiceHere = useVoiceStore((s) => s.status !== "idle");
  const busy = ring.busy || callHere || voiceHere;
  const caller = personOf(users, ring.caller?.id, ring.caller?.username);
  const video = ring.media === "video";
  const who = ring.group ? ring.conversation || "Group call" : caller.username;
  const what = ring.group
    ? `${caller.username} is starting a ${video ? "video call" : "call"}`
    : video
      ? "Incoming video call"
      : "Incoming call";

  // The ringtone (one tab out loud), and the tab's title for a hidden tab.
  useEffect(() => {
    const stop = playTone("ring", { exclusive: ring.call_id, volume: currentVoiceSettings().prefs.output_volume / 100 });
    const title = document.title;
    let flip = false;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        document.title = title;
        return;
      }
      flip = !flip;
      document.title = flip ? `${caller.username} is calling…` : title;
    }, 1200);
    return () => {
      stop();
      window.clearInterval(t);
      document.title = title;
    };
  }, [ring.call_id, caller.username]);

  useEffect(() => {
    const t = window.setTimeout(() => answerRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [ring.call_id]);

  const answer = (withVideo: boolean) => void calls.answer(ring.call_id, { video: withVideo, roomId: ring.room_id, media: ring.media });
  const decline = () => void calls.decline(ring.call_id);

  const busyWords = callHere ? "You're on a call. Answering ends it." : voiceHere ? "You're in a voice channel. Answering leaves it." : "You're on a call on another device. Answering ends it.";

  return (
    <div
      className={cn("fixed inset-0 z-[97] flex items-center justify-center", isPhone ? "bg-[#151312]" : "bg-black/40 p-4 backdrop-blur-[2px]")}
      style={CALL_ACCENT_STYLE}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`ring-${ring.call_id}-who`}
        aria-describedby={`ring-${ring.call_id}-what`}
        data-testid="incoming-call"
        data-call-id={ring.call_id}
        className={cn(
          "flex flex-col items-center text-center text-white",
          isPhone
            ? "h-full w-full justify-between px-6 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(4rem,env(safe-area-inset-top))]"
            : "w-[min(24rem,100%)] rounded-[28px] bg-[#1c1917] px-8 pb-8 pt-10 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]",
        )}
      >
        <div className="flex flex-col items-center">
          <span className="relative inline-flex">
            <span className="absolute inset-0 animate-ping rounded-full bg-white/15 [animation-duration:1.8s]" aria-hidden />
            <TalkingAvatar user={caller} size={isPhone ? 112 : 96} speaking={false} />
          </span>
          <h2 id={`ring-${ring.call_id}-who`} className={cn("mt-6 max-w-full truncate font-semibold", isPhone ? "text-[28px]" : "text-2xl")}>
            {who}
          </h2>
          <p id={`ring-${ring.call_id}-what`} className="mt-1.5 text-[15px] text-white/75" aria-live="polite">
            {what}
          </p>
          {busy && (
            <p className="mt-4 rounded-full bg-white/10 px-3 py-1.5 text-[13px] text-white/90" data-testid="incoming-busy">
              {busyWords}
            </p>
          )}
          {more > 0 && <p className="mt-3 text-xs text-white/60">{more === 1 ? "And 1 more call ringing" : `And ${more} more calls ringing`}</p>}
        </div>

        <div className={cn("flex w-full items-start justify-center", isPhone ? "gap-14" : "mt-10 gap-10")}>
          <RoundButton label="Decline" tone="red" size={isPhone ? 72 : 64} onClick={decline} caption="Decline" testId="incoming-decline">
            <PhoneOff className="h-7 w-7" />
          </RoundButton>
          {video && (
            <RoundButton label="Answer with voice only" size={isPhone ? 72 : 64} onClick={() => answer(false)} caption="Voice only" testId="incoming-voice-only">
              <Phone className="h-7 w-7" />
            </RoundButton>
          )}
          <AnswerButton
            ref={answerRef}
            label={busy ? "End and answer" : video ? "Answer with video" : "Answer"}
            caption={busy ? "End and answer" : "Answer"}
            size={isPhone ? 72 : 64}
            onClick={() => answer(video)}
          >
            {video ? <Video className="h-7 w-7" /> : <Phone className="h-7 w-7" />}
          </AnswerButton>
        </div>
      </div>
    </div>
  );
}

/** The green Answer button (focused when the call comes in). */
const AnswerButton = forwardRef<HTMLButtonElement, { label: string; caption: string; size: number; onClick: () => void; children: ReactNode }>(
  function AnswerButton({ label, caption, size, onClick, children }, ref) {
    return (
      <span className="flex flex-col items-center gap-2">
        <button
          ref={ref}
          type="button"
          aria-label={label}
          title={label}
          onClick={onClick}
          data-testid="incoming-answer"
          className="inline-flex items-center justify-center rounded-full text-white shadow-[0_0_0_0_rgba(21,128,61,0.6)] transition-transform duration-150 hover:brightness-110 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70 motion-safe:animate-[call-pulse_1.6s_ease-out_infinite]"
          style={{ width: size, height: size, background: CALL_GREEN }}
        >
          {children}
        </button>
        <span className="text-[13px] font-medium text-white/90" aria-hidden>
          {caption}
        </span>
      </span>
    );
  },
);
