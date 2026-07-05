/**
 * Meeting notes from a recording (S-tier 4.4).
 *
 * Drop an audio/video file → a durable backend job chunks it through
 * Whisper, summarises the transcript with the workspace's model, and
 * seeds a structured note. This modal is just the front desk: it uploads,
 * then polls the job and renders honest progress. Closing it doesn't
 * cancel anything — reopening resumes the active job's progress.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AudioLines,
  CheckCircle2,
  FileAudio,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";

import { workspacesApi, type MeetingJob } from "@/api/workspaces";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

const POLL_MS = 2500;
const ACTIVE = new Set(["pending", "transcribing", "summarising"]);

// Mirrors the backend's _ALLOWED_EXTS — video is deliberate (screen
// recordings of calls); the worker extracts the audio track.
const ACCEPT =
  "audio/*,video/mp4,video/webm,video/quicktime,.m4a,.mka,.mkv,.amr,.3gp";

function statusLine(job: MeetingJob): string {
  switch (job.status) {
    case "pending":
      return "Waiting for a worker…";
    case "transcribing":
      return job.progress_total > 0
        ? `Transcribing — part ${Math.min(
            job.progress_done + 1,
            job.progress_total
          )} of ${job.progress_total}`
        : "Reading the recording…";
    case "summarising":
      return "Writing the meeting notes…";
    case "done":
      return "Meeting notes are ready.";
    case "failed":
      return job.error || "Something went wrong.";
  }
}

export function MeetingNotesModal({
  workspaceId,
  open,
  onClose,
  onOpenItem,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Open the seeded note in the workspace (tree item id). */
  onOpenItem: (itemId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<MeetingJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The tree query key used by useWorkspaceTree — invalidated when the
  // note lands so it appears without a manual refresh.
  const invalidateTree = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["workspaces", "tree", workspaceId],
    });
  }, [queryClient, workspaceId]);

  // On open: resume showing an in-flight job (upload may have happened in
  // an earlier visit — the worker doesn't care that the modal closed).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void workspacesApi
      .listMeetingJobs(workspaceId)
      .then((jobs) => {
        if (cancelled) return;
        const current = jobs.find((j) => ACTIVE.has(j.status));
        if (current) setJob(current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  // Poll the active job.
  useEffect(() => {
    if (!open || !job || !ACTIVE.has(job.status)) return;
    const t = setInterval(() => {
      void workspacesApi
        .getMeetingJob(workspaceId, job.id)
        .then((next) => {
          setJob(next);
          if (next.status === "done") invalidateTree();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [open, job, workspaceId, invalidateTree]);

  const reset = useCallback(() => {
    setFile(null);
    setTitle("");
    setJob(null);
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const created = await workspacesApi.createMeetingJob(workspaceId, file, {
        title: title.trim() || undefined,
        language: navigator.language || undefined,
      });
      setJob(created);
      setFile(null);
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })
        .response?.data?.detail;
      setError(detail || "Upload failed — try again.");
    } finally {
      setUploading(false);
    }
  }, [file, title, uploading, workspaceId]);

  const pct = useMemo(() => {
    if (!job) return 0;
    if (job.status === "pending") return 4;
    if (job.status === "transcribing") {
      if (job.progress_total <= 0) return 8;
      // Transcription is ~90% of the wall clock; leave headroom for the
      // summarise stage so the bar never sits at 100% while still working.
      return 8 + Math.round((job.progress_done / job.progress_total) * 77);
    }
    if (job.status === "summarising") return 90;
    return 100;
  }, [job]);

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setError(null);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Meeting notes"
      description="Drop in a recording — Promptly transcribes it and writes structured notes with decisions and action items."
      widthClass="max-w-md"
    >
      <div className="space-y-3">
        {job ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="flex items-center gap-2 text-sm text-[var(--text)]">
              {job.status === "done" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
              ) : job.status === "failed" ? (
                <XCircle className="h-4 w-4 shrink-0 text-[var(--danger)]" />
              ) : (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {job.title || "Meeting recording"}
              </span>
            </div>
            <p
              className={cn(
                "mt-1.5 text-xs",
                job.status === "failed"
                  ? "text-[var(--danger)]"
                  : "text-[var(--text-muted)]"
              )}
            >
              {statusLine(job)}
            </p>
            {ACTIVE.has(job.status) && (
              <>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-[var(--text-muted)]">
                  This runs in the background — you can close this window
                  and you'll get a notification when the note is ready.
                </p>
              </>
            )}
            {job.status === "done" && job.note_item_id && (
              <button
                type="button"
                onClick={() => {
                  const itemId = job.note_item_id!;
                  reset();
                  onClose();
                  onOpenItem(itemId);
                }}
                className="mt-2.5 w-full rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
              >
                Open the note
              </button>
            )}
            {(job.status === "done" || job.status === "failed") && (
              <button
                type="button"
                onClick={reset}
                className="mt-2 w-full rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                Process another recording
              </button>
            )}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition",
                dragOver
                  ? "border-[var(--accent)] bg-[var(--hover)]"
                  : "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--hover)]"
              )}
            >
              {file ? (
                <>
                  <FileAudio className="h-6 w-6 text-[var(--accent)]" />
                  <span className="max-w-full truncate text-sm font-medium text-[var(--text)]">
                    {file.name}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {(file.size / (1024 * 1024)).toFixed(1)} MB — click to
                    swap
                  </span>
                </>
              ) : (
                <>
                  <AudioLines className="h-6 w-6 text-[var(--text-muted)]" />
                  <span className="text-sm font-medium text-[var(--text)]">
                    Drop a recording here
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Audio or video, up to 100 MB — the audio track is what
                    matters
                  </span>
                </>
              )}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <label className="block text-xs font-medium text-[var(--text-muted)]">
              Title (optional — inferred from the discussion if left blank)
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="e.g. Weekly sync — 5 Jul"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            {error && (
              <p className="text-xs text-[var(--danger)]">{error}</p>
            )}
            <button
              type="button"
              disabled={!file || uploading}
              onClick={() => void start()}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading ? "Uploading…" : "Transcribe & summarise"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
