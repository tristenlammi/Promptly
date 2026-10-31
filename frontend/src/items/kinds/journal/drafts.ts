import { useAuthStore } from "@/store/authStore";

import { normTag } from "./lib";

import type { Entry, JournalData } from "./types";

/*
 * Unsaved writing, kept on this device so nothing typed is lost when the
 * app is closed, the phone kills the tab, or the connection drops.
 *
 * localStorage (synchronous — it survives a kill straight after a
 * keystroke, which an async IndexedDB write might not), one key per entry:
 *
 *   promptly.journal-draft.<userId>.<fileId>.<entryId>
 *
 * A draft is removed once the journal file holds what it says. Drafts are
 * per device and per person: another person's drafts left in this browser
 * are removed the moment someone else opens a journal here.
 */

const PREFIX = "promptly.journal-draft.";

export interface LocalDraft {
  v: 1;
  fileId: string;
  entryId: string;
  /** What's in the editor. */
  draft: Entry;
  grat: string[];
  /** The entry as the file had it when the editor last synced with it
   *  (null: a new entry the file hasn't got yet). */
  base: Entry | null;
  savedAt: string;
}

export function useUserId(): string {
  return useAuthStore((s) => s.user?.id) ?? "anon";
}

const keyOf = (userId: string, fileId: string, entryId: string) => `${PREFIX}${userId}.${fileId}.${entryId}`;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback; // storage blocked / full / private mode
  }
}

export function saveDraft(userId: string, d: Omit<LocalDraft, "v" | "savedAt">): boolean {
  return safe(() => {
    localStorage.setItem(keyOf(userId, d.fileId, d.entryId), JSON.stringify({ ...d, v: 1, savedAt: new Date().toISOString() }));
    return true;
  }, false);
}

export function loadDraft(userId: string, fileId: string, entryId: string): LocalDraft | null {
  return safe(() => {
    const raw = localStorage.getItem(keyOf(userId, fileId, entryId));
    if (!raw) return null;
    const d = JSON.parse(raw) as LocalDraft;
    return d && d.v === 1 && d.draft && typeof d.draft.body === "string" ? d : null;
  }, null);
}

export function clearDraft(userId: string, fileId: string, entryId: string) {
  safe(() => localStorage.removeItem(keyOf(userId, fileId, entryId)), undefined);
}

/** This person's drafts for one journal, newest first; other people's
 *  drafts in this browser are removed. */
export function listDrafts(userId: string, fileId: string): LocalDraft[] {
  return safe(() => {
    const mine = `${PREFIX}${userId}.`;
    const out: LocalDraft[] = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      if (!k.startsWith(mine)) {
        localStorage.removeItem(k);
        continue;
      }
      if (!k.startsWith(`${mine}${fileId}.`)) continue;
      const d = loadDraft(userId, fileId, k.slice(`${mine}${fileId}.`.length));
      if (d) out.push(d);
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }, []);
}

// ------------------------------------------------------------- comparing

/** The fields a person edits (what a commit may change). */
export const FIELDS = [
  "date",
  "time",
  "title",
  "body",
  "mood",
  "emotions",
  "energy",
  "tags",
  "gratitude",
  "location",
  "weather",
  "starred",
  "template_id",
  "prompt",
  "ai_drafted",
  "ai_edited",
] as const satisfies readonly (keyof Entry)[];

export type EntryField = (typeof FIELDS)[number];

const norm = (v: unknown) => JSON.stringify(v ?? null);
const DEFAULTS: Partial<Record<EntryField, unknown>> = { ai_edited: false, ai_drafted: false, starred: false };
const val = (e: Entry | null | undefined, f: EntryField) => e?.[f] ?? DEFAULTS[f] ?? null;

export function sameField(a: Entry | null | undefined, b: Entry | null | undefined, f: EntryField): boolean {
  return norm(val(a, f)) === norm(val(b, f));
}

/** Fields where ``next`` differs from ``base``. */
export function changedFields(next: Entry, base: Entry | null): EntryField[] {
  if (!base) return [...FIELDS];
  return FIELDS.filter((f) => !sameField(next, base, f));
}

const normList = (v: string[] | undefined, fn: (s: string) => string) => norm([...new Set((v ?? []).map(fn).filter(Boolean))]);

/** Does the file's value hold ours? Allows for what the server normalises
 *  (tag/emotion spelling, trimmed gratitude) and for ours kept as a
 *  conflict copy next to text written elsewhere. */
export function fieldHolds(cur: Entry, ours: Entry, f: EntryField): boolean {
  switch (f) {
    case "body":
      return cur.body === ours.body || (!!ours.body && cur.body.includes(CONFLICT_HEADING) && cur.body.includes(ours.body));
    case "tags":
      return normList(cur.tags, normTag) === normList(ours.tags, normTag);
    case "emotions":
      return normList(cur.emotions, (w) => w.trim().toLowerCase()) === normList(ours.emotions, (w) => w.trim().toLowerCase());
    case "gratitude":
      return norm(cur.gratitude.map((g) => g.trim()).filter(Boolean)) === norm(ours.gratitude.map((g) => g.trim()).filter(Boolean));
    default:
      return sameField(cur, ours, f);
  }
}

/** Does the file already hold everything this draft says? */
export function fileHolds(data: JournalData, d: LocalDraft): boolean {
  const cur = data.entries.find((e) => e.id === d.entryId);
  if (!cur) return false;
  const ours: Entry = { ...d.draft, gratitude: d.grat };
  return FIELDS.every((f) => fieldHolds(cur, ours, f));
}

/** Is there anything in a draft worth keeping (beyond a template's
 *  starting text)? Mood-only and tag-only check-ins count. */
export function draftHasContent(e: Entry, grat: string[], templateBody = "", templateTags: string[] = []): boolean {
  return (
    !!e.title.trim() ||
    (!!e.body.trim() && e.body.trim() !== templateBody.trim()) ||
    grat.some((x) => x.trim()) ||
    !!e.mood ||
    !!e.energy ||
    e.emotions.length > 0 ||
    e.tags.some((t) => !templateTags.includes(t)) ||
    !!e.location.trim() ||
    !!e.weather.trim()
  );
}

/** Unsaved drafts for this journal — what the file doesn't hold yet. When
 *  the file is fully saved, drafts it already holds are tidied away. */
export function pendingDrafts(userId: string, fileId: string, data: JournalData, saved: boolean): LocalDraft[] {
  const out: LocalDraft[] = [];
  for (const d of listDrafts(userId, fileId)) {
    if (fileHolds(data, d)) {
      if (saved) clearDraft(userId, fileId, d.entryId);
      continue;
    }
    if (!draftHasContent(d.draft, d.grat) && !d.base) {
      clearDraft(userId, fileId, d.entryId);
      continue;
    }
    out.push(d);
  }
  return out;
}

export const CONFLICT_HEADING = "Conflict copy";

/** Theirs, then ours under a "Conflict copy" heading. */
export function mergeConflict(theirs: string, ours: string, stamp: string): string {
  return `${theirs.trimEnd()}\n\n---\n\n## ${CONFLICT_HEADING} — written on this device, ${stamp}\n\n${ours}`;
}
