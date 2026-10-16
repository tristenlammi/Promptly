import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";

import { filesShellApi, type DriveAiStatus, type DriveChatMode } from "@/api/filesShell";
import { Modal } from "@/components/shared/Modal";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Ask your Drive — the opt-in (WP-5.1). When it's on, the text of your
 * files is indexed so chat and search can find what's inside them; files
 * shared with you count when their owner has turned it on too. Folders can
 * be left out (from a folder's menu); turning it off removes the index.
 */
export const DRIVE_AI_KEY = ["drive-ai"];

export function useDriveAi() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: DRIVE_AI_KEY,
    queryFn: () => filesShellApi.driveAi(),
    staleTime: 30_000,
    // While indexing, show it moving.
    refetchInterval: (q) => {
      const d = q.state.data as DriveAiStatus | undefined;
      return d?.enabled && d.pending > 0 ? 5_000 : false;
    },
  });
  const save = useMutation({
    mutationKey: DRIVE_AI_KEY,
    // One save at a time, in click order (switch, then a mode, quickly).
    scope: { id: "drive-ai" },
    mutationFn: (body: { enabled: boolean; excluded_folder_ids: string[]; chat_mode?: DriveChatMode }) =>
      filesShellApi.setDriveAi(body),
    // Show the choice straight away; the server's answer (with progress and
    // folder names) replaces it, and a failure puts the old one back.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: DRIVE_AI_KEY });
      const before = qc.getQueryData<DriveAiStatus>(DRIVE_AI_KEY);
      if (before) qc.setQueryData<DriveAiStatus>(DRIVE_AI_KEY, { ...before, ...body });
      return { before };
    },
    // A save with another queued behind it doesn't write its answer — it
    // would undo the newer choice already on screen.
    onSuccess: (data) => {
      if (qc.isMutating({ mutationKey: DRIVE_AI_KEY }) <= 1) qc.setQueryData(DRIVE_AI_KEY, data);
    },
    onError: (e, _body, context) => {
      if (context?.before) qc.setQueryData(DRIVE_AI_KEY, context.before);
      toast.error(apiErrorMessage(e, "Couldn't change AI search."));
    },
  });
  const data = query.data;
  const isExcluded = (folderId: string) => !!data?.excluded_folder_ids.includes(folderId);
  const setExcluded = (folderId: string, excluded: boolean) => {
    if (!data) return;
    const ids = new Set(data.excluded_folder_ids);
    if (excluded) ids.add(folderId);
    else ids.delete(folderId);
    save.mutate(
      { enabled: data.enabled, excluded_folder_ids: [...ids] },
      {
        onSuccess: () =>
          toast.success(excluded ? "Left out of AI search." : "Included in AI search again."),
      }
    );
  };
  return { data, loading: query.isLoading, save, isExcluded, setExcluded };
}

const CHAT_MODES: { value: DriveChatMode; label: string; hint: string }[] = [
  { value: "auto", label: "When it's relevant", hint: "The assistant looks in your files when a question is about them." },
  { value: "always", label: "Every reply", hint: "Each answer checks your files first." },
  { value: "off", label: "Never", hint: "Only Files search uses the index." },
];

export function DriveAiDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, save } = useDriveAi();
  // The mode just picked, shown until the save settles (a controlled radio
  // otherwise snaps back for a beat while the request is made).
  const [pickedMode, setPickedMode] = useState<DriveChatMode | null>(null);
  const chatMode = pickedMode ?? data?.chat_mode;
  const toggle = (enabled: boolean) =>
    save.mutate({ enabled, excluded_folder_ids: data?.excluded_folder_ids ?? [] });
  const busy = save.isPending;
  const done = data ? data.indexed + data.skipped + data.failed : 0;
  return (
    <Modal open={open} onClose={onClose} title="AI search of your files">
      {!data ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-4 text-sm text-[var(--text)]">
          <p className="text-[var(--text-muted)]">
            Lets chat and search find what's <em>inside</em> your documents, sheets, PDFs and Office files — "when does
            the car insurance renew?" — not just their names. Files people share with you are included when they've
            turned this on too.
          </p>
          {!data.embedder ? (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
              An administrator needs to set up an embedding model first (Admin ▸ Models).
            </p>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              Your files' text is sent to <span className="font-medium text-[var(--text)]">{data.embedder}</span> to be
              indexed{/^ollama/i.test(data.embedder) ? " (it runs on this server)" : ""}.
            </p>
          )}
          <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2.5">
            <span className="flex items-center gap-2 font-medium">
              <Sparkles className="h-4 w-4 text-[var(--accent-text)]" /> Search inside my files
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={data.enabled}
              aria-label="Search inside my files"
              disabled={busy || !data.embedder}
              onClick={() => toggle(!data.enabled)}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50",
                data.enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                  data.enabled ? "left-[22px]" : "left-0.5"
                )}
              />
            </button>
          </label>
          {data.enabled && (
            <div className="space-y-1" aria-live="polite">
              <div className="flex justify-between text-xs text-[var(--text-muted)]">
                <span>
                  {data.pending > 0
                    ? `Indexing… ${done.toLocaleString()} of ${data.eligible.toLocaleString()} files`
                    : `${data.indexed.toLocaleString()} file${data.indexed === 1 ? "" : "s"} searchable`}
                </span>
                {data.failed > 0 && <span className="text-[var(--danger)]">{data.failed} couldn't be read</span>}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  className="h-full bg-[var(--accent)] transition-all"
                  style={{ width: `${data.eligible ? Math.round((done / data.eligible) * 100) : 100}%` }}
                />
              </div>
            </div>
          )}
          {data.enabled && (
            <fieldset>
              <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                In chats
              </legend>
              <div role="radiogroup" aria-label="Use my files in chats" className="space-y-1">
                {CHAT_MODES.map((m) => (
                  <label
                    key={m.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5",
                      chatMode === m.value ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]"
                    )}
                  >
                    <input
                      type="radio"
                      name="drive-chat-mode"
                      value={m.value}
                      checked={chatMode === m.value}
                      onChange={() => {
                        setPickedMode(m.value);
                        save.mutate(
                          {
                            enabled: data.enabled,
                            excluded_folder_ids: data.excluded_folder_ids,
                            chat_mode: m.value,
                          },
                          { onSettled: () => setPickedMode((p) => (p === m.value ? null : p)) }
                        );
                      }}
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span>
                      <span className="font-medium">{m.label}</span>
                      <span className="block text-xs text-[var(--text-muted)]">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Left out</div>
            {data.excluded_folders.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                Nothing. Use "Leave out of AI search" on a folder's menu to keep it (and everything in it) out.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.excluded_folders.map((f) => (
                  <li key={f.id} className="flex items-center justify-between rounded-md bg-[var(--hover)] px-2.5 py-1.5">
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      aria-label={`Include ${f.name} again`}
                      title="Include again"
                      disabled={busy}
                      onClick={() =>
                        save.mutate({
                          enabled: data.enabled,
                          excluded_folder_ids: data.excluded_folder_ids.filter((x) => x !== f.id),
                        })
                      }
                      className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
