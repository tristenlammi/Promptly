import type { QueryClient } from "@tanstack/react-query";

import { albumsApi } from "@/api/albums";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Upload into an album: the files go through the same upload queue as every
 * other upload (so you see each one's progress, can cancel, and they carry
 * on if you leave the page), land in your Photos folder by date, and join
 * the album once they've all arrived.
 */
export function uploadToAlbum(album: { id: string; title: string }, files: File[], qc: QueryClient): void {
  if (!files.length) return;
  const ids = new Set(useUploadStore.getState().startUploads({ files, scope: "mine", folderId: null, route: "camera" }));
  if (!ids.size) return;

  const settled = new Set(["done", "error", "cancelled"]);
  const arrived = new Map<string, string>(); // upload -> file
  let finished = false;

  const check = () => {
    if (finished) return;
    const mine = useUploadStore.getState().tasks.filter((t) => ids.has(t.id));
    for (const t of mine) if (t.status === "done" && t.result) arrived.set(t.id, t.result.id);
    // One cleared from the list after finishing counts as settled too.
    const waiting = mine.some((t) => !settled.has(t.status));
    if (waiting) return;
    finished = true;
    stop();
    const fileIds = [...arrived.values()];
    if (!fileIds.length) return;
    void albumsApi
      .addItems(album.id, fileIds)
      .then((n) => {
        toast.success(`Added ${n} to “${album.title}”.`);
        void qc.invalidateQueries({ queryKey: ["album", album.id] });
        void qc.invalidateQueries({ queryKey: ["albums"] });
        void qc.invalidateQueries({ queryKey: ["photos"] });
      })
      .catch((e) => toast.error(apiErrorMessage(e, "They uploaded to Photos, but couldn't be added to the album.")));
  };
  const stop = useUploadStore.subscribe(check);
  check();
}
