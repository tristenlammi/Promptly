/**
 * The composer's state (WP-P1.4, build §3.3): the photos picked (from the
 * library or uploading), their order, each one's crop/filter and
 * description, the words, who it goes to, a place, a life event and a link.
 * Kept in ``localStorage`` (best effort) until it's posted or thrown away.
 */
import type { EditOps } from "@/api/photos";
import type { LifeEventType, LinkSnapshot, PollCloses, PorchUser, PostPlace, TagStatus } from "@/api/porch";

/** Someone tagged on a photo, at a point (shares of the photo as posted). */
export interface DraftTag {
  user: PorchUser;
  x: number;
  y: number;
  /** Editing a post: whether they've said yes yet. */
  status?: TagStatus;
}

/** A poll: the question is the post's words. */
export interface PollDraft {
  options: string[];
  closes: PollCloses;
}

/** One photo or video in the post being made. */
export interface Pick {
  /** Stable on this device (React keys, drag and drop). */
  key: string;
  /** The library file; null while it's still uploading. */
  fileId: string | null;
  /** Already in the post (editing a post). */
  mediaId?: string;
  /** Following an upload in the queue. */
  taskId?: string;
  /** A picture of it made on this device while it uploads (not kept in the draft). */
  localUrl?: string;
  /** A tile we already had (the library's), until a fresh link arrives. */
  thumb?: string | null;
  kind: "image" | "video";
  name: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbhash: string | null;
  edit: EditOps | null;
  alt: string;
  /** The poster wrote the description themselves (Photos' caption mustn't replace it). */
  altTouched: boolean;
  /** Upload progress, 0..1. */
  progress?: number;
  error?: string;
  /** People tagged on it (photos only). */
  tags?: DraftTag[];
}

export type Audience = "all" | string[];

export interface LifeDraft {
  type: LifeEventType;
  title: string;
  date: string;
}

export type Step = "pick" | "arrange" | "share";

export interface Draft {
  step: Step;
  picks: Pick[];
  body: string;
  mentions: PorchUser[];
  audience: Audience | null;
  place: PostPlace | null;
  life: LifeDraft | null;
  poll: PollDraft | null;
  link: LinkSnapshot | null;
  /** The link the poster took off (not offered again). */
  linkDismissed: string | null;
  memoryId: string | null;
}

export const EMPTY: Draft = {
  // A new post starts at the words; photos are one tap away ("Add photos").
  step: "share",
  picks: [],
  body: "",
  mentions: [],
  audience: null,
  place: null,
  life: null,
  poll: null,
  link: null,
  linkDismissed: null,
  memoryId: null,
};

const KEY = "porch.composer.draft.v1";

export function hasContent(d: Draft): boolean {
  return d.picks.length > 0 || !!d.body.trim() || !!d.life || !!d.place || !!d.poll;
}

/** Why a poll can't be posted yet, or null. */
export function pollProblem(d: { poll: PollDraft | null; body: string }): string | null {
  if (!d.poll) return null;
  if (!d.body.trim()) return "Write your question in the box above.";
  const filled = d.poll.options.map((o) => o.trim()).filter(Boolean);
  if (filled.length < 2) return "A poll needs at least two options.";
  if (new Set(filled.map((o) => o.toLowerCase())).size !== filled.length) return "Two of the options are the same.";
  return null;
}

/**
 * A point on the upright photo (a face Photos found) to the same point on
 * the photo as this post shows it: turned, flipped, then cropped, as
 * ``photos/edits.apply`` draws it. Null when the crop leaves it out.
 */
export function toEdited(x: number, y: number, ops: EditOps | null): { x: number; y: number } | null {
  let px = x;
  let py = y;
  const r = ops?.rotate ?? 0;
  if (r === 90) [px, py] = [1 - py, px];
  else if (r === 180) [px, py] = [1 - px, 1 - py];
  else if (r === 270) [px, py] = [py, 1 - px];
  if (ops?.flip) px = 1 - px;
  const k = ops?.crop;
  if (k) {
    px = (px - k.x) / k.w;
    py = (py - k.y) / k.h;
  }
  if (px < 0 || px > 1 || py < 0 || py > 1) return null;
  return { x: px, y: py };
}

/** The draft kept on this device (only finished, library photos). */
export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d || !Array.isArray(d.picks)) return null;
    const picks = d.picks.filter((p) => p.fileId).map((p) => ({ ...p, localUrl: undefined, taskId: undefined, progress: undefined, error: undefined }));
    const out = { ...EMPTY, ...d, picks };
    return hasContent(out) ? out : null;
  } catch {
    return null;
  }
}

export function saveDraft(d: Draft): void {
  try {
    if (!hasContent(d)) {
      localStorage.removeItem(KEY);
      return;
    }
    const picks = d.picks.filter((p) => p.fileId).map(({ localUrl: _l, taskId: _t, progress: _p, error: _e, ...rest }) => rest);
    localStorage.setItem(KEY, JSON.stringify({ ...d, picks }));
  } catch {
    /* private mode or full: the draft just isn't kept */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}

export function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}

/** "5 minutes and 1 GB", the admin's video limits in words. */
export function videoLimitWords(seconds: number, mb: number): string {
  const time = seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`;
  const size = mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
  return `Videos can be up to ${time} and ${size} here.`;
}

/** A video file's length on this device (null when the browser can't tell). */
export function videoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    let done = false;
    const end = (n: number | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(n);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => end(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => end(null);
    window.setTimeout(() => end(null), 5000);
    v.src = url;
  });
}

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/;

/** The first web link in some words. */
export function firstLink(text: string): string | null {
  return URL_RE.exec(text)?.[0] ?? null;
}

/** Today, as a day ("2026-11-09") on this device's calendar. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
