import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FileItem } from "@/api/files";
import { formsApi, type FormDefinition, type FormView, type StaleBody } from "@/api/forms";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { merge3, repairTargets, same } from "../model";

/**
 * The form the builder edits, and its autosave.
 *
 * - Every change saves on its own shortly after (one save at a time; a
 *   change made while one is on its way goes in the next).
 * - Saves carry ``data_version``. When someone else (another tab, a
 *   co-editor, a rename in Files) saved first, the server answers 409 with
 *   their version; their changes and ours are merged item by item
 *   (``merge3``) and saved again — nothing is lost on either side.
 * - Unsaved changes are kept on the device until saved, so a closed tab, a
 *   crash or a lost connection brings them back next time (merged with
 *   whatever was saved since).
 * - While nothing is waiting to save, the form is re-read when the window
 *   comes back into focus and every 30 s, so two open tabs stay in step.
 * - Undo steps back through recent changes (typing in one field counts as
 *   one change).
 */
export type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "pending" }
  | { kind: "offline" }
  | { kind: "invalid"; message: string; itemId: string | null }
  | { kind: "error"; message: string }
  | { kind: "gone" };

interface UpdateOptions {
  /** Changes with the same key in a row (typing in one field) are one undo step. */
  coalesce?: string;
}

const DRAFT_PREFIX = "promptly.formDraft.";
const SAVE_DELAY = 700;
const POLL_MS = 30_000;
const HISTORY = 60;

interface Draft {
  base: FormDefinition;
  local: FormDefinition;
  at: number;
}

function readDraft(fileId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + fileId);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function writeDraft(fileId: string, d: Draft | null) {
  try {
    if (d) window.localStorage.setItem(DRAFT_PREFIX + fileId, JSON.stringify(d));
    else window.localStorage.removeItem(DRAFT_PREFIX + fileId);
  } catch {
    // Storage full or blocked: autosave still runs; only the crash copy is lost.
  }
}

export function useFormDoc(
  fileId: string,
  initial: FormView,
  opts: { readOnly: boolean; onFile?: (f: FileItem) => void; onRemote?: (v: FormView) => void }
) {
  const [def, setDef] = useState<FormDefinition>(initial.form.definition);
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>(initial.asset_urls);
  const [canUndo, setCanUndo] = useState(false);

  const local = useRef(initial.form.definition);
  const base = useRef(initial.form.definition);
  const version = useRef(initial.form.data_version);
  const inflight = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const past = useRef<FormDefinition[]>([]);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);

  const setLocal = (next: FormDefinition) => {
    local.current = next;
    setDef(next);
  };
  const persist = () => {
    if (same(local.current, base.current)) writeDraft(fileId, null);
    else writeDraft(fileId, { base: base.current, local: local.current, at: Date.now() });
  };

  const flush = useCallback(async (): Promise<void> => {
    if (optsRef.current.readOnly) return;
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) {
      again.current = true;
      return;
    }
    if (same(local.current, base.current)) {
      writeDraft(fileId, null);
      setStatus({ kind: "saved" });
      return;
    }
    inflight.current = true;
    again.current = false;
    setStatus({ kind: "saving" });
    const sent = local.current;
    try {
      const res = await formsApi.saveDefinition(fileId, sent, version.current);
      version.current = res.data_version;
      base.current = sent;
      setAssetUrls((u) => ({ ...u, ...res.asset_urls }));
      optsRef.current.onFile?.(res.file);
      // A quiz's key changed: the answers already in are marked again.
      if (res.remarking) toast.success(res.remarking === 1 ? "Marks updated for 1 answer" : `Marks updated for ${res.remarking} answers`);
      inflight.current = false;
      persist();
      if (!same(local.current, sent) || again.current) {
        setStatus({ kind: "pending" });
        void flush();
      } else {
        setStatus({ kind: "saved" });
      }
    } catch (err) {
      inflight.current = false;
      const r = axios.isAxiosError(err) ? err.response : undefined;
      const detail = r?.data?.detail;
      if (r?.status === 409 && detail?.code === "stale") {
        const body = detail as StaleBody;
        const { definition: merged, clashes } = merge3(base.current, local.current, body.definition);
        base.current = body.definition;
        version.current = body.data_version;
        setLocal(merged);
        persist();
        toast.info(
          clashes.length
            ? `This form was changed somewhere else too. Their changes are in; for ${clashes.slice(0, 3).join(", ")} yours were kept.`
            : "This form was changed somewhere else too. Their changes are in, and yours are kept.",
          { title: "Merged changes" }
        );
        if (!same(merged, body.definition)) void flush();
        else setStatus({ kind: "saved" });
        return;
      }
      if (r?.status === 422 && detail && typeof detail === "object" && detail.code === "invalid") {
        setStatus({ kind: "invalid", message: String(detail.message), itemId: detail.item_id ?? null });
        return;
      }
      if (r?.status === 404) {
        setStatus({ kind: "gone" });
        return;
      }
      const offline = !r || (typeof navigator !== "undefined" && navigator.onLine === false);
      setStatus(offline ? { kind: "offline" } : { kind: "error", message: apiErrorMessage(err, "The server couldn't save it.") });
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      retryTimer.current = window.setTimeout(() => {
        if (mounted.current) void flush();
      }, 10_000);
    }
  }, [fileId]);

  const schedule = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setStatus((s) => (s.kind === "gone" ? s : { kind: "pending" }));
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
  }, [flush]);

  const update = useCallback(
    (fn: (d: FormDefinition) => FormDefinition, o: UpdateOptions = {}) => {
      if (optsRef.current.readOnly) return;
      const prev = local.current;
      const next = repairTargets(fn(prev));
      if (next === prev || same(next, prev)) return;
      const now = Date.now();
      const coalesced = o.coalesce && lastKey.current?.key === o.coalesce && now - lastKey.current.at < 2500;
      if (!coalesced) {
        past.current.push(prev);
        if (past.current.length > HISTORY) past.current.shift();
        setCanUndo(true);
      }
      lastKey.current = o.coalesce ? { key: o.coalesce, at: now } : null;
      setLocal(next);
      persist();
      schedule();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedule]
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    setCanUndo(past.current.length > 0);
    lastKey.current = null;
    if (!prev) return;
    setLocal(repairTargets(prev));
    persist();
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  const addAssetUrl = useCallback((id: string, url: string) => setAssetUrls((u) => ({ ...u, [id]: url })), []);

  // Changes that never saved last time (closed tab, lost connection): bring them back.
  useEffect(() => {
    if (opts.readOnly) return;
    const d = readDraft(fileId);
    if (!d || same(d.local, d.base)) return;
    const { definition: merged } = merge3(d.base, d.local, initial.form.definition);
    if (same(merged, initial.form.definition)) {
      writeDraft(fileId, null);
      return;
    }
    setLocal(merged);
    persist();
    schedule();
    toast.info("Brought back changes that hadn't been saved yet.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Someone else's newer save (another tab, a co-editor): pick it up while idle.
  const pull = useCallback(async () => {
    if (inflight.current || timer.current || optsRef.current.readOnly) return;
    try {
      const view = await formsApi.get(fileId);
      if (!mounted.current || inflight.current || timer.current) return;
      setAssetUrls((u) => ({ ...u, ...view.asset_urls }));
      optsRef.current.onRemote?.(view);
      if (view.form.data_version <= version.current) return;
      const remote = view.form.definition;
      if (same(local.current, base.current)) {
        base.current = remote;
        version.current = view.form.data_version;
        setLocal(remote);
        return;
      }
      const { definition: merged } = merge3(base.current, local.current, remote);
      base.current = remote;
      version.current = view.form.data_version;
      setLocal(merged);
      persist();
      if (!same(merged, remote)) void flush();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) setStatus({ kind: "gone" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, flush]);

  useEffect(() => {
    mounted.current = true;
    const onFocus = () => {
      if (document.visibilityState === "visible") void pull();
    };
    const onOnline = () => void flush();
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (inflight.current || !same(local.current, base.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", beforeUnload);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", beforeUnload);
      window.clearInterval(poll);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      // Leaving the page with a change waiting: send it now (the device
      // copy covers the case where this doesn't get through).
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void flush();
      }
    };
  }, [pull, flush]);

  return {
    def,
    status,
    assetUrls,
    addAssetUrl,
    update,
    undo,
    canUndo,
    saveNow: flush,
    version: () => version.current,
  };
}

export type FormDoc = ReturnType<typeof useFormDoc>;
