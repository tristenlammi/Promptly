/**
 * Notes — the shapes the API sends (``backend/app/notes``), and the colour
 * palette. A note the grid knows only as a card has a preview of its list
 * (``partial``); opening it fetches the whole note.
 */

export type NoteKind = "text" | "list";
export type NoteView = "home" | "archive" | "trash" | "reminders";

export interface NoteItem {
  id: string;
  parent_id: string | null;
  text: string;
  checked: boolean;
  checked_at?: string | null;
  checked_by?: string | null;
  position?: number;
  created_by?: string | null;
  updated_at?: string | null;
}

export interface NoteLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface NoteUser {
  id: string;
  username: string;
  avatar_url?: string | null;
  color?: string | null;
}

export interface AttachmentCounts {
  images: number;
  audio: number;
  audio_ms: number;
}

export type TranscriptState = "pending" | "working" | "done" | "failed" | "off";

export interface AttachmentUrls {
  original: string | null;
  thumb: string | null;
  preview: string | null;
  /** A recording's seekable playback copy, once the server has made it. */
  play: string | null;
}

/** A picture or recording in a note (``backend/app/notes/attachments.py``). */
export interface NoteAttachment {
  id: string;
  kind: "image" | "audio";
  file_id: string | null;
  filename?: string | null;
  mime?: string | null;
  size?: number | null;
  position?: number;
  added_by?: string | null;
  created_at?: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  peaks?: number[] | null;
  transcript?: string | null;
  transcript_state?: TranscriptState | null;
  urls?: AttachmentUrls;
  /** Only on this device: still uploading (or waiting for a connection). */
  local?: { url: string | null; state: "uploading" | "waiting" | "failed"; progress: number; error?: string | null };
}

export type ReminderRepeat = "daily" | "weekly" | "monthly" | "yearly";

/** What you ask for: a day, a time (or all day), maybe a repeat. */
export interface ReminderIn {
  due: string;
  time: string | null;
  repeat: ReminderRepeat | null;
}

/** Your reminder on a note, read live from its task in your Tasks
 *  (``backend/app/notes/reminders.py``). Only open tasks show. */
export interface NoteReminder extends ReminderIn {
  /** The moment it's due (ISO, with your time zone). */
  at: string | null;
  task_file_id: string;
  task_id: string;
  title: string;
  href: string;
  /** Only on this device: not saved yet. */
  local?: boolean;
}

export interface CardCover {
  id: string;
  thumb: string | null;
  width?: number | null;
  height?: number | null;
}

/** Body: a small TipTap document (paragraphs, H1/H2, bold, italic, underline, links). */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  /** Card: the first 1000 characters. Full note: null (see body_text). */
  snippet: string | null;
  body_doc?: DocNode | null;
  body_text?: string;
  color: string;
  list_opts: { hide_checked?: boolean; ticked_open?: boolean };
  items: NoteItem[];
  items_total: number;
  items_checked: number;
  pinned: boolean;
  archived: boolean;
  archived_at?: string | null;
  position: number;
  seen_seq: number;
  labels: NoteLabel[];
  owner_id: string;
  is_owner: boolean;
  member_ids: string[];
  shared: boolean;
  /** Card: counts. Full note: the pictures and recordings. */
  attachments: AttachmentCounts | NoteAttachment[];
  /** Card: the first few pictures' tiles. */
  covers?: CardCover[];
  /** Full note: whether this server transcribes recordings. */
  transcription?: boolean;
  has_reminder: boolean;
  /** Your own reminder (a task in your Tasks), if it's still to come. */
  reminder?: NoteReminder | null;
  /** Someone else changed it since you last opened it. */
  changed: boolean;
  revision: number;
  change_seq: number;
  source: string;
  created_at: string;
  updated_at: string;
  edited_by: string | null;
  trashed_at: string | null;
  doc_file_id: string | null;
  // Full note only.
  members?: { user_id: string; added_by: string | null; added_at: string }[];
  can?: { edit: boolean; share: boolean; delete: boolean; leave: boolean };
  users?: Record<string, NoteUser>;
}

/** What this device knows about a note: the last copy the server confirmed. */
export interface Known {
  note: Note;
  /** Only a card (a preview of the list, a snippet of the text). */
  partial: boolean;
  /** Not on the server yet (made on this device, still in the outbox). */
  local?: boolean;
}

export const NOTE_COLORS = [
  "default",
  "coral",
  "peach",
  "sand",
  "mint",
  "sage",
  "fog",
  "storm",
  "dusk",
  "blossom",
  "clay",
  "chalk",
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const COLOR_NAMES: Record<string, string> = {
  default: "No colour",
  coral: "Coral",
  peach: "Peach",
  sand: "Sand",
  mint: "Mint",
  sage: "Sage",
  fog: "Fog",
  storm: "Storm",
  dusk: "Dusk",
  blossom: "Blossom",
  clay: "Clay",
  chalk: "Chalk",
};

export function attachmentCounts(n: Note): AttachmentCounts {
  const a = n.attachments;
  if (Array.isArray(a)) {
    const list = a as { kind: string; duration_ms?: number | null }[];
    return {
      images: list.filter((x) => x.kind === "image").length,
      audio: list.filter((x) => x.kind === "audio").length,
      audio_ms: list.reduce((s, x) => s + (x.kind === "audio" ? x.duration_ms ?? 0 : 0), 0),
    };
  }
  return (a as AttachmentCounts) ?? { images: 0, audio: 0, audio_ms: 0 };
}

/** A note's plain text (the body, line by line). */
export function docText(doc: DocNode | null | undefined): string {
  if (!doc) return "";
  const inline = (n: DocNode): string => {
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    return (n.content ?? []).map(inline).join("");
  };
  return (doc.content ?? []).map(inline).join("\n").replace(/\n+$/, "");
}

/** A body from plain text: a paragraph per line. */
export function textDoc(text: string): DocNode | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  return {
    type: "doc",
    content: lines.map((ln) => (ln ? { type: "paragraph", attrs: { id: blockId() }, content: [{ type: "text", text: ln }] } : { type: "paragraph", attrs: { id: blockId() } })),
  };
}

/** A random id that works without a secure context (plain-http LAN servers). */
export function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A short stable id for a body block (the server keeps it; merges use it). */
export function blockId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

/** What a note is called where it needs a name. */
export function displayTitle(n: Pick<Note, "title" | "snippet" | "body_text" | "items">): string {
  if (n.title.trim()) return n.title.trim();
  const text = n.body_text ?? n.snippet ?? "";
  const first = text.split("\n").find((l) => l.trim());
  if (first) return first.trim().slice(0, 80);
  const item = n.items.find((i) => i.text.trim());
  return item ? item.text.trim().slice(0, 80) : "Untitled note";
}

export function isEmptyNote(n: Pick<Note, "title" | "kind" | "body_doc" | "items" | "snippet" | "body_text"> & { attachments?: Note["attachments"] }): boolean {
  if (n.title.trim()) return false;
  const c = n.attachments ? attachmentCounts(n as Note) : null;
  if (c && (c.images || c.audio)) return false;
  if (n.kind === "list") return !n.items.some((i) => i.text.trim());
  const text = n.body_doc !== undefined ? docText(n.body_doc) : n.body_text ?? n.snippet ?? "";
  return !text.trim();
}
