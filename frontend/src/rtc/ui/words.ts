/**
 * Plain words for voice: every problem kind, every way a session ends,
 * and the small labels the voice UI repeats. One place, so the panel, the
 * channel view and the toasts all say the same thing.
 */
import type { VoiceQuality } from "@/api/voiceChannels";

import type { VoiceEndKind, VoiceProblem } from "../voice/store";

export interface ProblemWords {
  title: string;
  text: string;
  /** Offer "Try again" (joining). */
  retry: boolean;
  /** Point at the browser's site settings (permission refused). */
  permissionHelp: boolean;
}

/** What went wrong, for a person. ``channel`` is the channel's name when known. */
export function problemWords(p: VoiceProblem, channel?: string | null): ProblemWords {
  const ch = channel || "the channel";
  switch (p.kind) {
    case "mic-denied":
      return {
        title: "Promptly can't use your microphone",
        text: "Your browser blocked it. Allow the microphone for this site, then try again. You can still listen in the meantime.",
        retry: true,
        permissionHelp: true,
      };
    case "mic-missing":
      return { title: "No microphone found", text: "Plug one in, or pick another in Voice & video settings. You can still listen.", retry: false, permissionHelp: false };
    case "mic-failed":
      return {
        title: "Your microphone didn't start",
        text: "Another app may be using it. Close it, or pick another microphone in Voice & video settings.",
        retry: false,
        permissionHelp: false,
      };
    case "full":
      return { title: `${ch} is full`, text: "Try again when someone leaves, or ask an admin to raise the limit.", retry: true, permissionHelp: false };
    case "forbidden":
      return { title: "You can't join this channel", text: p.message || `Only admins can join ${ch}.`, retry: false, permissionHelp: false };
    case "unavailable":
      return { title: "Voice isn't available", text: "The channel is gone, or voice is turned off for you on this server.", retry: false, permissionHelp: false };
    case "connect-failed":
      return {
        title: "Couldn't connect to voice",
        text: "Promptly couldn't reach the calls service. Check your connection and try again.",
        retry: true,
        permissionHelp: false,
      };
    case "camera-denied":
      return { title: "Promptly can't use your camera", text: "Your browser blocked it. Allow the camera for this site, then try again.", retry: false, permissionHelp: true };
    case "camera-failed":
      return { title: "Your camera didn't start", text: "Another app may be using it, or there's no camera. Pick another in Voice & video settings.", retry: false, permissionHelp: false };
    case "screen-failed":
      return { title: "Couldn't go live", text: "Your browser couldn't share that. Try again, or pick another screen, window or tab.", retry: false, permissionHelp: false };
  }
}

/** How to allow the microphone or camera, for the browser in use. */
export function permissionSteps(): string {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Click the crossed-out microphone in the address bar, remove the block, and reload.";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari menu → Settings for this website → Microphone: Allow, then reload.";
  if (/Android/.test(ua)) return "Tap the icon left of the address, then Permissions → Microphone → Allow.";
  return "Click the icon left of the address, then set Microphone (and Camera) to Allow, and reload.";
}

/** Why you're out of a channel (the "ended" notice). */
export function endWords(reason: VoiceEndKind, channel: string, by?: string | null): string {
  switch (reason) {
    case "admin":
      return by ? `${by} disconnected you from ${channel}.` : `You were disconnected from ${channel} by an admin.`;
    case "alone":
      return `You left ${channel} because you were on your own for a while.`;
    case "replaced":
      return `You joined voice somewhere else, so you left ${channel} here.`;
    case "left":
      return `You left ${channel} from another window or device.`;
    case "moved":
      return `You were moved out of ${channel}.`;
    case "access":
      return `You can't be in ${channel} any more.`;
    case "voice_off":
      return "Voice was turned off for you on this server.";
    case "deleted":
      return `${channel} was deleted.`;
    case "connection":
      return `Lost connection to ${channel}.`;
    case "lost":
    case "removed":
    default:
      return `You were disconnected from ${channel}.`;
  }
}

export const QUALITY_WORDS: Record<VoiceQuality, { label: string; detail: string }> = {
  standard: { label: "Standard", detail: "32 kbps · lightest on data" },
  good: { label: "Good", detail: "64 kbps · the usual" },
  high: { label: "High", detail: "96 kbps · clearer voices" },
  music: { label: "Music", detail: "128 kbps stereo · for listening together" },
};

/** "Sam", "Sam and Jo", "Sam, Jo and 2 others". */
export function namesList(names: string[], max = 2): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/** Keyboard key code → what's printed on the key. */
export function keyName(code: string): string {
  if (!code) return "None";
  if (code.startsWith("Mouse")) return `Mouse ${Number(code.slice(5)) + 1}`;
  const named: Record<string, string> = {
    Backquote: "`",
    Space: "Space",
    CapsLock: "Caps Lock",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    Tab: "Tab",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/** The keyboard shortcuts voice answers to (shown in tooltips and settings). */
export const SHORTCUTS = {
  mute: "Ctrl+Shift+M",
  deafen: "Ctrl+Shift+D",
} as const;
