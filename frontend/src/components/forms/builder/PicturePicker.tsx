import { useQuery } from "@tanstack/react-query";
import { ImageIcon, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { formsApi } from "@/api/forms";
import { photosApi } from "@/api/photos";
import { Sheet } from "@/items/ui/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Add a picture to a form: upload one, or pick one from your Photos. Either
 * way it's stored as the form's own copy (so the form's link never serves
 * your library), and ``onPicked`` gets its id and a link to show it.
 */
export function PicturePicker({
  open,
  onClose,
  fileId,
  onPicked,
  title = "Add a picture",
}: {
  open: boolean;
  onClose: () => void;
  fileId: string;
  onPicked: (asset: { id: string; url: string }) => void;
  title?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["form-photo-pick"],
    queryFn: () => photosApi.timeline({ view: "all", limit: 60 }),
    enabled: open,
    staleTime: 60_000,
  });
  const photos = (data?.items ?? []).filter((p) => p.kind === "image");

  const done = (a: { id: string; url: string }) => {
    onPicked(a);
    onClose();
  };
  const upload = async (f: File) => {
    setBusy("upload");
    try {
      done(await formsApi.uploadAsset(fileId, f));
    } catch (e) {
      toast.error(apiErrorMessage(e, "That picture couldn't be added."));
    } finally {
      setBusy(null);
    }
  };
  const fromPhoto = async (photoId: string) => {
    setBusy(photoId);
    try {
      done(await formsApi.assetFromFile(fileId, photoId));
    } catch (e) {
      toast.error(apiErrorMessage(e, "That picture couldn't be added."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={title} size="lg">
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={!!busy}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
        >
          {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload a picture
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <section aria-label="From your Photos" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">From your Photos</h3>
          {isLoading ? (
            <p className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your photos…
            </p>
          ) : isError ? (
            <p className="py-2 text-sm text-[var(--text-muted)]">Your photos couldn't be loaded. Upload a picture instead.</p>
          ) : photos.length === 0 ? (
            <p className="py-2 text-sm text-[var(--text-muted)]">No photos yet. Upload a picture instead.</p>
          ) : (
            <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
              {photos.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void fromPhoto(p.id)}
                    aria-label={`Use ${p.filename}`}
                    className="relative block aspect-square w-full overflow-hidden rounded-md bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
                  >
                    {p.thumb ? (
                      <img src={p.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-[10px] text-[var(--text-muted)]">
                        <ImageIcon className="h-5 w-5" />
                        <span className="line-clamp-2 break-all">{p.filename}</span>
                      </span>
                    )}
                    {busy === p.id && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <Loader2 className="h-5 w-5 animate-spin text-white" />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  );
}
