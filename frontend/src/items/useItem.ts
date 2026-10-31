import axios from "axios";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuthStore } from "@/store/authStore";

import { itemsApi, type ItemDoc } from "./api";
import { applyPatch, diff, type PatchOp } from "./jsonpatch";
import { offlineStore } from "./offlineStore";

/**
 * The live handle on an item file every item view works through.
 *
 * Changes are **mutators** — ``item.update(d => { d.sets.push(set) })`` —
 * applied at once to what's on screen and saved a moment later as a small
 * patch. Saves carry the revision they were made against; if the file
 * changed somewhere else (another device, the AI panel, a chat) the server
 * answers with the newer state and the pending mutators are replayed on top
 * of it, so nobody's change is lost and nothing is overwritten blindly.
 *
 * Mutators can run more than once, so: make ids, times and random values
 * *outside* them, but compute anything **relative to the current state**
 * (``+1``, toggles, "append") *inside* them from the draft — then a replay on
 * someone else's newer state adds to it instead of overwriting it.
 *
 * Offline: unsaved changes are kept on the device (an outbox patch in
 * IndexedDB) and survive the app being closed; the last confirmed state is
 * cached so the item opens with no connection. Saving resumes when the
 * connection comes back.
 */

export type SaveStatus = "saved" | "saving" | "offline" | "error" | "readonly";

export interface ItemHandle<T> {
  fileId: string;
  data: T;
  revision: number;
  canEdit: boolean;
  status: SaveStatus;
  /** False while the server can't be reached (working from the device copy). */
  connected: boolean;
  /** Change the data (``draft`` is a private copy — mutate it freely).
   *  May run more than once: ids / times / randomness outside it,
   *  state-relative changes (increments, toggles) inside it. */
  update: (mutator: (draft: T) => void) => void;
  /** Run one of the kind's server actions as the person (saves first). */
  runAction: <R = unknown>(name: string, args?: Record<string, unknown>) => Promise<{ summary: string; result: R }>;
  /** Undo this session's last own edit — only what it changed, so edits
   *  from other devices or the assistant made since are kept. */
  undo: () => void;
  canUndo: boolean;
  /** Take a newer server state (the AI panel calls this when it's done). */
  accept: (data: T, revision: number) => void;
  /** Re-read from the server now. */
  refresh: () => Promise<void>;
}

const SAVE_DELAY_MS = 450;
const POLL_MS = 8000;
const UNDO_DEPTH = 30;
const OUTBOX_DELAY_MS = 250;
const CACHE_DELAY_MS = 1500;

function clone<T>(v: T): T {
  return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** ``d`` becomes ``next`` in place (mutators edit the draft they're given). */
function replaceInPlace(d: unknown, next: unknown) {
  const o = d as Record<string, unknown>;
  for (const k of Object.keys(o)) delete o[k];
  Object.assign(o, next);
}

export function useItem<T>(doc: ItemDoc<T>): ItemHandle<T> {
  const fileId = doc.file_id;
  const canEdit = doc.access === "edit";
  const userId = useAuthStore((s) => s.user?.id) ?? "anon";
  // What the server has confirmed, and the changes made on top of it.
  const confirmed = useRef<{ data: T; revision: number }>({ data: doc.data, revision: doc.revision });
  const pending = useRef<((d: T) => void)[]>([]);
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  const retry = useRef(0);
  // After a refused save: send one change at a time, so only the bad one is lost.
  const isolate = useRef(false);
  const history = useRef<PatchOp[][]>([]);
  const outboxTimer = useRef<number | null>(null);
  const cacheTimer = useRef<number | null>(null);
  const [view, setViewState] = useState<{ data: T; revision: number }>({ data: doc.data, revision: doc.revision });
  const viewRef = useRef(view);
  const setView = useCallback((v: { data: T; revision: number }) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const [status, setStatusState] = useState<SaveStatus>(canEdit ? "saved" : "readonly");
  const statusRef = useRef(status);
  const setStatus = useCallback((s: SaveStatus) => {
    statusRef.current = s;
    setStatusState(s);
  }, []);
  const alive = useRef(true);
  const [connected, setConnected] = useState(!doc.offline);

  // ---- the device copy: outbox (unsaved changes) + last confirmed state
  const persistOutbox = useCallback(
    (now = false) => {
      if (!canEdit) return;
      const write = () => {
        if (!pending.current.length) {
          void offlineStore.clearOutbox(userId, fileId);
          return;
        }
        const ops = diff(confirmed.current.data, viewRef.current.data);
        if (ops.length) {
          void offlineStore.putOutbox(userId, fileId, {
            base_revision: confirmed.current.revision,
            ops,
            at: new Date().toISOString(),
          });
        }
      };
      if (outboxTimer.current) window.clearTimeout(outboxTimer.current);
      if (now) write();
      else outboxTimer.current = window.setTimeout(write, OUTBOX_DELAY_MS);
    },
    [canEdit, fileId, userId],
  );

  const cacheConfirmed = useCallback(() => {
    if (cacheTimer.current) window.clearTimeout(cacheTimer.current);
    cacheTimer.current = window.setTimeout(() => {
      void offlineStore.putDoc(userId, { ...doc, data: confirmed.current.data, revision: confirmed.current.revision });
    }, CACHE_DELAY_MS);
  }, [doc, userId]);

  const recompute = useCallback(() => {
    let d = confirmed.current.data;
    if (pending.current.length) {
      d = clone(d);
      for (const m of pending.current) {
        try {
          m(d);
        } catch (e) {
          console.warn("item change no longer applies", e);
        }
      }
    }
    setView({ data: d, revision: confirmed.current.revision });
  }, [setView]);

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current || !pending.current.length || !canEdit) return;
    inFlight.current = true;
    setStatus("saving");
    const batch = isolate.current ? pending.current.slice(0, 1) : pending.current.slice();
    const next = clone(confirmed.current.data);
    for (const m of batch) {
      try {
        m(next);
      } catch {
        /* dropped: didn't apply to the newer state */
      }
    }
    try {
      // Send only what changed (a few fields, not a multi-MB file); the
      // whole file only when the change is most of it anyway.
      const ops = diff(confirmed.current.data, next);
      if (!ops.length) {
        // Nothing actually changed — no save needed.
      } else if (ops.length <= 2000 && JSON.stringify(ops).length <= 256_000) {
        try {
          const res = await itemsApi.savePatch(fileId, ops, confirmed.current.revision);
          confirmed.current = { data: res.fix.length ? applyPatch(next, res.fix) : next, revision: res.revision };
        } catch (e) {
          // A server that doesn't take patches (an older version mid-update)
          // answers 422 — send the whole file instead of losing the change.
          if (!(axios.isAxiosError(e) && e.response?.status === 422)) throw e;
          const res = await itemsApi.save<T>(fileId, next, confirmed.current.revision);
          confirmed.current = { data: res.data, revision: res.revision };
        }
      } else {
        const res = await itemsApi.save<T>(fileId, next, confirmed.current.revision);
        confirmed.current = { data: res.data, revision: res.revision };
      }
      pending.current = pending.current.slice(batch.length);
      if (!pending.current.length) isolate.current = false;
      retry.current = 0;
      setConnected(true);
      cacheConfirmed();
      if (alive.current) setStatus(pending.current.length ? "saving" : "saved");
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409 && e.response.data?.data) {
        // Changed elsewhere: take theirs, replay ours on top, save again.
        confirmed.current = { data: e.response.data.data as T, revision: e.response.data.revision };
        retry.current = 0;
      } else if (axios.isAxiosError(e) && e.response && e.response.status < 500 && e.response.status !== 408) {
        if (batch.length > 1) {
          // Find the change the server refuses; keep the rest.
          isolate.current = true;
          retry.current = 0;
        } else {
          pending.current = pending.current.slice(batch.length);
          if (!pending.current.length) isolate.current = false;
          if (alive.current) setStatus("error");
          const detail = e.response.data?.detail;
          const { toast } = await import("@/store/toastStore");
          toast.error(typeof detail === "string" ? `Not saved: ${detail}` : "That change couldn't be saved.");
        }
      } else {
        retry.current += 1;
        if (alive.current) {
          setStatus("offline");
          setConnected(false);
        }
      }
    } finally {
      inFlight.current = false;
      if (alive.current) recompute();
      // Saved everything: clear the device copy at once (a delay could let a
      // closed app replay a change that already landed).
      persistOutbox(!pending.current.length);
    }
    if (pending.current.length && alive.current) {
      const wait = retry.current ? Math.min(30_000, 1000 * 2 ** retry.current) : 0;
      timer.current = window.setTimeout(() => void flush(), wait);
    }
  }, [cacheConfirmed, canEdit, fileId, persistOutbox, recompute, setStatus]);

  const schedule = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  const update = useCallback(
    (mutator: (draft: T) => void) => {
      if (!canEdit) return;
      const before = viewRef.current.data;
      pending.current.push(mutator);
      recompute();
      // Undo = the inverse of just this change (not a snapshot of the file).
      const inverse = diff(viewRef.current.data, before);
      if (inverse.length) history.current = [...history.current.slice(-(UNDO_DEPTH - 1)), inverse];
      setStatus("saving");
      persistOutbox();
      schedule();
    },
    [canEdit, persistOutbox, recompute, schedule, setStatus],
  );

  const undo = useCallback(() => {
    const ops = history.current.pop();
    if (!ops) return;
    pending.current.push((d) => replaceInPlace(d, applyPatch(d, ops)));
    recompute();
    persistOutbox();
    schedule();
  }, [persistOutbox, recompute, schedule]);

  const refresh = useCallback(async () => {
    try {
      const fresh = await itemsApi.get<T>(fileId);
      if (fresh.revision !== confirmed.current.revision) {
        confirmed.current = { data: fresh.data, revision: fresh.revision };
        recompute();
        cacheConfirmed();
      }
    } catch {
      /* offline: keep what's on screen */
    }
  }, [cacheConfirmed, fileId, recompute]);

  const accept = useCallback(
    (data: T, revision: number) => {
      if (revision <= confirmed.current.revision) return;
      confirmed.current = { data, revision };
      recompute();
      cacheConfirmed();
    },
    [cacheConfirmed, recompute],
  );

  const runAction = useCallback(
    async <R,>(name: string, args: Record<string, unknown> = {}) => {
      // Our own pending edits land first, so the action sees them.
      if (timer.current) window.clearTimeout(timer.current);
      while (pending.current.length || inFlight.current) {
        if (!inFlight.current) await flush();
        else await new Promise((r) => setTimeout(r, 60));
        if (statusRef.current === "offline") break;
      }
      const res = await itemsApi.action<T>(fileId, name, args);
      confirmed.current = { data: res.data, revision: res.revision };
      recompute();
      cacheConfirmed();
      return { summary: res.summary, result: res.result as R };
    },
    [cacheConfirmed, fileId, flush, recompute],
  );

  // Unsaved changes from an earlier visit (the app was closed offline):
  // replay them on top of what's here now, and save.
  useEffect(() => {
    if (!canEdit) return;
    let live = true;
    void offlineStore.getOutbox(userId, fileId).then((box) => {
      if (!live || !box?.ops?.length) return;
      const ops = box.ops;
      pending.current.unshift((d) => replaceInPlace(d, applyPatch(d, ops)));
      recompute();
      schedule();
    });
    cacheConfirmed();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, userId]);

  // Newer revisions from elsewhere: poll while visible and idle, and on focus;
  // the connection coming back sends what's waiting.
  useEffect(() => {
    alive.current = true;
    const check = async () => {
      if (document.hidden || pending.current.length || inFlight.current) return;
      try {
        const rev = await itemsApi.revision(fileId);
        if (alive.current) setConnected(true);
        if (rev > confirmed.current.revision) await refresh();
        if (statusRef.current === "offline" && alive.current) setStatus(canEdit ? "saved" : "readonly");
      } catch {
        if (alive.current) setConnected(false);
      }
    };
    const t = window.setInterval(check, POLL_MS);
    const onFocus = () => void check();
    const onOnline = () => {
      retry.current = 0;
      if (pending.current.length) void flush();
      else void check();
    };
    const onHide = () => {
      if (document.hidden) persistOutbox(true);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onFocus);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current.length) {
        persistOutbox(true);
        void flush();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive.current = false;
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onFocus);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", beforeUnload);
      // Leaving the page: keep what's pending on the device, and send it.
      if (pending.current.length) {
        persistOutbox(true);
        void flush();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  return useMemo(
    () => ({
      fileId,
      data: view.data,
      revision: view.revision,
      canEdit,
      status,
      connected,
      update,
      runAction,
      undo,
      canUndo: history.current.length > 0,
      accept,
      refresh,
    }),
    [fileId, view, canEdit, status, connected, update, runAction, undo, accept, refresh],
  );
}
