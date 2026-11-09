import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic } from "lucide-react";

import { SettingsCard } from "@/components/admin/SettingsCard";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { notesApi } from "./api";

/** Notes: whether voice notes are transcribed, for everyone on this Promptly. */
export function NotesTranscriptionCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notes-transcription"], queryFn: notesApi.transcription });
  const change = useMutation({
    mutationFn: notesApi.setTranscription,
    onSuccess: (next) => qc.setQueryData(["notes-transcription"], next),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  if (!data) return null;
  const local = data.backend === "local";
  return (
    <SettingsCard title="Voice notes in Notes" icon={<Mic className="h-4 w-4" />}>
      {!data.ready ? (
        <p className="text-sm text-[var(--text-muted)]">
          {local
            ? "Speech-to-text isn't set up on this server (no Whisper address), so recordings in notes are kept without their words."
            : "Cloud speech-to-text is selected but has no API key, so recordings in notes are kept without their words."}
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-3 text-[var(--text)]">
            <input type="checkbox" checked={data.on} disabled={change.isPending} onChange={(e) => change.mutate(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
            <span>
              Turn voice notes into words, so people can read and search them
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                {local
                  ? "This server transcribes with its own Whisper, so recordings stay here. It's on unless you turn it off."
                  : "This server's speech-to-text is a cloud service (OpenAI). Turning this on sends everyone's voice-note recordings there. It stays off until you choose otherwise."}
              </span>
            </span>
          </label>
          {!data.on && <p className="text-xs text-[var(--text-muted)]">While it's off, recordings play as usual and their notes say “Transcription is off on this server”. Turning it on later lets people transcribe them.</p>}
        </div>
      )}
    </SettingsCard>
  );
}
