/**
 * A post on its way up. The composer hands it over and goes straight back to
 * the feed; this waits for any uploads, sends the post, and tells the status
 * chip (``PostingChip``) how it's going. One post at a time. If it can't be
 * sent, it's put back as the draft on this device so nothing is lost.
 */
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";

import { porchApi, type PorchUser } from "@/api/porch";
import { toast } from "@/store/toastStore";
import { useUploadStore } from "@/store/uploadStore";
import { apiErrorMessage } from "@/utils/apiError";

import { BOOTSTRAP_KEY, LISTS, putPost } from "./cache";
import { loadDraft, saveDraft, type Draft, type Pick } from "./components/composer/model";

export interface PostingJob {
  state: "sending" | "done" | "failed";
  /** 0..1 while sending. */
  progress: number;
  draft: Draft;
  mentions: PorchUser[];
  postId?: string;
  /** Where it went, for "Posted to Family." */
  where?: string;
  error?: string;
  /** The draft was put back for the composer ("Edit" opens it). */
  kept?: boolean;
}

interface PostingState {
  job: PostingJob | null;
  /** How many status chips are on screen (none: say it with a toast). */
  watchers: number;
}

export const usePostingStore = create<PostingState>(() => ({ job: null, watchers: 0 }));

let qcRef: QueryClient | null = null;
let stopWatching: (() => void) | null = null;
let hideTimer: number | null = null;

const patch = (p: Partial<PostingJob>) =>
  usePostingStore.setState((s) => (s.job ? { job: { ...s.job, ...p } } : s));

/** A post is being sent right now. */
export function postingBusy(): boolean {
  return usePostingStore.getState().job?.state === "sending";
}

/** Hand a finished draft over. False when another post is still going up. */
export function startPosting(draft: Draft, mentions: PorchUser[], qc: QueryClient): boolean {
  if (postingBusy()) return false;
  if (hideTimer) window.clearTimeout(hideTimer);
  qcRef = qc;
  usePostingStore.setState({ job: { state: "sending", progress: 0, draft, mentions } });
  run();
  return true;
}

export function retryPosting(): void {
  const job = usePostingStore.getState().job;
  if (!job || job.state !== "failed") return;
  patch({ state: "sending", progress: 0, error: undefined });
  run();
}

export function dismissPosting(): void {
  if (postingBusy()) return;
  if (hideTimer) window.clearTimeout(hideTimer);
  usePostingStore.setState({ job: null });
}

/** Each pick's upload, read from the upload queue. */
function follow(picks: Pick[]): { picks: Pick[]; waiting: number; progress: number; error: string | null } {
  const tasks = useUploadStore.getState().tasks;
  let waiting = 0;
  let sum = 0;
  let error: string | null = null;
  const next = picks.map((p) => {
    if (p.fileId || p.mediaId) {
      sum += 1;
      return p;
    }
    const t = p.taskId ? tasks.find((x) => x.id === p.taskId) : undefined;
    if (t?.status === "done" && t.result) {
      sum += 1;
      return { ...p, fileId: t.result.id, progress: 1 };
    }
    if (!t || t.status === "error" || t.status === "cancelled") {
      error = t?.status === "cancelled" ? "An upload was stopped." : t?.error || "A photo didn't upload.";
      return p;
    }
    waiting += 1;
    sum += t.size ? t.uploaded / t.size : 0;
    return p;
  });
  return { picks: next, waiting, progress: picks.length ? sum / picks.length : 1, error };
}

function run(): void {
  stopWatching?.();
  stopWatching = null;
  const step = () => {
    const job = usePostingStore.getState().job;
    if (!job || job.state !== "sending") return;
    const f = follow(job.draft.picks);
    if (f.error) {
      stopWatching?.();
      stopWatching = null;
      fail(f.error, { ...job.draft, picks: f.picks.filter((p) => p.fileId) });
      return;
    }
    if (f.waiting > 0) {
      // Uploads are most of the wait; the last bit is the post itself.
      const progress = f.progress * 0.9;
      if (Math.abs(progress - job.progress) > 0.01) patch({ progress });
      return;
    }
    stopWatching?.();
    stopWatching = null;
    // A photo uploaded twice is one library file: keep it once.
    const seen = new Set<string>();
    const picks = f.picks.filter((p) => !p.fileId || (seen.has(p.fileId) ? false : (seen.add(p.fileId), true)));
    const draft = { ...job.draft, picks };
    patch({ draft, progress: Math.max(job.progress, 0.9) });
    void send(draft, job.mentions);
  };
  stopWatching = useUploadStore.subscribe(step);
  step();
}

async function send(d: Draft, mentions: PorchUser[]): Promise<void> {
  const kind = d.life ? "life_event" : d.picks.length ? "photo" : d.poll ? "poll" : "text";
  try {
    const post = await porchApi.createPost({
      kind,
      body: d.body,
      groups: d.audience ?? "all",
      media: d.picks.map((p) => ({
        file_id: p.fileId as string,
        alt_text: p.alt.trim(),
        edit: p.kind === "image" ? p.edit : null,
        // Only people who can see it are asked (the server checks again).
        ...(p.kind === "image" ? { tags: (p.tags ?? []).map((t) => ({ user_id: t.user.id, x: t.x, y: t.y })) } : {}),
      })),
      place: d.place,
      link: d.picks.length ? null : d.link,
      life_event: d.life,
      poll: kind === "poll" && d.poll ? { options: d.poll.options.map((o) => o.trim()).filter(Boolean), closes: d.poll.closes } : null,
      from_memory_id: d.memoryId,
      mentions: mentions.map((m) => m.id),
    });
    const qc = qcRef;
    if (qc) {
      putPost(qc, post.id, post);
      void qc.invalidateQueries({ queryKey: LISTS });
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
    }
    const where = post.groups.map((g) => g.name).join(", ");
    patch({ state: "done", progress: 1, postId: post.id, where });
    if (usePostingStore.getState().watchers === 0) toast.success(where ? `Posted to ${where}.` : "Posted.");
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (usePostingStore.getState().job?.state === "done") usePostingStore.setState({ job: null });
    }, 8000);
  } catch (err) {
    fail(apiErrorMessage(err, "Couldn't post."), d);
  }
}

function fail(error: string, draft: Draft): void {
  // Back as the draft, unless a newer one has been started since.
  let kept = false;
  if (!loadDraft()) {
    saveDraft({ ...draft, step: "share" });
    kept = !!loadDraft();
  }
  patch({ state: "failed", error, draft, kept });
  if (usePostingStore.getState().watchers === 0) {
    toast.error(kept ? "Your Porch post didn't go. It's kept as a draft in Porch." : "Your Porch post didn't go.");
  }
}

// Closing the tab mid-post: keep what there is as the draft.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    const job = usePostingStore.getState().job;
    if (job?.state === "sending" && !loadDraft()) saveDraft({ ...job.draft, step: "share" });
  });
}
