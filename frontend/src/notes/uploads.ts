/**
 * Pictures and recordings going into notes from this device.
 *
 * A new file shows in its note at once (played or shown from the device)
 * and is uploaded on its own lane, beside the note's outbox: a 20-minute
 * recording on a bad connection never holds up ticking a list. Uploads go
 * through tus in 2 MB pieces (``lib/tusUpload.ts``), so a dropped
 * connection carries on from where it got to; the File itself is kept in
 * IndexedDB until it's in, so closing the tab or losing signal loses
 * nothing — it carries on next time Notes opens. When it's in, an
 * ``attach`` op puts it in the note (``store.ts``), in order after the
 * note's own creation.
 *
 * Without tusd (a bare server) it falls back to one ordinary upload,
 * started again from the beginning if it fails.
 */
import axios from "axios";
import { create } from "zustand";

import { apiClient } from "@/api/client";
import { TusRejected, tusUpload } from "@/lib/tusUpload";

import { notesDb } from "./db";
import { keepDraft, notesActions, useNotes } from "./store";
import { uuid, type NoteAttachment } from "./types";

const CHUNK = 2 * 1024 * 1024;

export interface PendingUpload {
  aid: string;
  noteId: string;
  kind: "image" | "audio";
  file: File;
  duration_ms?: number | null;
  peaks?: number[] | null;
  created_at: string;
  /** Set once the bytes are in (the attach op is next). */
  file_id?: string | null;
  state: "uploading" | "waiting" | "failed";
  progress: number;
  error?: string | null;
}

interface UploadsState {
  uid: string | null;
  items: Record<string, PendingUpload>;
}

export const useUploads = create<UploadsState>(() => ({ uid: null, items: {} }));
const get = () => useUploads.getState();

/** Device copies to show while the server's own links aren't there yet. */
const localUrls = new Map<string, string>();
const controllers = new Map<string, AbortController>();
let running = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 5000;

export function localUrl(aid: string): string | null {
  return localUrls.get(aid) ?? null;
}

function urlFor(u: PendingUpload): string {
  let url = localUrls.get(u.aid);
  if (!url) {
    url = URL.createObjectURL(u.file);
    localUrls.set(u.aid, url);
  }
  return url;
}

function save(u: PendingUpload) {
  useUploads.setState((s) => ({ items: { ...s.items, [u.aid]: u } }));
  const uid = get().uid;
  // The File is stored with it; progress isn't worth a write.
  if (uid) void notesDb.putUpload(uid, u.aid, { ...u, state: u.state === "failed" ? "failed" : "waiting", progress: 0 });
}

function update(aid: string, patch: Partial<PendingUpload>) {
  const cur = get().items[aid];
  if (!cur) return;
  useUploads.setState((s) => ({ items: { ...s.items, [aid]: { ...cur, ...patch } } }));
}

function forget(aid: string) {
  useUploads.setState((s) => {
    const items = { ...s.items };
    delete items[aid];
    return { items };
  });
  const uid = get().uid;
  if (uid) void notesDb.deleteUpload(uid, aid);
}

/** Pick up what was left from last time (called when Notes starts). */
export async function initUploads(uid: string): Promise<void> {
  if (get().uid === uid) return;
  useUploads.setState({ uid, items: {} });
  const rows = await notesDb.loadUploads<PendingUpload>(uid);
  if (get().uid !== uid) return;
  const items: Record<string, PendingUpload> = {};
  for (const r of rows) if (r?.aid && r.file) items[r.aid] = { ...r, state: r.state === "failed" ? "failed" : "waiting", progress: 0 };
  useUploads.setState({ items });
  if (typeof window !== "undefined") window.addEventListener("online", kickUploads);
  void pump();
}

export function resetUploads(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  useUploads.setState({ uid: null, items: {} });
}

/** Add files to a note: they show now, and upload in the background. */
export function addFiles(noteId: string, files: File[], extra: { duration_ms?: number | null; peaks?: number[] | null } = {}): number {
  keepDraft(noteId);
  let n = 0;
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) continue;
    save({
      aid: uuid(),
      noteId,
      kind,
      file,
      duration_ms: kind === "audio" ? extra.duration_ms ?? null : null,
      peaks: kind === "audio" ? extra.peaks ?? null : null,
      created_at: new Date().toISOString(),
      state: "waiting",
      progress: 0,
    });
    n++;
  }
  void pump();
  return n;
}

export function kindOf(file: File): "image" | "audio" | null {
  const t = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  if (t.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/.test(name)) return "image";
  if (t.startsWith("audio/") || /\.(m4a|mp3|wav|ogg|oga|opus|aac|flac|webm)$/.test(name)) return "audio";
  return null;
}

/** Stop and forget an upload (removed from the note before it was in). */
export function cancelUpload(aid: string): void {
  controllers.get(aid)?.abort();
  controllers.delete(aid);
  forget(aid);
}

export function retryUpload(aid: string): void {
  update(aid, { state: "waiting", error: null, progress: 0 });
  void pump();
}

export function kickUploads(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 5000;
  void pump();
}

function later() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pump();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

// ------------------------------------------------------------------ the lane

interface Policy {
  max_bytes: number;
  tus_endpoint?: string | null;
  large_max_bytes?: number;
}
let policy: Policy | null = null;

async function loadPolicy(): Promise<Policy | null> {
  if (policy) return policy;
  try {
    policy = (await apiClient.get<Policy>("/files/upload-policy")).data;
  } catch {
    return null;
  }
  return policy;
}

function offline(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (e instanceof TusRejected) return e.status === 0 || e.status >= 500 || e.status === 429 || e.status === 423;
  if (axios.isAxiosError(e)) return !e.response || e.response.status >= 500 || e.response.status === 429;
  // tus-js-client gave up retrying a network error.
  return !(e instanceof DOMException && e.name === "AbortError");
}

function message(e: unknown): string {
  if (e instanceof TusRejected) return e.message;
  if (axios.isAxiosError(e)) {
    const d = (e.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof d === "string") return d;
  }
  return e instanceof Error ? e.message : "The upload didn't go through.";
}

async function send(u: PendingUpload, signal: AbortSignal): Promise<string> {
  const p = await loadPolicy();
  if (p) {
    const limit = p.tus_endpoint ? p.large_max_bytes ?? p.max_bytes : p.max_bytes;
    if (u.file.size > limit) throw new TusRejected(`That's too big — the limit is ${Math.round(limit / 1024 ** 2)} MB.`, 413, null);
  }
  const onProgress = (sent: number, total: number) => update(u.aid, { progress: total ? sent / total : 0 });
  if (p?.tus_endpoint) {
    return tusUpload({
      file: u.file,
      metadata: { filename: u.file.name, filetype: u.file.type || "application/octet-stream", scope: "mine", route: "note" },
      signal,
      onProgress,
      chunkSize: CHUNK,
    });
  }
  const form = new FormData();
  form.append("file", u.file, u.file.name);
  form.append("scope", "mine");
  form.append("route", "note");
  const { data } = await apiClient.post<{ id: string }>("/files/", form, {
    signal,
    timeout: 0,
    onUploadProgress: (ev) => onProgress(ev.loaded, ev.total ?? u.file.size),
  });
  return data.id;
}

/** Hand a finished upload to its note. */
function attachDone(u: PendingUpload, fileId: string) {
  const att: NoteAttachment = {
    id: u.aid,
    kind: u.kind,
    file_id: fileId,
    filename: u.file.name,
    mime: u.file.type,
    size: u.file.size,
    duration_ms: u.duration_ms ?? null,
    peaks: u.peaks ?? null,
    transcript_state: u.kind === "audio" ? "pending" : null,
    created_at: u.created_at,
  };
  urlFor(u);
  // Only the server's own links from here; the device copy lingers a while
  // for anything still showing it.
  setTimeout(() => {
    const url = localUrls.get(u.aid);
    if (url) URL.revokeObjectURL(url);
    localUrls.delete(u.aid);
  }, 10 * 60_000);
  const notes = useNotes.getState();
  if (notes.notes[u.noteId] || notes.drafts[u.noteId]) notesActions.attach(u.noteId, att);
  forget(u.aid);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (!get().uid) return;
      const next = Object.values(get().items)
        .filter((u) => u.state !== "failed")
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (!next) return;
      // The note was deleted meanwhile (or we never knew it): nothing to put it in.
      const notes = useNotes.getState();
      if (notes.ready && !notes.notes[next.noteId] && !notes.drafts[next.noteId]) {
        forget(next.aid);
        continue;
      }
      if (next.file_id) {
        attachDone(next, next.file_id);
        continue;
      }
      update(next.aid, { state: "uploading", error: null });
      const ctl = new AbortController();
      controllers.set(next.aid, ctl);
      try {
        const fileId = await send(next, ctl.signal);
        controllers.delete(next.aid);
        if (!get().items[next.aid]) continue; // cancelled as it finished
        const done = { ...get().items[next.aid], file_id: fileId };
        save(done);
        retryDelay = 5000;
        attachDone(done, fileId);
      } catch (e) {
        controllers.delete(next.aid);
        if (!get().items[next.aid]) continue; // cancelled
        if (offline(e)) {
          update(next.aid, { state: "waiting" });
          later();
          return;
        }
        update(next.aid, { state: "failed", error: message(e) });
        save({ ...get().items[next.aid] });
      }
    }
  } finally {
    running = false;
  }
}

/** A whole note's pictures and recordings as they should show: the server's,
 *  then this device's still uploading. */
export function useNoteAttachments(note: { id: string; attachments: unknown }): NoteAttachment[] {
  const items = useUploads((s) => s.items);
  const server = Array.isArray(note.attachments) ? (note.attachments as NoteAttachment[]) : [];
  const shown = server.map((a) => (a.urls?.original || a.urls?.thumb || !localUrls.has(a.id) ? a : { ...a, local: undefined, urls: { original: localUrls.get(a.id) ?? null, thumb: a.urls?.thumb ?? null, preview: a.urls?.preview ?? null, play: null } }));
  const ids = new Set(server.map((a) => a.id));
  return [...shown, ...pendingAttachments(items, note.id).filter((a) => !ids.has(a.id))];
}

/** How many pictures and recordings a card should add for uploads still going. */
export function usePendingCounts(noteId: string): { images: NoteAttachment[]; audio: number } {
  const items = useUploads((s) => s.items);
  const mine = Object.values(items).filter((u) => u.noteId === noteId);
  if (!mine.length) return EMPTY;
  return { images: pendingAttachments(items, noteId).filter((a) => a.kind === "image"), audio: mine.filter((u) => u.kind === "audio").length };
}
const EMPTY = { images: [] as NoteAttachment[], audio: 0 };

/** This note's uploads, as attachments to show. */
export function pendingAttachments(items: Record<string, PendingUpload>, noteId: string): NoteAttachment[] {
  return Object.values(items)
    .filter((u) => u.noteId === noteId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((u) => ({
      id: u.aid,
      kind: u.kind,
      file_id: u.file_id ?? null,
      filename: u.file.name,
      mime: u.file.type,
      size: u.file.size,
      duration_ms: u.duration_ms ?? null,
      peaks: u.peaks ?? null,
      transcript_state: null,
      created_at: u.created_at,
      local: { url: urlFor(u), state: u.state, progress: u.progress, error: u.error ?? null },
    }));
}
