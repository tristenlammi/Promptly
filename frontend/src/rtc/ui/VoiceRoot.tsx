/**
 * Voice, app-wide (mounted once, signed in): the sheets and menus any
 * voice button opens, every prompt and message (Still there?, problems,
 * moved, ended, the noise-filter fallback, the first-time tip), and
 * rejoining your channel after a page reload.
 */
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Headphones, Mic, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { Bootstrap } from "@/api/rooms";
import { voiceApi } from "@/api/voiceChannels";
import { ItemButton, Sheet } from "@/items/ui";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { voiceHarnessEnabled } from "@/pages/dev/flags";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";

import { fallbackWords } from "../audio/engines";
import { voice, voiceEngine } from "../voice/actions";
import { useVoice, useVoiceSettings } from "../voice/hooks";
import { useVoiceLevels, useVoiceStore } from "../voice/store";
import { findChannel, nameOf } from "./directory";
import { GoLiveSheet } from "./GoLiveSheet";
import { PersonMenu } from "./PersonMenu";
import { joinVoice, useVoiceUi } from "./uiStore";
import { VoiceSettingsSheet } from "./VoiceSettings";
import { endWords, permissionSteps, problemWords, SHORTCUTS } from "./words";

const REJOIN_KEY = "promptly.voice.rejoin";
const REJOIN_WITHIN_MS = 60_000;

export function VoiceRoot() {
  useRejoinAfterReload();
  useEffect(() => {
    // Developer builds and the e2e suite (localStorage "promptly.dev" =
    // "voice"): the voice state, for measuring what's heard.
    if (voiceHarnessEnabled()) (window as unknown as { __voice: unknown }).__voice = { store: useVoiceStore, levels: useVoiceLevels, engine: voiceEngine };
  }, []);
  useNoticeToasts();
  return (
    <>
      <VoiceSettingsSheet />
      <GoLiveSheet />
      <PersonMenu />
      <StillThere />
      <ProblemCard />
      <FirstTimeTip />
    </>
  );
}

/** Reloading the page drops the connection; come straight back to the
 *  same channel (this tab only, and not if you've since joined on your
 *  phone). */
function useRejoinAfterReload() {
  useEffect(() => {
    const save = () => {
      const s = useVoiceStore.getState();
      try {
        if (s.roomId && (s.status === "connected" || s.status === "reconnecting")) {
          window.sessionStorage.setItem(REJOIN_KEY, JSON.stringify({ roomId: s.roomId, at: Date.now() }));
        } else window.sessionStorage.removeItem(REJOIN_KEY);
      } catch {
        /* no rejoin */
      }
    };
    window.addEventListener("pagehide", save);
    let marker: { roomId: string; at: number } | null = null;
    try {
      marker = JSON.parse(window.sessionStorage.getItem(REJOIN_KEY) ?? "null");
      window.sessionStorage.removeItem(REJOIN_KEY);
    } catch {
      marker = null;
    }
    if (marker && Date.now() - marker.at < REJOIN_WITHIN_MS) {
      const want = marker.roomId;
      void voiceApi
        .me()
        .then((me) => {
          // In voice on another device now (the phone took over): stay out.
          if (me.room_id && me.device === "android") return;
          if (useVoiceStore.getState().status !== "idle") return;
          void joinVoice(me.room_id ?? want);
        })
        .catch(() => undefined);
    }
    return () => window.removeEventListener("pagehide", save);
  }, []);
}

function channelName(qc: ReturnType<typeof useQueryClient>, roomId: string | null | undefined): string {
  return findChannel(qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY), roomId)?.room.name ?? "the voice channel";
}

/** Moved, ended and the noise-filter fallback, as toasts. */
function useNoticeToasts() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const notice = useVoice((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const b = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
    if (notice.kind === "moved") {
      const to = channelName(qc, notice.toRoomId);
      toast.info(`${nameOf(b, notice.by)} moved you to ${to}.`, { action: { label: "Open", onClick: () => navigate(`/rooms/r/${notice.toRoomId}`) } });
    } else if (notice.kind === "ended") {
      const ch = channelName(qc, notice.roomId);
      const by = notice.by ? nameOf(b, notice.by) : null;
      const text = endWords(notice.reason, ch, by);
      if (notice.reason === "connection") toast.error(text, { action: { label: "Rejoin", onClick: () => void voice.rejoin() }, duration: 30_000 });
      else if (notice.reason === "replaced" || notice.reason === "left") toast.info(text);
      else toast.warning(text);
    } else if (notice.kind === "noise-fallback") {
      const words = fallbackWords(notice.reason);
      if (words) toast.info(words);
    }
    void voice.dismissNotice();
  }, [notice, qc, navigate]);
}

function StillThere() {
  const ask = useVoice((s) => s.stillThere);
  const qc = useQueryClient();
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!ask) return;
    const end = Date.parse(ask.deadline) || Date.now() + ask.seconds * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    // The browser tab may be in the background: say it out loud too.
    try {
      if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
        new Notification("Still there?", { body: "You're alone in a voice channel. Answer or you'll be disconnected.", tag: "voice-still-there" });
      }
    } catch {
      /* no notification */
    }
    return () => window.clearInterval(t);
  }, [ask]);
  const ch = channelName(qc, ask?.roomId);
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <Sheet
      open={!!ask}
      onClose={() => void voice.answerStillHere()}
      title="Still there?"
      size="sm"
      footer={
        <div className="flex w-full justify-end gap-2">
          <ItemButton variant="secondary" onClick={() => void voice.leave()}>
            Leave
          </ItemButton>
          <ItemButton variant="primary" onClick={() => void voice.answerStillHere()} data-autofocus="">
            I'm still here
          </ItemButton>
        </div>
      }
    >
      <p className="text-sm text-[var(--text)]" data-testid="still-there">
        You've been on your own in {ch} for a while. To save battery and data, you'll be disconnected in{" "}
        <b className="tabular-nums">
          {mm}:{ss}
        </b>{" "}
        unless you answer.
      </p>
    </Sheet>
  );
}

function ProblemCard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { problem, status, roomId } = useVoice((s) => ({ problem: s.problem, status: s.status, roomId: s.roomId }));
  const lastJoin = useVoiceUi((s) => s.lastJoinRoomId);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [steps, setSteps] = useState(false);
  useEffect(() => setSteps(false), [problem]);
  if (!problem) return null;
  // "full" / "forbidden" right after a click: the channel page says it too.
  const target = roomId ?? lastJoin;
  const w = problemWords(problem, channelName(qc, target));
  const mic = problem.kind.startsWith("mic");
  const inVoice = status === "connected" || status === "reconnecting";
  const retry = () => {
    void voice.dismissProblem();
    if (mic && inVoice) void voice.retryMic();
    else if (target) void joinVoice(target);
  };
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-3 z-[95] w-[min(28rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-lg)]"
      data-testid="voice-problem"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--danger)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text)]">{w.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{w.text}</p>
          {w.permissionHelp && steps && <p className="mt-2 rounded-lg bg-[var(--surface-2)] p-2 text-xs text-[var(--text)]">{permissionSteps()}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {(w.retry || (mic && inVoice)) && target && (
              <ItemButton size="sm" variant="primary" onClick={retry}>
                Try again
              </ItemButton>
            )}
            {w.permissionHelp && !steps && (
              <ItemButton size="sm" variant="secondary" onClick={() => setSteps(true)}>
                How to allow it
              </ItemButton>
            )}
            {problem.kind === "connect-failed" && isAdmin && (
              <ItemButton
                size="sm"
                variant="secondary"
                onClick={() => {
                  void voice.dismissProblem();
                  navigate("/admin?tab=calls");
                }}
              >
                Check the calls setup
              </ItemButton>
            )}
            {problem.kind === "connect-failed" && !isAdmin && (
              <ItemButton
                size="sm"
                variant="secondary"
                onClick={() => {
                  void voice.dismissProblem();
                  navigate("/account/voice");
                }}
              >
                Test calls
              </ItemButton>
            )}
          </div>
        </div>
        <button type="button" aria-label="Dismiss" onClick={() => void voice.dismissProblem()} className="-m-1 rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** Once, the first time you're in voice: where Mute, Deafen and settings are. */
function FirstTimeTip() {
  const { status } = useVoice((s) => ({ status: s.status }));
  const { prefs } = useVoiceSettings();
  const openSettings = useVoiceUi((s) => s.openSettings);
  const [dismissed, setDismissed] = useState(false);
  // Not over the developer harness (it has its own controls).
  if (prefs.tips_seen || dismissed || status !== "connected" || window.location.pathname.startsWith("/dev/")) return null;
  const done = () => {
    setDismissed(true);
    void voice.updatePrefs({ tips_seen: true });
  };
  return (
    <div
      role="dialog"
      aria-label="You're in voice"
      className="fixed bottom-4 left-1/2 z-[85] w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-lg)] md:left-auto md:right-4 md:translate-x-0"
      data-testid="voice-tip"
    >
      <p className="text-sm font-semibold text-[var(--text)]">You're in voice</p>
      <ul className="mt-2 flex flex-col gap-1.5 text-xs text-[var(--text-muted)]">
        <li className="flex items-center gap-2">
          <Mic className="h-3.5 w-3.5 shrink-0" /> Mute your mic with the microphone button, or{" "}
          <kbd className="rounded border border-[var(--border)] px-1 font-mono">{SHORTCUTS.mute}</kbd>
        </li>
        <li className="flex items-center gap-2">
          <Headphones className="h-3.5 w-3.5 shrink-0" /> Deafen to hear nothing, or{" "}
          <kbd className="rounded border border-[var(--border)] px-1 font-mono">{SHORTCUTS.deafen}</kbd>
        </li>
        <li className="flex items-center gap-2">
          <Settings className="h-3.5 w-3.5 shrink-0" /> Microphone, noise filter and push to talk are in Voice &amp; video settings
        </li>
        <li>The voice panel stays with you on every page, so you can keep talking while you do other things.</li>
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <ItemButton
          size="sm"
          variant="secondary"
          onClick={() => {
            done();
            openSettings();
          }}
        >
          Open settings
        </ItemButton>
        <ItemButton size="sm" variant="primary" onClick={done}>
          Got it
        </ItemButton>
      </div>
    </div>
  );
}
