import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Captions as CaptionsIcon,
  CaptionsOff,
  Check,
  Cloud,
  ExternalLink,
  Image as ImageIcon,
  Keyboard,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  PhoneOff,
  Send,
  Square,
  Volume2,
  Wrench,
  X,
} from "lucide-react";

import { authApi } from "@/api/auth";
import { voiceApi } from "@/api/voice";
import { Callout } from "@/components/shared/Callout";
import type { ActivityStep } from "@/components/chat/ToolActivityCard";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { DEFAULT_VOICE_ID, VOICE_BY_ID, VOICE_GROUPS } from "@/data/voices";
import { MapChips } from "@/maps/MapChips";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { talk, talkLevel, useTalkStore, type Exchange, type TalkCard, type TalkUi } from "./session";

/**
 * The Talk screen (WP-T4). Desktop: a panel docked on the right of the chat,
 * so cards and messages land where you can see them, with a Full screen
 * button. Phone: full screen. Top to bottom: header, captions, the orb,
 * one status line, a waiting question, result cards, the bottom bar.
 *
 * The visible captions aren't a live region (they change word by word); a
 * hidden log announces each finished line instead, so captions are the
 * text equivalent of the conversation for a screen reader.
 */

const EXAMPLES = ["What's on today?", "Add milk to my shopping list", "Remind me to call Mum at six"];

interface TalkPanelProps {
  /** Desktop: dock beside the chat (unless the person picks full screen). */
  docked: boolean;
  title: string | null;
  temporary: boolean;
  /** Close Talk (End, Close, Esc). */
  onClose: () => void;
  /** Switch to the tap-to-talk voice mode (Phase 2). */
  onFallback: () => void;
}

export function TalkPanel({ docked, title, temporary, onClose, onFallback }: TalkPanelProps) {
  const s = useTalkStore();
  const [full, setFull] = useState(!docked);
  const [typing, setTyping] = useState(false);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fullScreen = full || !docked;

  // Focus the screen when it opens, so Esc / Space reach it at once.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Keyboard: Esc ends (or closes what's on top), Space talks in tap mode.
  useEffect(() => {
    const inField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (voicesOpen) return; // the sheet closes itself
        if (typing) {
          e.preventDefault();
          setTyping(false);
          return;
        }
        e.preventDefault();
        onClose();
        return;
      }
      if (e.code === "Space" && !e.repeat && !inField(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const st = useTalkStore.getState();
        if (st.turnMode !== "tap" || st.phase !== "live") return;
        if (e.target instanceof HTMLButtonElement) return; // Space presses the button
        e.preventDefault();
        talk.pressTalk();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && useTalkStore.getState().talking && !inField(e.target)) {
        e.preventDefault();
        talk.releaseTalk();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [onClose, voicesOpen, typing]);

  // Full screen locks the page behind it.
  useEffect(() => {
    if (!fullScreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fullScreen]);

  const status = statusLine(s);
  const ended = s.phase === "ended";

  // "That's all" / "bye": the closing tone plays and the screen goes. An
  // ending you didn't ask for (two quiet minutes, a lost connection) stays
  // on screen to say why.
  useEffect(() => {
    if (s.phase !== "ended" || s.problem || s.endReason !== "goodbye") return;
    const t = window.setTimeout(onClose, 700);
    return () => window.clearTimeout(t);
  }, [s.phase, s.problem, s.endReason, onClose]);

  const body = (
    <div
      ref={rootRef}
      tabIndex={-1}
      role={fullScreen ? "dialog" : "complementary"}
      aria-modal={fullScreen ? true : undefined}
      aria-label="Talk to Promptly"
      data-talk-state={s.phase === "live" ? s.state : s.phase}
      className={cn(
        "flex min-h-0 flex-col bg-[var(--bg)] outline-none",
        fullScreen
          ? "fixed inset-0 z-[120] bg-[var(--bg)]/[0.97] backdrop-blur-md"
          : "h-full w-[min(380px,40vw)] shrink-0 border-l border-[var(--border)]"
      )}
    >
      <Header
        s={s}
        title={title}
        temporary={temporary || s.temporary}
        docked={docked}
        full={fullScreen}
        onFull={() => setFull((f) => !f)}
        onVoices={() => setVoicesOpen(true)}
        onClose={onClose}
      />

      {s.weak && s.phase !== "ended" && (
        <Banner tone="warning">
          Weak connection: switching to tap to talk.
          <button type="button" onClick={onFallback} className="ml-2 font-semibold underline">
            Switch now
          </button>
        </Banner>
      )}
      {s.phase === "reconnecting" && !s.weak && <Banner tone="warning">Reconnecting… your words so far are kept.</Banner>}
      {s.audioBlocked && s.phase !== "ended" && (
        <div className="px-4 pt-3">
          <button
            type="button"
            onClick={() => void talk.unlockAudio()}
            className="promptly-voice-orb w-full rounded-full px-4 py-2 text-sm font-semibold text-white"
          >
            <Volume2 className="mr-1.5 inline h-4 w-4" />
            Tap to hear Promptly
          </button>
        </div>
      )}

      <div className="promptly-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {s.problem ? (
          <Problem s={s} onFallback={onFallback} onClose={onClose} />
        ) : (
          <>
            <div className={cn("flex flex-1 flex-col px-4 pt-4", fullScreen && "mx-auto w-full max-w-2xl")}>
              {s.captions ? (
                <Captions exchanges={s.exchanges} onExample={(t) => talk.sendText(t)} live={s.phase === "live"} />
              ) : (
                <div className="flex-1" />
              )}
            </div>

            <div className="flex flex-col items-center gap-3 px-4 py-5">
              <Orb s={s} />
              <MicMeter active={s.phase === "live" && s.state === "listening" && !s.muted && (s.turnMode === "hands_free" || s.talking)} />
              <p
                role="status"
                className={cn(
                  "min-h-[1.25rem] text-center text-sm font-medium",
                  s.phase === "reconnecting" ? "text-[var(--warning)]" : "text-[var(--text-muted)]"
                )}
              >
                {status}
              </p>
              {s.notice && !ended && (
                <p className="max-w-sm text-center text-xs text-[var(--text-muted)]" aria-live="polite">
                  {s.notice}
                </p>
              )}
              {ended && !s.problem && <Ended s={s} onClose={onClose} />}
            </div>

            {s.ask && <AskCard ask={s.ask} />}
            {s.cards.length > 0 && <Cards cards={s.cards} />}
          </>
        )}
      </div>

      {typing && !ended && !s.problem && <TypeInstead onDone={() => setTyping(false)} />}

      {!s.problem && !ended && (
        <BottomBar s={s} typing={typing} onType={() => setTyping((t) => !t)} onEnd={onClose} />
      )}

      <Announcer exchanges={s.exchanges} />
      {voicesOpen && <VoiceSheet onClose={() => setVoicesOpen(false)} />}
    </div>
  );

  return fullScreen ? createPortal(body, document.body) : body;
}

// ------------------------------------------------------------------ status
function statusLine(s: TalkUi): string {
  if (s.phase === "starting") return "Getting ready…";
  if (s.phase === "reconnecting") return "Reconnecting…";
  if (s.phase === "ended") return "";
  if (s.muted) return "Muted. Tap to unmute.";
  if (s.ask) return "Say yes or no, or tap a button.";
  switch (s.state) {
    case "thinking":
      return s.tool ? `${s.tool.replace(/[.…]+$/, "")}…` : "Thinking";
    case "speaking":
      if (s.turnMode === "tap") return "Speaking. Hold Space or tap the orb to talk.";
      return s.interruptMode === "talk" ? "Speaking. Talk to interrupt." : "Speaking. Tap Stop to interrupt.";
    default:
      if (s.turnMode === "tap") return s.talking ? "Listening. Let go when you're done." : "Hold Space, or tap the orb, to talk.";
      return s.hearing ? "Listening…" : "Listening";
  }
}

// ------------------------------------------------------------------ header
function Header({
  s,
  title,
  temporary,
  docked,
  full,
  onFull,
  onVoices,
  onClose,
}: {
  s: TalkUi;
  title: string | null;
  temporary: boolean;
  docked: boolean;
  full: boolean;
  onFull: () => void;
  onVoices: () => void;
  onClose: () => void;
}) {
  const voiceName = VOICE_BY_ID[s.voice || DEFAULT_VOICE_ID]?.name ?? "Voice";
  const dot =
    s.phase === "reconnecting" || s.weak
      ? "bg-amber-500"
      : s.phase !== "live"
        ? "bg-[var(--border)]"
        : s.muted
          ? "bg-[var(--text-muted)]"
          : "bg-[var(--accent)]";
  const median = s.latencies.length
    ? [...s.latencies].sort((a, b) => a - b)[Math.floor(s.latencies.length / 2)]
    : null;
  // A hosted model works out the answers: say where, on hover (or a tap on
  // a phone). Listening and speaking stay on this server either way.
  const cloud = s.answers?.hosted ? `Answers come from ${s.answers.provider}` : null;
  const [cloudShown, setCloudShown] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
      <span
        className={cn("inline-block h-2 w-2 shrink-0 rounded-full", dot, s.phase === "live" && s.state !== "listening" && "animate-pulse")}
        title={median != null ? `Answering in about ${(median / 1000).toFixed(1)} s` : undefined}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <p className="truncate text-sm font-semibold text-[var(--text)]">{s.title || title || "New chat"}</p>
          {cloud && (
            <button
              type="button"
              onClick={() => setCloudShown((v) => !v)}
              aria-label={cloud}
              aria-expanded={cloudShown}
              title={`${cloud}. Your voice is turned into text on this server; only the text is sent.`}
              data-testid="talk-answers-from"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <Cloud className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        {cloud && cloudShown && (
          <p className="text-[11px] text-[var(--text-muted)]">{cloud}. Only the text of what you say is sent.</p>
        )}
        {temporary && <p className="text-[11px] text-[var(--text-muted)]">Temporary · gone in an hour, nothing remembered</p>}
      </div>
      <button
        type="button"
        onClick={onVoices}
        className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text)] transition hover:border-[var(--accent)]/60"
        aria-label={`Voice: ${voiceName}. Change voice`}
      >
        <Volume2 className="h-3 w-3 text-[var(--text-muted)]" />
        {voiceName}
      </button>
      <IconButton
        label={s.captions ? "Hide captions" : "Show captions"}
        pressed={s.captions}
        onClick={() => talk.setCaptions(!s.captions)}
      >
        {s.captions ? <CaptionsIcon className="h-4 w-4" /> : <CaptionsOff className="h-4 w-4" />}
      </IconButton>
      {docked && (
        <IconButton label={full ? "Back to the side panel" : "Full screen"} onClick={onFull}>
          {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </IconButton>
      )}
      <IconButton label="Close Talk (Esc)" onClick={onClose}>
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      {children}
    </button>
  );
}

function Banner({ tone, children }: { tone: "warning"; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "border-b px-4 py-2 text-xs",
        tone === "warning" && "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]"
      )}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ captions
function Captions({
  exchanges,
  onExample,
  live,
}: {
  exchanges: Exchange[];
  onExample: (text: string) => void;
  live: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastText = exchanges.length ? exchanges[exchanges.length - 1].reply + exchanges[exchanges.length - 1].you : "";
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [exchanges.length, lastText]);

  if (exchanges.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
        <p className="max-w-xs text-sm text-[var(--text-muted)]">
          Just start talking. Talk over me any time to interrupt. Say “that's all” to finish.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={!live}
              onClick={() => onExample(ex)}
              className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)] transition hover:border-[var(--accent)]/60 disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    );
  }
  // Two exchanges in view; older ones scroll.
  return (
    <div className="flex flex-1 flex-col justify-end gap-4 pb-2" data-testid="talk-captions">
      {exchanges.map((x) => (
        <div key={x.key} className="flex flex-col gap-1.5">
          {x.you && (
            <p
              className={cn("text-sm", x.youFinal ? "text-[var(--text-muted)]" : "italic text-[var(--text-muted)]/80")}
              data-caption="you"
            >
              {x.typed && <Keyboard className="mr-1 inline h-3 w-3 align-[-1px] opacity-60" aria-label="Typed" />}
              {x.you}
            </p>
          )}
          {x.reply && <ReplyCaption x={x} />}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function ReplyCaption({ x }: { x: Exchange }) {
  if (x.interrupted) {
    const said = x.reply.slice(0, Math.max(x.spoken, 0)).trim();
    return (
      <p className="text-base leading-relaxed text-[var(--text)]" data-caption="reply">
        {said ? `${said}…` : "…"}
        <span className="ml-2 rounded bg-[var(--hover)] px-1.5 py-px text-[10px] font-medium text-[var(--text-muted)]">
          Interrupted
        </span>
      </p>
    );
  }
  const cut = Math.min(x.spoken, x.reply.length);
  return (
    <p className="text-base leading-relaxed" data-caption="reply">
      <span className="text-[var(--text)]">{x.reply.slice(0, cut)}</span>
      <span className="text-[var(--text-muted)]/70">{x.reply.slice(cut)}</span>
    </p>
  );
}

/** Finished lines, for screen readers. */
function Announcer({ exchanges }: { exchanges: Exchange[] }) {
  const lines: string[] = [];
  for (const x of exchanges.slice(-3)) {
    if (x.you && x.youFinal) lines.push(`You said: ${x.you}`);
    if (x.reply && (x.replyDone || x.interrupted)) lines.push(`Promptly: ${x.interrupted ? x.reply.slice(0, x.spoken) : x.reply}`);
  }
  return (
    <div role="log" aria-live="polite" aria-relevant="additions" className="sr-only">
      {lines.map((l, i) => (
        <p key={`${i}:${l.slice(0, 40)}`}>{l}</p>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ the orb
function Orb({ s }: { s: TalkUi }) {
  const haloRef = useRef<HTMLDivElement>(null);
  const listening = s.phase === "live" && s.state === "listening" && !s.muted;
  const thinking = s.phase === "live" && s.state === "thinking";
  const speaking = s.phase === "live" && s.state === "speaking";

  // The level halo follows the microphone (fast attack, slow release).
  useEffect(() => {
    if (!listening) return;
    let env = 0;
    let raf = 0;
    const tick = () => {
      const raw = talkLevel.current;
      env += (raw - env) * (raw > env ? 0.3 : 0.06);
      const el = haloRef.current;
      if (el) {
        el.style.transform = `scale(${1 + env * 0.35})`;
        el.style.opacity = `${0.15 + env * 0.45}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening]);

  let label = "Talk";
  let onClick: (() => void) | undefined;
  if (s.muted) {
    label = "Unmute";
    onClick = () => talk.unmute();
  } else if (s.turnMode === "tap" && s.phase === "live") {
    label = s.talking ? "Done talking" : "Talk";
    onClick = () => (s.talking ? talk.releaseTalk() : talk.pressTalk());
  } else if (speaking || thinking) {
    label = "Stop talking";
    onClick = () => talk.interrupt();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={label}
      aria-pressed={s.turnMode === "tap" ? s.talking : undefined}
      className={cn(
        "promptly-voice-orb relative flex h-28 w-28 items-center justify-center rounded-full text-white transition-[transform,opacity] duration-300",
        "disabled:cursor-default",
        onClick && "hover:scale-[1.03]",
        (s.phase === "starting" || s.phase === "reconnecting") && "opacity-70",
        s.phase === "reconnecting" && "ring-4 ring-amber-500/40",
        s.muted && "opacity-60 grayscale",
        s.talking && "scale-105"
      )}
    >
      {listening && (s.turnMode === "hands_free" || s.talking) && (
        <>
          <div ref={haloRef} className="absolute -inset-1.5 rounded-full bg-[var(--accent)]/25" style={{ opacity: 0.15 }} />
          <span className="promptly-orb-breathe" />
        </>
      )}
      {thinking && <span className="promptly-orb-shimmer" />}
      {speaking && (
        <>
          <span className="promptly-orb-ring" />
          <span className="promptly-orb-ring promptly-orb-ring--late" />
        </>
      )}
      {s.muted ? (
        <MicOff className="relative h-10 w-10" />
      ) : speaking ? (
        <VoiceWaveform mode="ambient" bars={5} className="relative h-10 w-14 gap-1" barClassName="w-[5px] rounded-full bg-white" />
      ) : thinking && s.tool ? (
        <Wrench className="relative h-9 w-9" />
      ) : (
        <AudioLines className="relative h-10 w-10" />
      )}
    </button>
  );
}

/** The microphone level, so you can see it hears you. */
function MicMeter({ active }: { active: boolean }) {
  return (
    <div aria-hidden className="h-6">
      <VoiceWaveform
        mode={active ? "live" : "idle"}
        levelRef={talkLevel}
        bars={18}
        className="h-6 w-36"
        barClassName="w-[3px] rounded-full bg-[var(--accent)] opacity-80"
      />
    </div>
  );
}

// ------------------------------------------------------------------ yes / no
function AskCard({ ask }: { ask: NonNullable<TalkUi["ask"]> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, ask.expiresAt - now);
  const frac = Math.min(1, left / (ask.ttlMs + 3000));
  const yesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    yesRef.current?.focus();
  }, [ask.approvalId]);
  return (
    <div className="mx-4 mb-3 rounded-card border border-[var(--accent)]/40 bg-[var(--surface)] p-3" role="group" aria-label="Waiting for a yes">
      <p className="text-sm font-medium text-[var(--text)]">{ask.question}</p>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--hover)]" aria-hidden>
        <div className="h-full bg-[var(--accent)]/60 transition-[width] duration-200" style={{ width: `${frac * 100}%` }} />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          ref={yesRef}
          type="button"
          onClick={() => talk.confirm("yes")}
          disabled={left <= 0}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <Check className="h-4 w-4" /> Yes
        </button>
        <button
          type="button"
          onClick={() => talk.confirm("no")}
          disabled={left <= 0}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50"
        >
          <X className="h-4 w-4" /> No
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cards
function showInChat(messageId: string | null): void {
  if (!messageId) return;
  const el = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function Cards({ cards }: { cards: TalkCard[] }) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-3" aria-label="Results">
      {cards.map((c) => {
        const m = c.meta;
        if (m.map_card) {
          const step = { id: String(c.key), name: c.kind, status: "ok", meta: { map_card: m.map_card } } as unknown as ActivityStep;
          return <MapChips key={c.key} steps={[step]} />;
        }
        const text =
          m.title ||
          m.summary ||
          (m.photos ? `${m.photos.total ?? "Some"} photos` : null) ||
          (typeof m.count === "number" ? `${m.count} found` : null) ||
          c.kind.replace(/_/g, " ");
        return (
          <div
            key={c.key}
            className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)]"
          >
            {m.photos ? (
              <ImageIcon className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
            ) : (
              <Wrench className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
            )}
            <span className="min-w-0 flex-1 truncate">{text}</span>
            {m.url && m.url.startsWith("/") ? (
              <a href={m.url} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-text)] hover:underline">
                Open <ExternalLink className="h-3 w-3" />
              </a>
            ) : c.messageId ? (
              <button
                type="button"
                onClick={() => showInChat(c.messageId)}
                className="text-xs font-medium text-[var(--accent-text)] hover:underline"
              >
                Show in chat
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ bottom bar
function BottomBar({ s, typing, onType, onEnd }: { s: TalkUi; typing: boolean; onType: () => void; onEnd: () => void }) {
  const busy = s.state === "speaking" || s.state === "thinking";
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--border)] px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
      <BarButton
        label={s.muted ? "Unmute" : "Mute"}
        pressed={s.muted}
        onClick={() => (s.muted ? talk.unmute() : talk.mute())}
        disabled={s.phase !== "live"}
      >
        {s.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </BarButton>
      <BarButton label="Stop" onClick={() => talk.interrupt()} disabled={!busy}>
        <Square className="h-3.5 w-3.5 fill-current" />
      </BarButton>
      <BarButton label="Type" fullLabel="Type instead" pressed={typing} onClick={onType} disabled={s.phase !== "live"}>
        <Keyboard className="h-4 w-4" />
      </BarButton>
      <button
        type="button"
        onClick={onEnd}
        className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 text-sm font-semibold text-[var(--danger)] transition hover:opacity-90"
      >
        <PhoneOff className="h-4 w-4" /> End
      </button>
    </div>
  );
}

function BarButton({
  label,
  fullLabel,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  fullLabel?: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={fullLabel}
      title={fullLabel}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition disabled:opacity-50",
        pressed
          ? "border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[var(--accent-text)]"
          : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]"
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function TypeInstead({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const send = () => {
    if (!text.trim()) return;
    talk.sendText(text);
    setText("");
  };
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        aria-label="Type instead"
        placeholder="Type instead…"
        maxLength={4000}
        className="min-w-0 flex-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
      />
      <button
        type="submit"
        disabled={!text.trim()}
        aria-label="Send"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-white disabled:opacity-40"
      >
        <Send className="h-4 w-4" />
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ problems, ending
function Problem({ s, onFallback, onClose }: { s: TalkUi; onFallback: () => void; onClose: () => void }) {
  const p = s.problem!;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8">
      <Callout tone={p.code === "talk_off" || p.code === "busy" ? "warning" : "danger"} className="w-full max-w-sm">
        <p className="font-medium">{p.show}</p>
        {p.mic === "denied" && (
          <p className="mt-1 text-xs">
            To allow it, click the lock or settings icon next to this site's address, set Microphone to Allow, then try
            again. On a phone, check that your browser may use the microphone in the phone's settings too.
          </p>
        )}
        {p.mic === "missing" && <p className="mt-1 text-xs">Plug in a microphone or headset, then try again.</p>}
      </Callout>
      <div className="flex flex-wrap justify-center gap-2">
        {p.fallback && (
          <button
            type="button"
            onClick={onFallback}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Use tap-to-talk voice mode
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Ended({ s, onClose }: { s: TalkUi; onClose: () => void }) {
  const why =
    s.endReason === "idle"
      ? "Talk ended after two minutes of quiet."
      : s.endReason === "dropped"
        ? "The connection dropped, so Talk ended."
        : "Talk ended.";
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="text-sm text-[var(--text-muted)]">{why} Everything said is in the chat.</p>
      <button
        type="button"
        onClick={onClose}
        className="rounded-full border border-[var(--border)] px-4 py-1.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
      >
        Close
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ voices
function VoiceSheet({ onClose }: { onClose: () => void }) {
  const voice = useTalkStore((s) => s.voice) || DEFAULT_VOICE_ID;
  const speed = useTalkStore((s) => s.speed);
  const wasMuted = useRef(useTalkStore.getState().muted);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Samples would be heard as you talking: the mic is muted while you pick.
  useEffect(() => {
    if (!wasMuted.current) talk.mute();
    sheetRef.current?.focus();
    return () => {
      talk.stopSample();
      if (!wasMuted.current) talk.unmute();
    };
  }, []);

  const save = useCallback(
    async (patch: { tts_voice?: string; tts_speed?: number }) => {
      patchSettings(patch);
      try {
        setUser(await authApi.updatePreferences(patch));
      } catch {
        setError("Couldn't save that to your account. It's used for this conversation.");
      }
    },
    [patchSettings, setUser]
  );

  const pick = async (id: string) => {
    setError(null);
    talk.setVoice(id);
    void save({ tts_voice: id });
    setPlaying(id);
    try {
      const name = VOICE_BY_ID[id]?.name ?? "Promptly";
      const blob = await voiceApi.synthesize(`Hi, I'm ${name}. This is how I'll sound when we talk.`, { voice: id, speed });
      await talk.sample(await blob.arrayBuffer());
    } catch {
      setError("Couldn't play a sample just now.");
    } finally {
      setPlaying((p) => (p === id ? null : p));
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-end justify-center bg-black/30 sm:items-center" onClick={onClose}>
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-label="Choose a voice"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="promptly-scroll max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-4 outline-none sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text)]">Voice</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          Pick a voice to hear it. Your microphone is paused while you choose.
        </p>
        <div role="radiogroup" aria-label="Voices" className="space-y-3">
          {VOICE_GROUPS.map((g) => (
            <div key={g.label}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{g.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.voices.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    role="radio"
                    aria-checked={voice === v.id}
                    onClick={() => void pick(v.id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition",
                      voice === v.id
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent-text)]"
                        : "border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]/50"
                    )}
                  >
                    {playing === v.id ? (
                      <AudioLines className="h-3 w-3 animate-pulse" />
                    ) : voice === v.id ? (
                      <Check className="h-3 w-3" />
                    ) : null}
                    {v.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <label className="mt-4 block text-xs font-medium text-[var(--text)]">
          Speaking speed: {speed.toFixed(2).replace(/0$/, "")}×
          <input
            type="range"
            min={0.9}
            max={1.3}
            step={0.05}
            value={speed}
            onChange={(e) => talk.setVoice(null, Number(e.target.value))}
            onPointerUp={() => void save({ tts_speed: useTalkStore.getState().speed })}
            onKeyUp={() => void save({ tts_speed: useTalkStore.getState().speed })}
            className="mt-1 w-full accent-[var(--accent)]"
          />
        </label>
        {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
      </div>
    </div>
  );
}
