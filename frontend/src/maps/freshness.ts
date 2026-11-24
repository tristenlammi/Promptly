/**
 * How fresh a position is, in plain words. Nothing here guesses: a pin that
 * hasn't moved because the phone went quiet says so, instead of sitting in an
 * old place looking current.
 *
 * Ages come from the server (`age_s`, by its clock) where it sends them, so a
 * viewer whose own clock is off still reads the right thing.
 */

export type LiveState = "fresh" | "late" | "stale" | "waiting";

/** Fresh for five minutes, "last seen" up to half an hour, then stale (`maps/timeline.py`). */
export const LIVE_FRESH_S = 5 * 60;
export const LIVE_STALE_S = 30 * 60;

export function liveState(ageSeconds: number | null | undefined): LiveState {
  if (ageSeconds === null || ageSeconds === undefined || Number.isNaN(ageSeconds)) return "waiting";
  if (ageSeconds <= LIVE_FRESH_S) return "fresh";
  return ageSeconds <= LIVE_STALE_S ? "late" : "stale";
}

const time = (at: Date) => at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "2:14 pm" today, "Tuesday 2:14 pm" this week, "3 Nov, 2:14 pm" before that. */
export function whenWords(at: Date, now: Date = new Date()): string {
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return time(at);
  if (days === 1) return `yesterday ${time(at)}`;
  if (days < 7) return `${at.toLocaleDateString([], { weekday: "long" })} ${time(at)}`;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time(at)}`;
}

function minutes(ageSeconds: number): string {
  const mins = Math.max(1, Math.round(ageSeconds / 60));
  return `${mins} min ago`;
}

/** Under someone's name: how current their position is. */
export function seenWords(ageSeconds: number | null | undefined, at: string | null | undefined, now: Date = new Date()): string {
  const state = liveState(ageSeconds);
  if (state === "waiting" || ageSeconds === null || ageSeconds === undefined) return "No location yet";
  if (ageSeconds < 60) return "Updated just now";
  if (state === "fresh") return `Updated ${minutes(ageSeconds)}`;
  if (state === "late") return `Last seen ${minutes(ageSeconds)}`;
  const when = at ? new Date(at) : new Date(now.getTime() - ageSeconds * 1000);
  return `Phone hasn't checked in since ${whenWords(when, now)}`;
}

/** The age to show now, for a position fetched a little while ago. */
export function ageNow(ageSeconds: number | null | undefined, fetchedAt: number, now: number = Date.now()): number | null {
  if (ageSeconds === null || ageSeconds === undefined) return null;
  return ageSeconds + Math.max(0, Math.round((now - fetchedAt) / 1000));
}

/** What a phone says is wrong with it (`PROBLEMS` in `maps/timeline.py`), for the person whose phone it is. */
export function problemWords(problem: string | null | undefined): string | null {
  switch (problem) {
    case "permission":
      return "Promptly on your phone isn't allowed to use its location.";
    case "background":
      return "Your phone only allows location while Promptly is open. It needs \"Allow all the time\".";
    case "location_off":
      return "Location is switched off on your phone.";
    case "blocked":
      return "Android stopped it on your phone and wouldn't let it start again by itself.";
    case "signed_out":
      return "Your phone isn't linked to this server any more.";
    default:
      return null;
  }
}

export interface MySharing {
  sent_at: string | null;
  age_s: number | null;
  state: LiveState;
  phone_seen_at: string | null;
  problem: string | null;
}

/** For the person sharing: is their phone actually sending? `bad`: it isn't, do something. */
export function sharingWords(me: MySharing, now: Date = new Date(), ageSeconds: number | null = me.age_s): { text: string; bad: boolean } {
  const why = problemWords(me.problem);
  const state = liveState(ageSeconds);
  if (state === "waiting" || ageSeconds === null) {
    return { text: `${why ?? "Your phone hasn't picked this up yet."} Open Promptly on your phone to start it.`, bad: true };
  }
  if (state === "fresh") return { text: ageSeconds < 60 ? "Your phone sent where you are just now." : `Your phone last sent where you are ${minutes(ageSeconds)}.`, bad: false };
  const when = me.sent_at ? new Date(me.sent_at) : new Date(now.getTime() - ageSeconds * 1000);
  return {
    text: `Your phone stopped sending your location at ${whenWords(when, now)}. ${why ? `${why} ` : ""}Open Promptly on your phone to start it again.`,
    bad: true,
  };
}

export interface PhoneReport {
  seen_at: string | null;
  points_at: string | null;
  last_point_at: string | null;
  quiet: boolean;
  recording: boolean | null;
  waiting: number | null;
  problem: string | null;
}

/** The timeline panel: recording is on, so is anything arriving? `bad`: no. */
export function recordingWords(phone: PhoneReport | undefined, now: Date = new Date()): { text: string; bad: boolean } | null {
  if (!phone) return null;
  const heard = [phone.seen_at, phone.points_at].filter((t): t is string => !!t).map((t) => new Date(t).getTime());
  const last = heard.length ? new Date(Math.max(...heard)) : null;
  const why = problemWords(phone.problem);
  if (phone.quiet) {
    const since = last ?? (phone.last_point_at ? new Date(phone.last_point_at) : null);
    return {
      text: `${since ? `Your phone hasn't sent anything since ${whenWords(since, now)}.` : "Your phone hasn't sent anything yet."} Open Promptly on your phone to start it again.`,
      bad: true,
    };
  }
  if (phone.recording === false || why) {
    return { text: `${why ?? "Recording isn't running on your phone right now."} Open Promptly on your phone to start it again.`, bad: true };
  }
  if (!last) return null;
  const waiting = phone.waiting && phone.waiting > 0 ? ` ${phone.waiting.toLocaleString()} ${phone.waiting === 1 ? "position is" : "positions are"} waiting on it to send.` : "";
  const mins = Math.round((now.getTime() - last.getTime()) / 60_000);
  return { text: `Your phone last checked in ${mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `at ${whenWords(last, now)}`}.${waiting}`, bad: false };
}
