/**
 * The words calls use, in one place (and tested): a call's line in the
 * conversation for each viewer, how a call ended, call lengths.
 */
import type { CallHistoryEntry, CallLineMeta } from "@/api/dmCalls";

import type { CallEndKind } from "./store";

/** 0:42, 12:03, 1:02:09 */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 45 sec, 12 min, 1 h 5 min (as the server's "Call · 12 min"). */
export function lengthWords(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${h} h ${mm} min` : `${h} h`;
}

/** What the call screen says when a call is over. */
export function endedWords(kind: CallEndKind, seconds: number): string {
  switch (kind) {
    case "no-answer":
    case "declined":
      return "No answer";
    case "cancelled":
      return "Call cancelled";
    case "lost":
      return "Call dropped: the connection was lost";
    case "access":
      return "You can't be in this call any more";
    case "failed":
      return "Couldn't connect the call";
    default:
      return seconds > 0 ? `Call ended · ${clock(seconds)}` : "Call ended";
  }
}

export interface CallLineWords {
  text: string;
  /** Red, like a phone's missed calls. */
  missed: boolean;
  /** "Call back" / "Call again", or null. */
  again: string | null;
}

/** A call's line in the conversation, as ``meId`` sees it. Someone who
 *  was called never learns whether a 1:1 call was declined or just not
 *  answered: the caller sees "No answer" either way. */
export function callLineWords(c: CallLineMeta, meId: string, names: Record<string, { username: string } | undefined>, group: boolean): CallLineWords {
  const video = c.media === "video";
  const kind = video ? "video call" : "call";
  const Kind = video ? "Video call" : "Call";
  const mine = c.started_by === meId;
  const starter = c.started_by ? (mine ? "You" : names[c.started_by]?.username ?? "Someone") : "Someone";
  const length = c.seconds > 0 ? lengthWords(c.seconds) : "";
  if (c.outcome === "completed" && c.seconds > 0) {
    if (group) return { text: `${starter} started a ${kind} · ${length}`, missed: false, again: null };
    return { text: `${Kind} · ${length}`, missed: false, again: null };
  }
  if (mine) {
    if (c.outcome === "cancelled") return { text: `You cancelled a ${kind}`, missed: false, again: "Call again" };
    return { text: "No answer", missed: false, again: "Call again" };
  }
  if (c.declined.includes(meId)) return { text: `You declined a ${kind} from ${starter}`, missed: false, again: "Call back" };
  if (c.joined.includes(meId)) return { text: Kind, missed: false, again: null };
  return { text: `${group ? `Missed group ${kind}` : `Missed ${kind}`} from ${starter}`, missed: true, again: "Call back" };
}

export interface HistoryWords {
  /** "Missed video call", "Outgoing call", "Incoming call". */
  text: string;
  /** "12 min", "No answer", "Cancelled", "Declined", or "". */
  detail: string;
  /** Red, like a phone's missed calls. */
  missed: boolean;
}

/** A call in your call history, from your side (the Calls tab). */
export function historyWords(e: Pick<CallHistoryEntry, "media" | "direction" | "outcome" | "duration" | "my_seconds" | "group">): HistoryWords {
  const video = e.media === "video";
  const kind = `${e.group ? "group " : ""}${video ? "video call" : "call"}`;
  const Kind = kind.charAt(0).toUpperCase() + kind.slice(1);
  const seconds = e.duration || e.my_seconds;
  const length = seconds > 0 ? lengthWords(seconds) : "";
  switch (e.outcome) {
    case "missed":
      return { text: `Missed ${kind}`, detail: "", missed: true };
    case "declined":
      return { text: `Declined ${kind}`, detail: "", missed: false };
    case "ringing":
      return { text: e.direction === "outgoing" ? `Calling…` : `Incoming ${kind}`, detail: "Ringing", missed: false };
    case "live":
      return { text: `${Kind} in progress`, detail: "", missed: false };
    case "no_answer":
      return { text: `Outgoing ${kind}`, detail: "No answer", missed: false };
    case "cancelled":
      return { text: `Outgoing ${kind}`, detail: "Cancelled", missed: false };
    default:
      return { text: `${e.direction === "outgoing" ? "Outgoing" : "Incoming"} ${kind}`, detail: length, missed: false };
  }
}
