import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { useState } from "react";

import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { notesApi } from "../api";
import { Sheet } from "./Sheet";

/**
 * Notes settings on the rail: "Find notes by meaning" (N2.1). Shown only
 * when the server's AI search for notes is on, since otherwise there's
 * nothing to choose. With a cloud indexer it names the service your notes
 * would go to, so each person decides for their own notes.
 */
export function NotesSettingsButton() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["notes-my-search"], queryFn: notesApi.mySearch, staleTime: 5 * 60_000, retry: false });
  if (!data?.available) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mr-2 flex h-11 w-[calc(100%-0.5rem)] items-center gap-4 rounded-r-full pl-5 pr-3 text-left text-sm text-[var(--text)] transition-colors hover:bg-[var(--hover)]"
      >
        <Settings className="h-[18px] w-[18px] shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate">Settings</span>
      </button>
      {open && <NotesSettingsSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function NotesSettingsSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notes-my-search"], queryFn: notesApi.mySearch });
  const change = useMutation({
    mutationFn: notesApi.setMySearch,
    onSuccess: (next) => qc.setQueryData(["notes-my-search"], next),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  return (
    <Sheet title="Notes settings" onClose={onClose}>
      {data && (
        <label className="flex items-start gap-3 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            data-autofocus=""
            checked={data.on}
            disabled={change.isPending}
            onChange={(e) => change.mutate(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
          <span>
            Find notes by meaning
            <span className="mt-1 block text-xs text-[var(--text-muted)]">
              Search also shows related notes that don't use the words you typed, so “wifi” finds the note with the router password.
              {data.local
                ? " This happens on your own Promptly server; your notes don't leave it."
                : ` Your notes are sent to ${data.provider || "a cloud service"} to make this work.`}{" "}
              Notes you share follow your choice. Turning it off works straight away.
            </span>
          </span>
        </label>
      )}
    </Sheet>
  );
}
