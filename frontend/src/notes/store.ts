/**
 * Notes on this device, and keeping them in step with the server.
 *
 *   known    the last copy the server confirmed, per note (IndexedDB too)
 *   outbox   changes not yet confirmed, in order (IndexedDB too)
 *   notes    what's on screen: each known note with its outbox applied
 *   drafts   a note being written in the composer — nothing is sent until
 *            it's closed with something in it (an empty one just goes)
 *
 * A change shows at once and is queued. One loop sends the queue in order;
 * with no connection it waits and tries again when the connection is back
 * (``online``, focus, the live stream reconnecting, or a timer). A save
 * that someone else overtook comes back as 409 with the latest note, and
 * is merged (``merge.ts``) and sent again. A change the server refuses is
 * dropped with a message, and the note is reloaded.
 */
import axios from "axios";
import { create } from "zustand";

import { tagsApi } from "@/api/tags";
import { apiErrorMessage } from "@/utils/apiError";
import { toast } from "@/store/toastStore";

import { notesApi } from "./api";
import { notesDb } from "./db";
import { mergeFields } from "./merge";
import { applyOp, coalesce, grouped, type Base, type ItemFields, type MeFields, type NoteFields, type Op, type QueuedOp } from "./ops";
import { isEmptyNote, uuid, type DocNode, type Known, type Note, type NoteAttachment, type NoteItem, type NoteKind, type NoteLabel, type NoteUser } from "./types";

export type SyncState = "idle" | "saving" | "offline" | "retrying" | "signed_out";

interface NotesState {
  uid: string | null;
  ready: boolean;
  known: Record<string, Known>;
  outbox: QueuedOp[];
  notes: Record<string, Note>;
  drafts: Record<string, Note>;
  users: Record<string, NoteUser>;
  /** Lists loaded from the server at least once (this session). */
  loaded: { main: boolean; trash: boolean };
  loadError: string | null;
  sync: SyncState;
}

export const useNotes = create<NotesState>(() => ({
  uid: null,
  ready: false,
  known: {},
  outbox: [],
  notes: {},
  drafts: {},
  users: {},
  loaded: { main: false, trash: false },
  loadError: null,
  sync: "idle",
}));

const get = () => useNotes.getState();
const set = (p: Partial<NotesState> | ((s: NotesState) => Partial<NotesState>)) => useNotes.setState(p);

let seq = Date.now();
let flushing = false;
let inFlight: number | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 3000;
const refreshWanted = new Set<string>();

// ------------------------------------------------------------------ helpers

function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!axios.isAxiosError(e)) return false;
  if (!e.response) return true;
  return [502, 503, 504].includes(e.response.status);
}

function status(e: unknown): number {
  return axios.isAxiosError(e) ? e.response?.status ?? 0 : 0;
}

/** What the note on screen is, from what the server said plus the queue. */
function derive(known: Record<string, Known>, outbox: QueuedOp[], ids?: Iterable<string>, prev?: Record<string, Note>): Record<string, Note> {
  const out: Record<string, Note> = ids && prev ? { ...prev } : {};
  const want = ids ? new Set(ids) : new Set([...Object.keys(known), ...outbox.map((q) => q.op.id)]);
  if (want.has("")) {
    // Empty trash touches every note.
    want.delete("");
    for (const id of Object.keys(known)) want.add(id);
  }
  for (const id of want) {
    let n: Note | null = known[id]?.note ?? null;
    for (const q of outbox) if (q.op.id === id || q.op.k === "empty_trash") n = applyOp(n, q.op);
    if (n) out[id] = n;
    else delete out[id];
  }
  return out;
}

function commit(known: Record<string, Known>, outbox: QueuedOp[], ids?: Iterable<string>) {
  const s = get();
  set({ known, outbox, notes: derive(known, outbox, ids ? [...ids] : undefined, ids ? s.notes : undefined) });
}

function persistKnown(ks: Known[]) {
  const uid = get().uid;
  if (uid && ks.length) void notesDb.putKnownMany(uid, ks);
}

function forgetKnown(ids: string[]) {
  const uid = get().uid;
  if (uid && ids.length) void notesDb.deleteKnown(uid, ids);
}

function addUsers(users?: Record<string, NoteUser>) {
  if (users && Object.keys(users).length) set((s) => ({ users: { ...s.users, ...users } }));
}

/** Per-person bits a card carries (they don't move ``change_seq``). */
function withState(full: Note, card: Note): Note {
  return {
    ...full,
    pinned: card.pinned,
    archived: card.archived,
    archived_at: card.archived_at,
    position: card.position,
    seen_seq: card.seen_seq,
    labels: card.labels,
    changed: card.changed,
    has_reminder: card.has_reminder,
    shared: card.shared,
    member_ids: card.member_ids,
  };
}

/** Take a fresh copy from the server (a full note, or cards from a list). */
function learn(incoming: Note[], partial: boolean) {
  const s = get();
  const known = { ...s.known };
  const changed: Known[] = [];
  for (const n of incoming) {
    const cur = known[n.id];
    let next: Known;
    if (!partial) next = { note: n, partial: false };
    else if (cur && !cur.partial && cur.note.change_seq >= n.change_seq) next = { note: withState(cur.note, n), partial: false };
    else if (cur && !cur.partial) {
      // Changed since we had it whole: keep it on screen, reload it.
      next = { note: withState(cur.note, n), partial: false };
      refreshWanted.add(n.id);
    } else next = { note: n, partial: true };
    known[n.id] = next;
    changed.push(next);
  }
  // A whole note from the server already includes every change of ours it
  // accepted: those no longer need to be laid on top.
  const done = partial ? new Set<string>() : new Set(incoming.map((n) => n.id));
  const outbox = done.size ? s.outbox.filter((q) => !(q.landed && done.has(q.op.id))) : s.outbox;
  commit(known, outbox, incoming.map((n) => n.id));
  persistKnown(changed);
  if (refreshWanted.size) scheduleRefresh();
}

function drop(ids: string[]) {
  const s = get();
  const gone = new Set(ids);
  const known = { ...s.known };
  for (const id of ids) delete known[id];
  const dropped = s.outbox.filter((q) => gone.has(q.op.id) && q.seq !== inFlight);
  const outbox = s.outbox.filter((q) => !dropped.includes(q));
  commit(known, outbox, ids);
  forgetKnown(ids);
  const uid = s.uid;
  if (uid && dropped.length) void notesDb.deleteOps(uid, dropped.map((q) => q.seq));
}

// ------------------------------------------------------------------ start

export async function initNotes(uid: string): Promise<void> {
  if (get().uid === uid) return;
  set({ uid, ready: false, known: {}, outbox: [], notes: {}, drafts: {}, loaded: { main: false, trash: false }, sync: "idle" });
  const [ks, ops, drafts] = await Promise.all([
    notesDb.loadKnown(uid),
    notesDb.loadOutbox(uid),
    notesDb.getMeta<Record<string, Note>>(uid, "drafts"),
  ]);
  if (get().uid !== uid) return;
  const known: Record<string, Known> = {};
  for (const k of ks) known[k.note.id] = k;
  const outbox = ops.sort((a, b) => a.seq - b.seq).map((q) => ({ seq: q.seq, op: q.op }));
  seq = Math.max(seq, ...outbox.map((q) => q.seq + 1));
  set({ known, outbox, notes: derive(known, outbox), ready: true });
  // A note left half-written when the page closed is kept (an empty one goes).
  for (const d of Object.values(drafts ?? {})) commitDraftNote(d);
  void notesDb.putMeta(uid, "drafts", {});
  void flush();
  void loadLists();
  if (typeof window !== "undefined") {
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
  }
}

/** Try the queue again now (the connection may be back). */
export function kick(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 3000;
  void flush();
}

async function allPages(view: "home" | "archive" | "trash"): Promise<Note[]> {
  const out: Note[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await notesApi.list(view, { cursor });
    addUsers(page.users);
    out.push(...page.notes);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** Your notes and archive, from the server (all of them: the grid, search
 *  and labels then work with no connection). */
export async function loadLists(): Promise<void> {
  const uid = get().uid;
  if (!uid) return;
  try {
    const [home, archive] = await Promise.all([allPages("home"), allPages("archive")]);
    if (get().uid !== uid) return;
    const fresh = [...home, ...archive];
    learn(fresh, true);
    // Notes we had that the server no longer lists for us (deleted on
    // another device, or no longer shared) go — unless they're new here
    // or in the Trash.
    const seen = new Set(fresh.map((n) => n.id));
    const s = get();
    const pending = new Set(s.outbox.map((q) => q.op.id));
    const stale = Object.values(s.known)
      .filter((k) => !seen.has(k.note.id) && !k.note.trashed_at && !pending.has(k.note.id) && !k.local)
      .map((k) => k.note.id);
    if (stale.length) drop(stale);
    set((st) => ({ loaded: { ...st.loaded, main: true }, loadError: null }));
    void prefetch(uid);
  } catch (e) {
    if (!isOfflineError(e)) set({ loadError: apiErrorMessage(e) });
    else set((st) => ({ sync: st.outbox.length ? "offline" : st.sync }));
  }
}

/** Keep whole copies of your first notes (pinned, then your order) on the
 *  device, so they open and edit with no connection even if they've never
 *  been opened here. A card alone has only the start of a note. */
const PREFETCH = 100;
let prefetching = false;
async function prefetch(uid: string): Promise<void> {
  if (prefetching) return;
  prefetching = true;
  try {
    const want = Object.values(get().notes)
      .filter((n) => !n.trashed_at && !n.archived)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position)
      .slice(0, PREFETCH)
      .filter((n) => get().known[n.id]?.partial)
      .map((n) => n.id);
    for (let i = 0; i < want.length; i += 2) {
      if (get().uid !== uid) return;
      const r = await Promise.all(want.slice(i, i + 2).map((id) => fetchNote(id)));
      if (r.includes("offline")) return;
    }
  } finally {
    prefetching = false;
  }
}

export async function loadTrash(): Promise<void> {
  try {
    const trash = await allPages("trash");
    learn(trash, true);
    const seen = new Set(trash.map((n) => n.id));
    const s = get();
    const pending = new Set(s.outbox.map((q) => q.op.id));
    const stale = Object.values(s.known)
      .filter((k) => k.note.trashed_at && !seen.has(k.note.id) && !pending.has(k.note.id))
      .map((k) => k.note.id);
    if (stale.length) drop(stale);
    set((st) => ({ loaded: { ...st.loaded, trash: true } }));
  } catch (e) {
    if (!isOfflineError(e)) toast.error(apiErrorMessage(e));
  }
}

/** The whole note (opening it): from the server when we can. */
export async function fetchNote(id: string): Promise<"ok" | "gone" | "offline"> {
  if (get().drafts[id]) return "ok";
  const k = get().known[id];
  if (k?.local) return "ok";
  try {
    const n = await notesApi.get(id);
    addUsers(n.users);
    learn([n], false);
    return "ok";
  } catch (e) {
    if (status(e) === 404) {
      drop([id]);
      return "gone";
    }
    return "offline";
  }
}

/** Search on the server (words in long notes, every list item): the ids
 *  that match, in your notes and archive. */
export async function searchServer(q: string): Promise<string[] | null> {
  try {
    const [a, b] = await Promise.all([notesApi.list("home", { q, limit: 200 }), notesApi.list("archive", { q, limit: 200 })]);
    learn([...a.notes, ...b.notes], true);
    return [...a.notes, ...b.notes].map((n) => n.id);
  } catch {
    return null;
  }
}

/** The live stream said a note moved. */
export function onLiveEvent(ev: { type: string; id: string; change_seq?: number }): void {
  if (ev.type === "gone") {
    const k = get().known[ev.id];
    // Your own note going to Trash also comes as "note" — "gone" is final.
    if (k) drop([ev.id]);
    return;
  }
  const k = get().known[ev.id];
  if (k && ev.change_seq !== undefined && k.note.change_seq >= ev.change_seq && !k.partial) {
    // Only your own pin/order/labels moved: those don't change change_seq.
    refreshWanted.add(ev.id);
    scheduleRefresh();
    return;
  }
  refreshWanted.add(ev.id);
  scheduleRefresh();
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const busy = new Set(get().outbox.filter((q) => !q.landed).map((q) => q.op.id));
    const ids = [...refreshWanted].filter((id) => !busy.has(id));
    for (const id of ids) refreshWanted.delete(id);
    for (const id of ids) {
      if (get().known[id]?.local) continue;
      const r = await fetchNote(id);
      if (r === "offline") refreshWanted.add(id);
    }
  }, 250);
}

// ------------------------------------------------------------------ the queue

function enqueue(op: Op): void {
  const s = get();
  if (s.drafts[op.id]) {
    // A draft is only on this device until it's closed.
    const n = applyOp(s.drafts[op.id], op);
    const drafts = { ...s.drafts };
    if (n) drafts[op.id] = n;
    else delete drafts[op.id];
    set({ drafts });
    saveDrafts();
    return;
  }
  let outbox = s.outbox;
  // Fold into the last unsent change to the same note when it's the same
  // kind of change (typing makes many).
  const lastIdx = (() => {
    for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].op.id === op.id || outbox[i].op.k === "empty_trash") return i;
    return -1;
  })();
  const last = lastIdx >= 0 ? outbox[lastIdx] : null;
  const folded = last && !last.landed && last.seq !== inFlight ? coalesce(last.op, op) : null;
  let q: QueuedOp;
  if (folded && last) {
    q = { seq: last.seq, op: folded };
    outbox = outbox.map((x, i) => (i === lastIdx ? q : x));
  } else {
    q = { seq: ++seq, op };
    outbox = [...outbox, q];
  }
  commit(s.known, outbox, [op.id]);
  if (s.uid) void notesDb.putOp(s.uid, q);
  void flush();
}

async function send(q: QueuedOp): Promise<void> {
  const op = q.op;
  const known = get().known[op.id];
  switch (op.k) {
    case "create": {
      const n = op.note;
      const created = await notesApi.create({
        client_id: n.id,
        kind: n.kind,
        title: n.title,
        body_doc: n.kind === "text" ? n.body_doc ?? null : undefined,
        items: n.kind === "list" ? grouped(n.items).map((i) => ({ id: i.id, text: i.text, checked: i.checked, indent: !!i.parent_id })) : [],
        color: n.color,
        tag_ids: (await labelIds(n.labels)) ?? [],
        pinned: n.pinned,
        archived: n.archived,
        source: n.source || "web",
      });
      addUsers(created.users);
      landed(q, created);
      return;
    }
    case "patch": {
      let fields: NoteFields = op.fields;
      for (let attempt = 0; attempt < 4; attempt++) {
        const server = get().known[op.id];
        if (!server) throw new Error("gone");
        if (!server.partial) fields = mergeFields(op.base, server.note, op.fields, whoEdited(server.note));
        if (!Object.keys(fields).length) return landed(q);
        try {
          const n = await notesApi.patch(op.id, { base_revision: server.note.revision, ...fields });
          addUsers(n.users);
          landed(q, n);
          return;
        } catch (e) {
          const detail = axios.isAxiosError(e) ? (e.response?.data as { detail?: { note?: Note } })?.detail : undefined;
          if (status(e) === 409 && detail?.note) {
            addUsers(detail.note.users);
            learn([detail.note], false);
            continue;
          }
          throw e;
        }
      }
      throw new Error("Couldn't save this note. Try again.");
    }
    case "item_add":
      await notesApi.addItem(op.id, { id: op.item.id, text: op.item.text, after_id: op.after_id, parent_id: op.item.parent_id, checked: op.item.checked });
      return landed(q);
    case "item_patch":
      try {
        await notesApi.patchItem(op.id, op.iid, op.fields);
      } catch (e) {
        // Someone removed the item meanwhile: nothing left to change.
        if (status(e) !== 404 || !known) throw e;
        refreshWanted.add(op.id);
      }
      return landed(q);
    case "item_delete":
      try {
        await notesApi.deleteItem(op.id, op.iid);
      } catch (e) {
        if (status(e) !== 404 || !known) throw e;
      }
      return landed(q);
    case "items_bulk":
      await notesApi.itemsBulk(op.id, op.action);
      return landed(q);
    case "me":
      await notesApi.me(op.id, op.fields);
      return landed(q);
    case "labels": {
      const ids = await labelIds(op.labels);
      const labels = await notesApi.labels(op.id, ids ?? []);
      // The server's labels have ids (a new one was just made): those
      // replace the ones this op carried.
      learnState(op.id, { labels });
      return removeOp(q);
    }
    case "trash":
      await notesApi.remove(op.id);
      return landed(q);
    case "restore":
      await notesApi.restore(op.id);
      return landed(q);
    case "forever":
      try {
        await notesApi.forever(op.id);
      } catch (e) {
        if (status(e) !== 404) throw e;
      }
      drop([op.id]);
      return removeOp(q);
    case "attach": {
      try {
        const n = await notesApi.attach(op.id, {
          id: op.att.id,
          file_id: op.att.file_id ?? "",
          kind: op.att.kind,
          duration_ms: op.att.duration_ms ?? null,
          peaks: op.att.peaks ?? null,
        });
        addUsers(n.users);
        landed(q, n);
      } catch (e) {
        // The file went (deleted from Drive meanwhile), not the note: drop just this.
        const detail = axios.isAxiosError(e) ? (e.response?.data as { detail?: unknown })?.detail : undefined;
        if (status(e) === 404 && typeof detail === "string" && detail.includes("picture or recording")) {
          removeOp(q);
          toast.error("That picture or recording isn't in your files any more.");
          refreshWanted.add(op.id);
          return;
        }
        throw e;
      }
      return;
    }
    case "detach": {
      const n = await notesApi.detach(op.id, op.aid);
      addUsers(n.users);
      landed(q, n);
      return;
    }
    case "transcribe":
      try {
        const n = await notesApi.transcribe(op.id, op.aid);
        landed(q, n);
      } catch (e) {
        if (status(e) !== 409 && !(status(e) === 404 && known)) throw e;
        removeOp(q);
        if (status(e) === 409) toast.error(apiErrorMessage(e));
        refreshWanted.add(op.id);
      }
      return;
    case "empty_trash": {
      await notesApi.emptyTrash();
      const trashed = Object.values(get().known)
        .filter((k) => k.note.trashed_at)
        .map((k) => k.note.id);
      removeOp(q);
      drop(trashed);
      return;
    }
  }
}

function whoEdited(n: Note): string {
  const u = n.edited_by ? (n.users?.[n.edited_by] ?? get().users[n.edited_by]) : undefined;
  return u?.username ?? "Someone";
}

/** Your #tags for these labels, making any that are new. */
async function labelIds(labels: NoteLabel[]): Promise<string[] | null> {
  if (!labels.length) return [];
  const need = labels.filter((l) => !l.id);
  if (!need.length) return labels.map((l) => l.id);
  const all = await tagsApi.list();
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t.id]));
  const out: string[] = [];
  for (const l of labels) {
    if (l.id) out.push(l.id);
    else out.push(byName.get(l.name.toLowerCase()) ?? (await tagsApi.create(l.name)).id);
  }
  return out;
}

function learnState(id: string, patch: Partial<Note>) {
  const s = get();
  const k = s.known[id];
  if (!k) return;
  const next = { ...k, note: { ...k.note, ...patch } };
  commit({ ...s.known, [id]: next }, s.outbox, [id]);
  persistKnown([next]);
}

function removeOp(q: QueuedOp) {
  const s = get();
  const outbox = s.outbox.filter((x) => x.seq !== q.seq);
  commit(s.known, outbox, [q.op.id]);
  if (s.uid) void notesDb.deleteOps(s.uid, [q.seq]);
}

/** Accepted: keep it on screen until the note is refetched (or take the
 *  whole note the server sent back). */
function landed(q: QueuedOp, note?: Note) {
  const s = get();
  if (s.uid) void notesDb.deleteOps(s.uid, [q.seq]);
  if (note) {
    const outbox = s.outbox.filter((x) => x.seq !== q.seq);
    set({ outbox });
    const k = s.known[note.id];
    if (k?.local) {
      const known = { ...get().known };
      delete known[note.id];
      set({ known });
    }
    learn([note], false);
    return;
  }
  const outbox = s.outbox.map((x) => (x.seq === q.seq ? { ...x, landed: Date.now() } : x));
  set({ outbox });
  refreshWanted.add(q.op.id);
}

export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const q = get().outbox.find((x) => !x.landed);
      if (!q) {
        set({ sync: "idle" });
        break;
      }
      // While retrying after a failure, keep saying so until one gets through.
      if (get().sync === "idle") set({ sync: "saving" });
      inFlight = q.seq;
      try {
        await send(q);
        retryDelay = 3000;
        if (get().sync !== "saving") set({ sync: "saving" });
      } catch (e) {
        inFlight = null;
        const code = status(e);
        if (isOfflineError(e) || code === 429 || code >= 500) {
          set({ sync: isOfflineError(e) ? "offline" : "retrying" });
          retry();
          break;
        }
        if (code === 401) {
          set({ sync: "signed_out" });
          retry();
          break;
        }
        // Refused: this change can't be made. Say why, drop it (and what
        // depended on it), and show the note as it really is.
        const msg = apiErrorMessage(e);
        if (code === 404) {
          const wasMine = get().known[q.op.id]?.note.is_owner;
          drop([q.op.id]);
          toast.error(wasMine === false ? "This note isn't shared with you any more." : "That note isn't here any more.");
        } else {
          const later = q.op.k === "create" ? get().outbox.filter((x) => x.op.id === q.op.id) : [q];
          for (const x of later) removeOp(x);
          if (q.op.k === "create") drop([q.op.id]);
          toast.error(`Couldn't save: ${msg}`);
          refreshWanted.add(q.op.id);
        }
      } finally {
        inFlight = null;
      }
    }
  } finally {
    flushing = false;
  }
  scheduleRefresh();
}

function retry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flush();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

// ------------------------------------------------------------------ drafts

function saveDrafts() {
  const s = get();
  if (s.uid) void notesDb.putMeta(s.uid, "drafts", s.drafts);
}

function blankNote(kind: NoteKind, opts: Partial<Note> = {}): Note {
  const t = new Date().toISOString();
  const uid = get().uid ?? "";
  return {
    id: uuid(),
    kind,
    title: "",
    snippet: null,
    body_doc: null,
    body_text: "",
    color: "default",
    list_opts: {},
    items: [],
    items_total: 0,
    items_checked: 0,
    pinned: false,
    archived: false,
    position: -Date.now() / 1000,
    seen_seq: 0,
    labels: [],
    owner_id: uid,
    is_owner: true,
    member_ids: [],
    shared: false,
    attachments: [],
    has_reminder: false,
    changed: false,
    revision: 0,
    change_seq: 0,
    source: "web",
    created_at: t,
    updated_at: t,
    edited_by: uid,
    trashed_at: null,
    doc_file_id: null,
    can: { edit: true, share: true, delete: true, leave: false },
    ...opts,
  };
}

/** Start a note on this device (the composer, the phone's + button). */
export function newDraft(kind: NoteKind, opts: Partial<Note> = {}): string {
  const n = blankNote(kind, opts);
  set((s) => ({ drafts: { ...s.drafts, [n.id]: n } }));
  saveDrafts();
  return n.id;
}

function commitDraftNote(d: Note): boolean {
  if (isEmptyNote(d)) return false;
  const note: Note = { ...d, position: -Date.now() / 1000, updated_at: new Date().toISOString() };
  const s = get();
  const known = { ...s.known, [note.id]: { note, partial: false, local: true } };
  set({ known });
  persistKnown([known[note.id]]);
  enqueue({ k: "create", id: note.id, note });
  return true;
}

/** A draft becomes a real note now, even with nothing typed yet (a picture
 *  or recording is going into it). A note that's already real is left be. */
export function keepDraft(id: string): void {
  const d = get().drafts[id];
  if (!d) return;
  const drafts = { ...get().drafts };
  delete drafts[id];
  set({ drafts });
  saveDrafts();
  const note: Note = { ...d, position: -Date.now() / 1000, updated_at: new Date().toISOString() };
  const known = { ...get().known, [note.id]: { note, partial: false, local: true } };
  set({ known });
  persistKnown([known[note.id]]);
  enqueue({ k: "create", id: note.id, note });
}

/** Close a draft: kept when there's something in it. Returns whether it was kept. */
export function closeDraft(id: string): boolean {
  const d = get().drafts[id];
  if (!d) return false;
  const drafts = { ...get().drafts };
  delete drafts[id];
  set({ drafts });
  saveDrafts();
  return commitDraftNote(d);
}

// ------------------------------------------------------------------ actions

function current(id: string): Note | undefined {
  const s = get();
  return s.drafts[id] ?? s.notes[id];
}

export const notesActions = {
  patch(id: string, fields: NoteFields, bodyBase?: DocNode | null) {
    const n = current(id);
    if (!n) return;
    const base: Base = { title: n.title, body_doc: bodyBase !== undefined ? bodyBase : n.body_doc ?? null, color: n.color };
    enqueue({ k: "patch", id, fields, base });
  },
  addItem(id: string, item: Partial<NoteItem> & { id?: string }, afterId: string | null): string {
    const iid = item.id ?? uuid();
    const n = current(id);
    const position = n ? positionFor(n.items, afterId, item.parent_id ?? null) : undefined;
    enqueue({
      k: "item_add",
      id,
      after_id: afterId,
      item: { id: iid, parent_id: item.parent_id ?? null, text: item.text ?? "", checked: item.checked ?? false, position },
    });
    return iid;
  },
  patchItem(id: string, iid: string, fields: ItemFields) {
    enqueue({ k: "item_patch", id, iid, fields });
  },
  deleteItem(id: string, iid: string) {
    enqueue({ k: "item_delete", id, iid });
  },
  itemsBulk(id: string, action: "untick_all" | "delete_ticked" | "sort") {
    enqueue({ k: "items_bulk", id, action });
  },
  me(id: string, fields: MeFields) {
    enqueue({ k: "me", id, fields });
  },
  setLabels(id: string, labels: NoteLabel[]) {
    enqueue({ k: "labels", id, labels });
  },
  trash(id: string) {
    const n = current(id);
    if (get().drafts[id]) {
      const drafts = { ...get().drafts };
      delete drafts[id];
      set({ drafts });
      saveDrafts();
      return;
    }
    enqueue({ k: "trash", id, owner: n?.is_owner ?? true });
  },
  restore(id: string) {
    enqueue({ k: "restore", id });
  },
  forever(id: string) {
    enqueue({ k: "forever", id });
  },
  emptyTrash() {
    enqueue({ k: "empty_trash", id: "" });
  },
  /** A file already in Drive goes in the note (see ``uploads.ts`` for new ones). */
  attach(id: string, att: NoteAttachment) {
    keepDraft(id);
    enqueue({ k: "attach", id, att });
  },
  detach(id: string, aid: string, kind: "image" | "audio") {
    enqueue({ k: "detach", id, aid, kind });
  },
  transcribe(id: string, aid: string) {
    enqueue({ k: "transcribe", id, aid });
  },
};

/** Where a new item goes: right after ``afterId`` among the list's own order. */
function positionFor(items: NoteItem[], afterId: string | null, _parent: string | null): number {
  const sorted = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!afterId) return (sorted.length ? sorted[sorted.length - 1].position ?? 0 : 0) + 1;
  const i = sorted.findIndex((x) => x.id === afterId);
  if (i < 0) return (sorted.length ? sorted[sorted.length - 1].position ?? 0 : 0) + 1;
  const a = sorted[i].position ?? 0;
  const b = sorted[i + 1]?.position;
  return b === undefined ? a + 1 : (a + b) / 2;
}

/** Wiped on sign-out with the rest of a person's data. */
export function resetNotes(): void {
  set({ uid: null, ready: false, known: {}, outbox: [], notes: {}, drafts: {}, users: {}, loaded: { main: false, trash: false }, sync: "idle" });
}

/** Typing not yet handed to the store (list items wait a moment), per
 *  note: an editor closing runs these first so nothing typed is lost. */
const flushers = new Map<string, Set<() => void>>();
export function addFlusher(noteId: string, fn: () => void): () => void {
  const s = flushers.get(noteId) ?? new Set();
  s.add(fn);
  flushers.set(noteId, s);
  return () => {
    s.delete(fn);
  };
}
export function runFlushers(noteId: string): void {
  for (const fn of [...(flushers.get(noteId) ?? [])]) fn();
}

/** Hooks. */
export const useNote = (id: string | null | undefined) => useNotes((s) => (id ? s.drafts[id] ?? s.notes[id] : undefined));
export const usePendingCount = () => useNotes((s) => s.outbox.filter((q) => !q.landed).length);
