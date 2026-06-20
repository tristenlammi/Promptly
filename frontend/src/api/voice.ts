import { apiClient } from "./client";

export interface TranscriptionResult {
  text: string;
  language: string | null;
}

export const voiceApi = {
  /** Send a recorded dictation clip to the backend for transcription.
   *  The blob comes straight off ``MediaRecorder`` (usually WebM/Opus);
   *  the backend forwards it to the Whisper worker and returns the text.
   *  ``language`` is an optional BCP-47 hint — pass ``navigator.language``
   *  so the model biases toward the user's locale. */
  async transcribe(
    blob: Blob,
    language?: string | null
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    // Name the part with an extension matching the blob's container so
    // the backend/Whisper picks the right demuxer.
    const ext = blob.type.includes("ogg")
      ? "ogg"
      : blob.type.includes("mp4")
        ? "mp4"
        : blob.type.includes("wav")
          ? "wav"
          : "webm";
    form.append("file", blob, `dictation.${ext}`);
    if (language) form.append("language", language);
    const { data } = await apiClient.post<TranscriptionResult>(
      "/voice/transcribe",
      form,
      {
        headers: { "Content-Type": "multipart/form-data" },
        // Transcription on CPU can take a few seconds for a longer clip —
        // override the client's default 30s ceiling with headroom.
        timeout: 90_000,
      }
    );
    return data;
  },
};
